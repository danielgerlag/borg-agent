import type { PluginHttp } from "@borg/plugin-sdk";
import {
  MAX_JSONRPC_BYTES,
  asJsonRpcMessage,
  jsonRpcIdOf,
  type JsonRpcMessage,
  type McpTransport,
  McpProtocolError,
  PARSE_ERROR,
} from "./protocol";
import { readSse } from "./sse";

const MCP_PROTOCOL_VERSION = /^\d{4}-\d{2}-\d{2}$/;

export interface StreamableHttpTransportOptions {
  readonly http: PluginHttp;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly signal?: AbortSignal | undefined;
}

export class StreamableHttpTransport implements McpTransport {
  readonly kind = "streamable-http" as const;
  readonly #http: PluginHttp;
  readonly #url: URL;
  readonly #headers: Readonly<Record<string, string>>;
  readonly #handlers = new Set<(message: JsonRpcMessage) => void>();
  readonly #closeHandlers = new Set<() => void>();
  readonly #controller: AbortController;
  readonly #parentSignal: AbortSignal | undefined;
  readonly #onParentAbort: (() => void) | undefined;
  #sessionId: string | undefined;
  #latestProtocolVersion: string | undefined;
  #closed = false;

  constructor(options: StreamableHttpTransportOptions) {
    this.#http = options.http;
    this.#url = new URL(options.url);
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

  get sessionId(): string | undefined {
    return this.#sessionId;
  }

  async send(
    message: JsonRpcMessage,
    options?: {
      readonly signal?: AbortSignal | undefined;
      readonly headers?: Readonly<Record<string, string>> | undefined;
    },
  ): Promise<void> {
    if (this.#closed) {
      throw new McpProtocolError(-32603, "MCP transport is closed");
    }
    this.#rememberProtocolVersion(options?.headers);
    const requestId = "id" in message ? jsonRpcIdOf(message.id) : undefined;
    const headers = new Headers({
      ...this.#headers,
      ...(options?.headers ?? {}),
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
    });
    if (this.#sessionId) {
      headers.set("Mcp-Session-Id", this.#sessionId);
    }
    const signal = options?.signal
      ? AbortSignal.any([options.signal, this.#controller.signal])
      : this.#controller.signal;
    const response = await this.#http.fetch(this.#url, {
      method: "POST",
      headers,
      body: JSON.stringify(message),
      signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new McpProtocolError(-32603, "MCP HTTP request failed");
    }
    try {
      this.#acceptSessionId(response);
    } catch (error) {
      await response.body?.cancel().catch(() => undefined);
      throw error;
    }
    if (response.status === 202) {
      await response.body?.cancel().catch(() => undefined);
      if (requestId !== undefined) {
        throw new McpProtocolError(
          PARSE_ERROR,
          "MCP HTTP 202 is notification-only",
        );
      }
      return;
    }
    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    if (contentType.includes("text/event-stream")) {
      if (!response.body) {
        throw new McpProtocolError(-32603, "MCP HTTP stream is unavailable");
      }
      const terminals: JsonRpcMessage[] = [];
      await readSse(response.body, (event) => {
        if (event.data.length === 0) {
          return;
        }
        const incoming = parseJsonRpc(event.data);
        if (isTerminalResponse(incoming)) {
          terminals.push(incoming);
          return false;
        }
        this.#emit(incoming);
        return undefined;
      });
      this.#deliverTerminals(terminals, requestId);
      return;
    }
    if (!contentType.includes("application/json")) {
      await response.body?.cancel().catch(() => undefined);
      throw new McpProtocolError(PARSE_ERROR, "MCP HTTP content type is invalid");
    }
    const text = await readBoundedText(response, MAX_JSONRPC_BYTES);
    this.#deliverTerminals([parseJsonRpc(text)], requestId);
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
    const sessionId = this.#sessionId;
    this.#sessionId = undefined;
    this.#handlers.clear();
    for (const handler of this.#closeHandlers) {
      handler();
    }
    this.#closeHandlers.clear();
    if (this.#parentSignal && this.#onParentAbort) {
      this.#parentSignal.removeEventListener("abort", this.#onParentAbort);
    }
    this.#controller.abort(new Error("MCP transport is closed"));
    if (sessionId) {
      await deleteSessionIgnoringFailure(
        this.#http,
        this.#url,
        this.#headers,
        sessionId,
        this.#latestProtocolVersion,
      );
    }
  }

  #deliverTerminals(
    terminals: readonly JsonRpcMessage[],
    requestId: ReturnType<typeof jsonRpcIdOf>,
  ): void {
    if (terminals.length > 1) {
      throw new McpProtocolError(PARSE_ERROR, "MCP HTTP returned multiple responses");
    }
    const incoming = terminals[0];
    if (!incoming) {
      if (requestId !== undefined) {
        throw new McpProtocolError(PARSE_ERROR, "MCP HTTP response is missing");
      }
      return;
    }
    if (requestId === undefined && isTerminalResponse(incoming)) {
      throw new McpProtocolError(
        PARSE_ERROR,
        "MCP notification returned a response",
      );
    }
    if (
      requestId !== undefined &&
      (!isTerminalResponse(incoming) || incoming.id !== requestId)
    ) {
      throw new McpProtocolError(PARSE_ERROR, "MCP response id mismatch");
    }
    this.#emit(incoming);
  }

  #rememberProtocolVersion(
    headers: Readonly<Record<string, string>> | undefined,
  ): void {
    if (!headers) {
      return;
    }
    for (const [name, value] of Object.entries(headers)) {
      if (
        name.toLowerCase() === "mcp-protocol-version" &&
        MCP_PROTOCOL_VERSION.test(value)
      ) {
        this.#latestProtocolVersion = value;
      }
    }
  }

  #acceptSessionId(response: Response): void {
    const sessionId = response.headers.get("mcp-session-id");
    if (sessionId === null) {
      return;
    }
    if (
      sessionId.length === 0 ||
      sessionId.length > 1_024 ||
      !/^[\x21-\x7e]+$/.test(sessionId) ||
      (this.#sessionId !== undefined && this.#sessionId !== sessionId)
    ) {
      throw new McpProtocolError(PARSE_ERROR, "MCP session id is invalid");
    }
    this.#sessionId = sessionId;
  }

  #emit(message: JsonRpcMessage): void {
    for (const handler of this.#handlers) {
      handler(message);
    }
  }
}

