import type { PluginHttp } from "@borg/plugin-sdk";
import {
  MAX_JSONRPC_BYTES,
  asJsonRpcMessage,
  encodeNdjson,
  type JsonRpcMessage,
  type McpTransport,
  McpProtocolError,
  PARSE_ERROR,
} from "./protocol";

export const DEFAULT_SSE_ENDPOINT_TIMEOUT_MS = 10_000;

export interface SseTransportOptions {
  readonly http: PluginHttp;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly endpointTimeoutMs?: number | undefined;
}

export class LegacySseTransport implements McpTransport {
  readonly kind = "sse" as const;
  readonly #http: PluginHttp;
  readonly #origin: string;
  readonly #headers: Readonly<Record<string, string>>;
  readonly #handlers = new Set<(message: JsonRpcMessage) => void>();
  readonly #closeHandlers = new Set<() => void>();
  readonly #controller: AbortController;
  readonly #parentSignal: AbortSignal | undefined;
  readonly #onParentAbort: (() => void) | undefined;
  #endpoint: URL | undefined;
  #closed = false;

  private constructor(options: SseTransportOptions, origin: string) {
    this.#http = options.http;
    this.#origin = origin;
    this.#headers = options.headers ?? {};
    this.#controller = new AbortController();
    this.#parentSignal = options.signal;
    this.#onParentAbort = options.signal
      ? () => this.#controller.abort(options.signal?.reason)
      : undefined;
    if (options.signal) {
      if (options.signal.aborted) {
        this.#controller.abort(options.signal.reason);
      } else if (this.#onParentAbort) {
        options.signal.addEventListener("abort", this.#onParentAbort, {
          once: true,
        });
      }
    }
  }

  static async open(options: SseTransportOptions): Promise<LegacySseTransport> {
    const url = new URL(options.url);
    const transport = new LegacySseTransport(options, url.origin);
    try {
      const response = await options.http.fetch(url, {
        method: "GET",
        headers: {
          ...options.headers,
          Accept: "text/event-stream",
        },
        signal: transport.#controller.signal,
      });
      const contentType = response.headers.get("content-type") ?? "";
      if (!response.ok || !contentType.toLowerCase().includes("text/event-stream")) {
        await response.body?.cancel().catch(() => undefined);
        throw new McpProtocolError(-32603, "MCP SSE handshake failed");
      }
      if (!response.body) {
        throw new McpProtocolError(-32603, "MCP SSE stream is unavailable");
      }
      const timeoutMs = options.endpointTimeoutMs ?? DEFAULT_SSE_ENDPOINT_TIMEOUT_MS;
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          finish(new McpProtocolError(-32603, "MCP SSE endpoint timed out"));
        }, timeoutMs);
        const finish = (error?: unknown): void => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          if (error) {
            reject(error);
            return;
          }
          resolve();
        };
        void readSse(response.body!, (event) => {
          try {
            transport.#onEvent(event);
            if (event.event === "endpoint" && transport.#endpoint) {
              finish();
            }
          } catch (error) {
            finish(error);
            throw error;
          }
        }).then(
          () => {
            if (!transport.#endpoint) {
              finish(new McpProtocolError(-32603, "MCP SSE stream ended"));
            }
            void transport.close();
          },
          (error: unknown) => {
            finish(error);
            void transport.close();
          },
        );
      });
      return transport;
    } catch (error) {
      await transport.close().catch(() => undefined);
      throw error;
    }
  }

  async send(
    message: JsonRpcMessage,
    options?: {
      readonly signal?: AbortSignal;
      readonly headers?: Readonly<Record<string, string>>;
    },
  ): Promise<void> {
    if (this.#closed) {
      throw new McpProtocolError(-32603, "MCP transport is closed");
    }
    const endpoint = this.#endpoint;
    if (!endpoint) {
      throw new McpProtocolError(-32603, "MCP SSE endpoint is not ready");
    }
    const response = await this.#http.fetch(endpoint, {
      method: "POST",
      headers: {
        ...this.#headers,
        ...options?.headers,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: new TextDecoder().decode(encodeNdjson(message)).trim(),
      ...(options?.signal
        ? {
            signal: AbortSignal.any([options.signal, this.#controller.signal]),
          }
        : { signal: this.#controller.signal }),
    });
    if (!response.ok && response.status !== 202) {
      await response.body?.cancel().catch(() => undefined);
      throw new McpProtocolError(-32603, "MCP SSE request failed");
    }
    await response.body?.cancel().catch(() => undefined);
  }

  subscribe(handler: (message: JsonRpcMessage) => void): () => void {
    this.#handlers.add(handler);
    return () => {
      this.#handlers.delete(handler);
    };
  }

  onClose(handler: () => void): () => void {
    this.#closeHandlers.add(handler);
    return () => {
      this.#closeHandlers.delete(handler);
    };
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#handlers.clear();
    for (const handler of this.#closeHandlers) {
      handler();
    }
    this.#closeHandlers.clear();
    if (this.#parentSignal && this.#onParentAbort) {
      this.#parentSignal.removeEventListener("abort", this.#onParentAbort);
    }
    this.#controller.abort(new Error("MCP transport is closed"));
  }

  #onEvent(event: SseEvent): void {
    if (event.event === "endpoint") {
      const endpoint = resolveSameOriginEndpoint(this.#origin, event.data);
      this.#endpoint = endpoint;
      return;
    }
    if (event.data.length === 0) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(event.data);
    } catch {
      throw new McpProtocolError(PARSE_ERROR, "MCP SSE message is malformed");
    }
    const message = asJsonRpcMessage(parsed);
    if (!message) {
      throw new McpProtocolError(PARSE_ERROR, "MCP SSE message is malformed");
    }
    for (const handler of this.#handlers) {
      handler(message);
    }
  }
}

export function resolveSameOriginEndpoint(origin: string, candidate: string): URL {
  let url: URL;
  try {
    url = new URL(candidate, origin);
  } catch {
    throw new McpProtocolError(PARSE_ERROR, "MCP SSE endpoint is invalid");
  }
  if (url.origin !== origin) {
    throw new McpProtocolError(PARSE_ERROR, "MCP SSE endpoint is cross-origin");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new McpProtocolError(PARSE_ERROR, "MCP SSE endpoint is invalid");
  }
  if (url.username !== "" || url.password !== "") {
    throw new McpProtocolError(PARSE_ERROR, "MCP SSE endpoint is invalid");
  }
  return url;
}

interface SseEvent {
  readonly event: string;
  readonly data: string;
}

export async function readSse(
  stream: ReadableStream<Uint8Array>,
  onEvent: (event: SseEvent) => boolean | void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "";
  let bufferBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        buffer = normalizeSseNewlines(buffer, true);
        if (bufferBytes > MAX_JSONRPC_BYTES) {
          throw new McpProtocolError(PARSE_ERROR, "MCP message is too large");
        }
        if (buffer.trim().length > 0) {
          const parsed = parseSseBlock(buffer);
          if (parsed) {
            onEvent(parsed);
          }
        }
        break;
      }
      bufferBytes += value.byteLength;
      buffer += decoder.decode(value, { stream: true });
      buffer = normalizeSseNewlines(buffer, false);
      if (bufferBytes > MAX_JSONRPC_BYTES) {
        throw new McpProtocolError(PARSE_ERROR, "MCP message is too large");
      }
      let stop = false;
      let separator = buffer.indexOf("\n\n");
      const hasSeparator = separator >= 0;
      while (separator >= 0) {
        const block = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        const parsed = parseSseBlock(block);
        if (parsed && onEvent(parsed) === false) {
          stop = true;
        }
        separator = buffer.indexOf("\n\n");
      }
      if (hasSeparator) {
        bufferBytes = new TextEncoder().encode(buffer).byteLength;
      }
      if (stop) {
        await reader.cancel().catch(() => undefined);
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function normalizeSseNewlines(value: string, final: boolean): string {
  const holdsCarriageReturn = !final && value.endsWith("\r");
  const body = holdsCarriageReturn ? value.slice(0, -1) : value;
  return (
    body.replace(/\r\n|\r/g, "\n") +
    (holdsCarriageReturn ? "\r" : "")
  );
}

function parseSseBlock(block: string): SseEvent | undefined {
  let event = "message";
  const data: string[] = [];
  for (const rawLine of block.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.length === 0 || line.startsWith(":")) {
      continue;
    }
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") {
      event = value;
    } else if (field === "data") {
      data.push(value);
    }
  }
  if (data.length === 0 && event === "message") {
    return undefined;
  }
  return { event, data: data.join("\n") };
}
