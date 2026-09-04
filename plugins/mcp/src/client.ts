import {
  CLIENT_NAME,
  DISCOVER_PROTOCOL_VERSION,
  LEGACY_PROTOCOL_VERSION,
  LEGACY_PROTOCOL_VERSIONS,
  MCP_APP_HTML_MIME,
  type JsonRpcMessage,
  type McpProtocolEra,
  type McpTransport,
  isMethodNotFound,
  isRecord,
} from "./protocol";
import { JsonRpcPeer, type JsonRpcRequestOptions } from "./json-rpc";
import type { McpToolDescriptor, McpToolVisibility } from "./ids";

export const MCP_CLIENT_CAPABILITIES = Object.freeze({
  extensions: Object.freeze({
    "io.modelcontextprotocol/ui": Object.freeze({
      mimeTypes: Object.freeze([MCP_APP_HTML_MIME]),
    }),
  }),
});

export const MAX_TOOL_PAGES = 100;
export const MAX_TOOLS = 10_000;

export interface McpClientInfo {
  readonly name: string;
  readonly version: string;
}

export interface McpClientOptions {
  readonly transport: McpTransport;
  readonly clientInfo: McpClientInfo;
  readonly reopen?: (() => Promise<McpTransport>) | undefined;
}

export interface McpToolCallResult {
  readonly content?: unknown;
  readonly structuredContent?: unknown;
  readonly isError?: boolean | undefined;
  readonly [key: string]: unknown;
}

export interface McpResourceContents {
  readonly uri: string;
  readonly mimeType?: string | undefined;
  readonly text?: string | undefined;
  readonly blob?: string | undefined;
  readonly _meta?: unknown;
}

export class McpClient {
  #peer: JsonRpcPeer;
  #transport: McpTransport;
  #era: McpProtocolEra = "legacy";
  readonly #clientInfo: McpClientInfo;
  readonly #reopen: (() => Promise<McpTransport>) | undefined;
  #protocolVersion: string | undefined;

  constructor(options: McpClientOptions) {
    this.#transport = options.transport;
    this.#peer = new JsonRpcPeer(options.transport);
    this.#clientInfo = options.clientInfo;
    this.#reopen = options.reopen;
  }

  get era(): McpProtocolEra {
    return this.#era;
  }

  async initialize(signal?: AbortSignal): Promise<unknown> {
    if (this.#transport.kind === "sse") {
      this.#era = "legacy";
      return this.#initializeLegacy(signal);
    }
    try {
      const result = await this.#initializeLegacy(signal);
      this.#era = "legacy";
      return result;
    } catch (error) {
      if (!isMethodNotFound(error)) {
        throw error;
      }
      if (this.#transport.kind === "stdio" && this.#reopen) {
        await this.#peer.close();
        this.#transport = await this.#reopen();
        this.#peer = new JsonRpcPeer(this.#transport);
      }
      this.#era = "discover";
      return this.#discover(signal);
    }
  }

  async listTools(signal?: AbortSignal): Promise<McpToolDescriptor[]> {
    const tools: McpToolDescriptor[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const result = await this.#request(
        "tools/list",
        cursor ? { cursor } : {},
        signal,
      );
      if (!isRecord(result) || !Array.isArray(result.tools)) {
        throw new Error("MCP tools/list is invalid");
      }
      for (const tool of result.tools) {
        if (
          !isRecord(tool) ||
          typeof tool.name !== "string" ||
          tool.name.length === 0 ||
          tool.name.length > 256 ||
          (tool.description !== undefined &&
            (typeof tool.description !== "string" ||
              tool.description.length > 10_000))
        ) {
          throw new Error("MCP tools/list contains an invalid tool");
        }
        tools.push(asToolDescriptor(tool));
        if (tools.length > MAX_TOOLS) {
          throw new Error("MCP tools/list exceeds the tool cap");
        }
      }
      if (
        result.nextCursor !== undefined &&
        (typeof result.nextCursor !== "string" ||
          result.nextCursor.length === 0)
      ) {
        throw new Error("MCP tools/list next cursor is invalid");
      }
      cursor = result.nextCursor as string | undefined;
      if (cursor) {
        if (cursors.has(cursor) || cursors.size >= MAX_TOOL_PAGES - 1) {
          throw new Error("MCP tools/list pagination did not terminate");
        }
        cursors.add(cursor);
      }
    } while (cursor);
    return tools;
  }

  async callTool(
    name: string,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<McpToolCallResult> {
    const result = await this.#request(
      "tools/call",
      { name, arguments: args ?? {} },
      signal,
      name,
    );
    if (!isRecord(result)) {
      throw new Error("MCP tools/call is invalid");
    }
    return result;
  }

  async readResource(
    uri: string,
    signal?: AbortSignal,
  ): Promise<readonly McpResourceContents[]> {
    const result = await this.#request("resources/read", { uri }, signal, uri);
    if (!isRecord(result) || !Array.isArray(result.contents)) {
      throw new Error("MCP resources/read is invalid");
    }
    return result.contents.map((entry) => {
      if (
        !isRecord(entry) ||
        typeof entry.uri !== "string" ||
        (entry.mimeType !== undefined && typeof entry.mimeType !== "string") ||
        (entry.text !== undefined && typeof entry.text !== "string") ||
        (entry.blob !== undefined && typeof entry.blob !== "string")
      ) {
        throw new Error("MCP resources/read contains an invalid resource");
      }
      return {
        uri: entry.uri,
        ...(typeof entry.mimeType === "string"
          ? { mimeType: entry.mimeType }
          : {}),
        ...(typeof entry.text === "string" ? { text: entry.text } : {}),
        ...(typeof entry.blob === "string" ? { blob: entry.blob } : {}),
        ...(entry._meta !== undefined ? { _meta: entry._meta } : {}),
      };
    });
  }

  async close(): Promise<void> {
    await this.#peer.close();
  }

  async #initializeLegacy(signal?: AbortSignal): Promise<unknown> {
    const result = await this.#peer.request(
      "initialize",
      {
        protocolVersion: LEGACY_PROTOCOL_VERSION,
        capabilities: MCP_CLIENT_CAPABILITIES,
        clientInfo: this.#clientInfo,
      },
      signal ? { signal } : {},
    );
    if (
      !isRecord(result) ||
      typeof result.protocolVersion !== "string" ||
      !LEGACY_PROTOCOL_VERSIONS.includes(result.protocolVersion)
    ) {
      throw new Error("MCP initialize returned an unsupported protocol version");
    }
    this.#protocolVersion = result.protocolVersion;
    await this.#peer.notify(
      "notifications/initialized",
      {},
      {
        ...(signal ? { signal } : {}),
        headers: { "MCP-Protocol-Version": this.#protocolVersion },
      },
    );
    return result;
  }

  async #discover(signal?: AbortSignal): Promise<unknown> {
    return this.#request("server/discover", {}, signal);
  }

  async #request(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    name?: string,
  ): Promise<unknown> {
    const options: JsonRpcRequestOptions = {
      ...(signal ? { signal } : {}),
      ...(this.#era === "discover"
        ? {
            headers: discoverHeaders(method, name),
            decorate: (message) => decorateDiscover(message, this.#clientInfo),
          }
        : this.#protocolVersion
          ? {
              headers: {
                "MCP-Protocol-Version": this.#protocolVersion,
              },
            }
          : {}),
    };
    return this.#peer.request(method, params, options);
  }
}

