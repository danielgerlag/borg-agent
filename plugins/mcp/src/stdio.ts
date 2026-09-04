import type { PluginProcess, PluginProcesses } from "@borg/plugin-sdk";
import {
  MAX_JSONRPC_BYTES,
  asJsonRpcMessage,
  encodeNdjson,
  type JsonRpcMessage,
  type McpTransport,
  McpProtocolError,
  PARSE_ERROR,
} from "./protocol";
import { boundDiagnostic } from "./redact";

export interface StdioTransportOptions {
  readonly process: PluginProcesses;
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly cwd?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly secrets?: readonly string[] | undefined;
  readonly onDiagnostic?: ((message: string) => void) | undefined;
}

export class StdioTransport implements McpTransport {
  readonly kind = "stdio" as const;
  readonly #child: PluginProcess;
  readonly #writer: WritableStreamDefaultWriter<Uint8Array>;
  readonly #handlers = new Set<(message: JsonRpcMessage) => void>();
  readonly #closeHandlers = new Set<() => void>();
  readonly #secrets: readonly string[];
  readonly #onDiagnostic: ((message: string) => void) | undefined;
  #closed = false;

  private constructor(
    child: PluginProcess,
    options: Pick<StdioTransportOptions, "secrets" | "onDiagnostic">,
  ) {
    this.#child = child;
    this.#writer = child.stdin.getWriter();
    this.#secrets = options.secrets ?? [];
    this.#onDiagnostic = options.onDiagnostic;
    void readNdjson(child.stdout, (message) => {
      for (const handler of this.#handlers) {
        handler(message);
      }
    })
      .then(
        () => this.close(),
        () => this.close(),
      )
      .catch(() => undefined);
    void readStderr(
      child.stderr,
      this.#secrets,
      this.#onDiagnostic,
    );
    void this.#child.exit
      .then(() => this.close())
      .catch(() => undefined);
  }

  static async open(options: StdioTransportOptions): Promise<StdioTransport> {
    const child = await options.process.spawn(options.command, options.args, {
      ...(options.env ? { env: options.env } : {}),
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return new StdioTransport(child, options);
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (this.#closed) {
      throw new McpProtocolError(-32603, "MCP transport is closed");
    }
    await this.#writer.write(encodeNdjson(message));
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
    this.#notifyClosed();
    await this.#child.close();
  }

  #notifyClosed(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#handlers.clear();
    for (const handler of this.#closeHandlers) {
      handler();
    }
    this.#closeHandlers.clear();
    this.#writer.releaseLock();
  }
}

async function readNdjson(
  stream: ReadableStream<Uint8Array>,
  onMessage: (message: JsonRpcMessage) => void,
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
        if (bufferBytes > MAX_JSONRPC_BYTES) {
          throw new McpProtocolError(PARSE_ERROR, "MCP message is too large");
        }
        const line = buffer.trim();
        if (line.length > 0) {
          dispatchLine(line, onMessage);
        }
        break;
      }
      bufferBytes += value.byteLength;
      buffer += decoder.decode(value, { stream: true });
      if (bufferBytes > MAX_JSONRPC_BYTES) {
        throw new McpProtocolError(PARSE_ERROR, "MCP message is too large");
      }
      let newline = buffer.indexOf("\n");
      const hasNewline = newline >= 0;
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.length > 0) {
          dispatchLine(line, onMessage);
        }
        newline = buffer.indexOf("\n");
      }
      if (hasNewline) {
        bufferBytes = new TextEncoder().encode(buffer).byteLength;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function dispatchLine(
  line: string,
  onMessage: (message: JsonRpcMessage) => void,
): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new McpProtocolError(PARSE_ERROR, "MCP message is malformed");
  }
  const message = asJsonRpcMessage(parsed);
  if (!message) {
    throw new McpProtocolError(PARSE_ERROR, "MCP message is malformed");
  }
  onMessage(message);
}

async function readStderr(
  stream: ReadableStream<Uint8Array>,
  secrets: readonly string[],
  onDiagnostic: ((message: string) => void) | undefined,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let dropping = false;
  const emit = (): void => {
    if (!dropping && onDiagnostic) {
      const diagnostic = boundDiagnostic(buffer.trim(), secrets);
      if (diagnostic.length > 0) {
        onDiagnostic(diagnostic);
      }
    }
    buffer = "";
    dropping = false;
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        emit();
        break;
      }
      if (!onDiagnostic || !value || value.byteLength === 0) {
        continue;
      }
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!dropping) {
          const diagnostic = boundDiagnostic(line.trim(), secrets);
          if (diagnostic.length > 0) {
            onDiagnostic(diagnostic);
          }
        }
        dropping = false;
        newline = buffer.indexOf("\n");
      }
      if (buffer.length > MAX_JSONRPC_BYTES) {
        buffer = "";
        dropping = true;
      }
    }
  } catch {
    onDiagnostic?.("MCP stderr stream closed unexpectedly");
  } finally {
    reader.releaseLock();
  }
}
