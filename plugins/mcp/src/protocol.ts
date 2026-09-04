export const MAX_JSONRPC_BYTES = 4 * 1024 * 1024;
export const MAX_HTML_BYTES = 2 * 1024 * 1024;
export const MAX_DIAGNOSTIC_CHARS = 256;
export const MCP_APP_HTML_MIME = "text/html;profile=mcp-app";
export const LEGACY_PROTOCOL_VERSION = "2025-11-25";
export const DISCOVER_PROTOCOL_VERSION = "2026-07-28";
export const CLIENT_NAME = "borg.mcp";

export const LEGACY_PROTOCOL_VERSIONS = Object.freeze([
  "2024-11-05",
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
]);

export const METHOD_NOT_FOUND = -32601;
export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

export type McpProtocolEra = "legacy" | "discover";
export type McpTransportKind = "stdio" | "sse" | "streamable-http";

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcNotification {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: unknown;
}

export interface JsonRpcSuccess {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly result: unknown;
}

export interface JsonRpcFailure {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId;
  readonly error: {
    readonly code: number;
    readonly message: string;
    readonly data?: unknown;
  };
}

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcSuccess
  | JsonRpcFailure;

export interface McpTransport {
  readonly kind: McpTransportKind;
  send(
    message: JsonRpcMessage,
    options?: {
      readonly signal?: AbortSignal | undefined;
      readonly headers?: Readonly<Record<string, string>> | undefined;
    },
  ): Promise<void>;
  subscribe(handler: (message: JsonRpcMessage) => void): () => void;
  onClose?(handler: () => void): () => void;
  close(): Promise<void>;
}

export class McpProtocolError extends Error {
  constructor(
    readonly code: number,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "McpProtocolError";
  }
}

export function isMethodNotFound(error: unknown): boolean {
  return error instanceof McpProtocolError && error.code === METHOD_NOT_FOUND;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function jsonRpcIdOf(value: unknown): JsonRpcId | undefined {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return value;
  }
  return undefined;
}

export function asJsonRpcMessage(value: unknown): JsonRpcMessage | undefined {
  if (!isRecord(value) || value.jsonrpc !== "2.0") {
    return undefined;
  }
  if (
    typeof value.method === "string" &&
    value.method.length > 0 &&
    value.method.length <= 256
  ) {
    if ("result" in value || "error" in value) {
      return undefined;
    }
    const params = "params" in value ? { params: value.params } : {};
    if ("id" in value) {
      const id = jsonRpcIdOf(value.id);
      if (id === undefined) {
        return undefined;
      }
      return { jsonrpc: "2.0", id, method: value.method, ...params };
    }
    return { jsonrpc: "2.0", method: value.method, ...params };
  }
  if ("method" in value || "params" in value) {
    return undefined;
  }
  const id = jsonRpcIdOf(value.id);
  if (id === undefined) {
    return undefined;
  }
  const hasResult = "result" in value;
  const hasError = "error" in value;
  if (hasResult === hasError) {
    return undefined;
  }
  if (hasResult) {
    return { jsonrpc: "2.0", id, result: value.result };
  }
  if (
    isRecord(value.error) &&
    typeof value.error.code === "number" &&
    Number.isSafeInteger(value.error.code)
  ) {
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: value.error.code,
        message:
          typeof value.error.message === "string"
            ? value.error.message
            : "MCP request failed",
        ...(value.error.data !== undefined ? { data: value.error.data } : {}),
      },
    };
  }
  return undefined;
}

export function encodeNdjson(message: JsonRpcMessage): Uint8Array {
  const encoded = new TextEncoder().encode(`${JSON.stringify(message)}\n`);
  if (encoded.byteLength > MAX_JSONRPC_BYTES) {
    throw new McpProtocolError(INVALID_REQUEST, "MCP message is too large");
  }
  return encoded;
}