export function decorateDiscover(
  message: JsonRpcMessage,
  clientInfo: McpClientInfo,
): JsonRpcMessage {
  if (!("method" in message)) {
    return message;
  }
  const current = isRecord(message.params) ? message.params : {};
  const params = {
    ...current,
    _meta: {
      ...(isRecord(current._meta) ? current._meta : {}),
      "io.modelcontextprotocol/protocolVersion": DISCOVER_PROTOCOL_VERSION,
      "io.modelcontextprotocol/clientInfo": {
        name: clientInfo.name,
        version: clientInfo.version,
      },
      "io.modelcontextprotocol/clientCapabilities": MCP_CLIENT_CAPABILITIES,
    },
  };
  if ("id" in message) {
    return {
      jsonrpc: "2.0",
      id: message.id,
      method: message.method,
      params,
    };
  }
  return {
    jsonrpc: "2.0",
    method: message.method,
    params,
  };
}

export function discoverHeaders(
  method: string,
  name?: string,
): Record<string, string> {
  const headers: Record<string, string> = {
    "MCP-Protocol-Version": DISCOVER_PROTOCOL_VERSION,
    "Mcp-Method": method,
  };
  if (name !== undefined) {
    headers["Mcp-Name"] = name;
  }
  return headers;
}

function asToolVisibility(
  value: unknown,
): readonly McpToolVisibility[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length > 2) {
    throw new Error("MCP tools/list contains invalid UI visibility");
  }
  const visibility: McpToolVisibility[] = [];
  for (const entry of value) {
    if ((entry !== "model" && entry !== "app") || visibility.includes(entry)) {
      throw new Error("MCP tools/list contains invalid UI visibility");
    }
    visibility.push(entry);
  }
  return visibility;
}

function asToolDescriptor(tool: Record<string, unknown>): McpToolDescriptor {
  const annotations = isRecord(tool.annotations) ? tool.annotations : undefined;
  if (tool._meta !== undefined && !isRecord(tool._meta)) {
    throw new Error("MCP tools/list contains invalid metadata");
  }
  const meta = isRecord(tool._meta) ? tool._meta : undefined;
  if (meta?.ui !== undefined && !isRecord(meta.ui)) {
    throw new Error("MCP tools/list contains invalid UI metadata");
  }
  const ui = meta && isRecord(meta.ui) ? meta.ui : undefined;
  if (
    ui?.resourceUri !== undefined &&
    (typeof ui.resourceUri !== "string" ||
      ui.resourceUri.length < 6 ||
      ui.resourceUri.length > 2_048 ||
      !ui.resourceUri.startsWith("ui://"))
  ) {
    throw new Error("MCP tools/list contains an invalid app resource URI");
  }
  const visibility = ui ? asToolVisibility(ui.visibility) : undefined;
  return {
    name: String(tool.name),
    ...(typeof tool.description === "string"
      ? { description: tool.description }
      : {}),
    ...(tool.inputSchema !== undefined ? { inputSchema: tool.inputSchema } : {}),
    ...(annotations
      ? {
          annotations: {
            ...(typeof annotations.readOnlyHint === "boolean"
              ? { readOnlyHint: annotations.readOnlyHint }
              : {}),
            ...(typeof annotations.destructiveHint === "boolean"
              ? { destructiveHint: annotations.destructiveHint }
              : {}),
          },
        }
      : {}),
    ...(ui
      ? {
          _meta: {
            ui: {
              ...(typeof ui.resourceUri === "string"
                ? { resourceUri: ui.resourceUri }
                : {}),
              ...(visibility !== undefined ? { visibility } : {}),
            },
          },
        }
      : {}),
  };
}

export function clientName(): string {
  return CLIENT_NAME;
}