function parseJsonRpc(text: string): JsonRpcMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new McpProtocolError(PARSE_ERROR, "MCP message is malformed");
  }
  const incoming = asJsonRpcMessage(parsed);
  if (!incoming) {
    throw new McpProtocolError(PARSE_ERROR, "MCP message is malformed");
  }
  return incoming;
}

function isTerminalResponse(
  message: JsonRpcMessage,
): message is
  | Extract<JsonRpcMessage, { readonly result: unknown }>
  | Extract<JsonRpcMessage, { readonly error: unknown }> {
  return "id" in message && ("result" in message || "error" in message);
}

async function readBoundedText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new McpProtocolError(PARSE_ERROR, "MCP message is too large");
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new McpProtocolError(PARSE_ERROR, "MCP message is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new McpProtocolError(PARSE_ERROR, "MCP message is not valid UTF-8");
  }
}

async function deleteSessionIgnoringFailure(
  http: PluginHttp,
  url: URL,
  headers: Readonly<Record<string, string>>,
  sessionId: string,
  protocolVersion: string | undefined,
): Promise<void> {
  try {
    const requestHeaders = new Headers(headers);
    requestHeaders.set("Mcp-Session-Id", sessionId);
    if (protocolVersion !== undefined) {
      requestHeaders.set("MCP-Protocol-Version", protocolVersion);
    }
    const response = await http.fetch(url, {
      method: "DELETE",
      headers: requestHeaders,
      signal: AbortSignal.timeout(2_000),
    });
    await response.body?.cancel().catch(() => undefined);
  } catch {
    return;
  }
}
