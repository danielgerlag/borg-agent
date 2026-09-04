import {
  MCP_APP_BRIDGE_CHANNEL,
  MCP_APP_MAX_MESSAGE_BYTES,
  mcpAppToolArgumentsSchema,
  type McpAppRequestId,
  type McpAppSnapshot,
  type McpAppToolArguments,
} from "@borg/contracts";

export {
  MCP_APP_BRIDGE_CHANNEL,
  MCP_APP_MAX_MESSAGE_BYTES,
} from "@borg/contracts";

export interface McpAppBridgeEnvelope {
  readonly channel: typeof MCP_APP_BRIDGE_CHANNEL;
  readonly instanceId: string;
  readonly nonce: string;
  readonly payload: unknown;
}

export interface McpAppRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id?: McpAppRequestId | undefined;
  readonly method: string;
  readonly params?: unknown;
}

export interface McpAppInitializeParams {
  readonly protocolVersion: string;
}

export interface McpAppToolCallParams {
  readonly name: string;
  readonly arguments: McpAppToolArguments;
}

export interface McpAppCancelledParams {
  readonly requestId: McpAppRequestId;
}

export const MCP_APP_PROTOCOL_VERSION = "2026-01-26";
export const SANDBOX_PROXY_READY_METHOD =
  "ui/notifications/sandbox-proxy-ready";
export const SANDBOX_RESOURCE_READY_METHOD =
  "ui/notifications/sandbox-resource-ready";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return keys.every((key) => allowed.includes(key));
}

function isRequestId(value: unknown): value is McpAppRequestId {
  return (
    (typeof value === "string" && value.length > 0 && value.length <= 256) ||
    (typeof value === "number" && Number.isSafeInteger(value))
  );
}

function isBoundedJson(value: unknown): boolean {
  const stack: { readonly value: unknown; readonly depth: number }[] = [
    { value, depth: 0 },
  ];
  const seen = new WeakSet<object>();
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (current.depth > 32 || nodes > 100_000) {
      return false;
    }
    if (
      current.value === null ||
      typeof current.value === "string" ||
      typeof current.value === "boolean"
    ) {
      continue;
    }
    if (typeof current.value === "number") {
      if (!Number.isFinite(current.value)) {
        return false;
      }
      continue;
    }
    if (typeof current.value !== "object" || seen.has(current.value)) {
      return false;
    }
    const prototype = Object.getPrototypeOf(current.value);
    if (
      (prototype !== Object.prototype &&
        prototype !== Array.prototype &&
        prototype !== null) ||
      Object.getOwnPropertySymbols(current.value).length > 0
    ) {
      return false;
    }
    seen.add(current.value);
    for (const entry of Array.isArray(current.value)
      ? current.value
      : Object.values(current.value)) {
      stack.push({ value: entry, depth: current.depth + 1 });
    }
  }
  try {
    const serialized = JSON.stringify(value);
    return (
      serialized !== undefined &&
      new TextEncoder().encode(serialized).byteLength <=
        MCP_APP_MAX_MESSAGE_BYTES
    );
  } catch {
    return false;
  }
}

export function bridgeEnvelope(
  instanceId: string,
  nonce: string,
  payload: unknown,
): McpAppBridgeEnvelope {
  return {
    channel: MCP_APP_BRIDGE_CHANNEL,
    instanceId,
    nonce,
    payload,
  };
}

export function parseBridgeEnvelope(
  value: unknown,
  instanceId: string,
  nonce: string,
): McpAppBridgeEnvelope | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["channel", "instanceId", "nonce", "payload"]) ||
    value.channel !== MCP_APP_BRIDGE_CHANNEL ||
    value.instanceId !== instanceId ||
    value.nonce !== nonce ||
    !isBoundedJson(value.payload)
  ) {
    return undefined;
  }
  return bridgeEnvelope(instanceId, nonce, value.payload);
}

export function parseAppRpcRequest(
  value: unknown,
): McpAppRpcRequest | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["jsonrpc", "id", "method", "params"]) ||
    value.jsonrpc !== "2.0" ||
    typeof value.method !== "string" ||
    value.method.length === 0 ||
    value.method.length > 256 ||
    ("id" in value && !isRequestId(value.id)) ||
    ("params" in value && !isBoundedJson(value.params)) ||
    !isBoundedJson(value)
  ) {
    return undefined;
  }
  return {
    jsonrpc: "2.0",
    ...("id" in value ? { id: value.id as McpAppRequestId } : {}),
    method: value.method,
    ...("params" in value ? { params: value.params } : {}),
  };
}

export function parseInitializeParams(
  value: unknown,
): McpAppInitializeParams | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "protocolVersion",
      "appInfo",
      "appCapabilities",
    ]) ||
    typeof value.protocolVersion !== "string" ||
    value.protocolVersion.length === 0 ||
    value.protocolVersion.length > 64 ||
    !isBoundedJson(value)
  ) {
    return undefined;
  }
  return { protocolVersion: value.protocolVersion };
}

export function parseToolCallParams(
  value: unknown,
): McpAppToolCallParams | undefined {
  const parsedArguments = mcpAppToolArgumentsSchema.safeParse(
    isRecord(value) ? (value.arguments ?? {}) : {},
  );
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["name", "arguments"]) ||
    typeof value.name !== "string" ||
    value.name.length === 0 ||
    value.name.length > 256 ||
    !parsedArguments.success ||
    !isBoundedJson(value)
  ) {
    return undefined;
  }
  return {
    name: value.name,
    arguments: parsedArguments.data,
  };
}

export function parseCancelledParams(
  value: unknown,
): McpAppCancelledParams | undefined {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ["requestId"]) ||
    !isRequestId(value.requestId) ||
    !isBoundedJson(value)
  ) {
    return undefined;
  }
  return { requestId: value.requestId };
}

export function hasEmptyParams(value: unknown): boolean {
  return (
    value === undefined ||
    (isRecord(value) && Object.keys(value).length === 0)
  );
}

export function createHostInitializeResult(
  app: McpAppSnapshot,
  requestedProtocolVersion: string,
): object {
  const sourceTool = app.tools.find(
    (tool) =>
      tool.toolId === app.sourceToolId &&
      tool.name === app.sourceToolName &&
      isRecord(tool.inputSchema) &&
      tool.inputSchema.type === "object",
  );
  return {
    protocolVersion:
      requestedProtocolVersion === MCP_APP_PROTOCOL_VERSION
        ? requestedProtocolVersion
        : MCP_APP_PROTOCOL_VERSION,
    hostInfo: { name: "Borg", version: "0.1.0" },
    hostCapabilities: { serverTools: {} },
    hostContext: {
      displayMode: "inline",
      availableDisplayModes: ["inline"],
      ...(sourceTool
        ? {
            toolInfo: {
              tool: {
                name: sourceTool.name,
                description: sourceTool.description,
                inputSchema: sourceTool.inputSchema,
              },
            },
          }
        : {}),
    },
  };
}

export function sandboxResourceReady(appHtml: string): object {
  return {
    jsonrpc: "2.0",
    method: SANDBOX_RESOURCE_READY_METHOD,
    params: { html: appHtml },
  };
}

export function hardenAppHtml(html: string): string {
  const policy = [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    "img-src data: blob:",
    "font-src data:",
    "connect-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
  const metadata =
    `<meta http-equiv="Content-Security-Policy" content="${policy}">` +
    '<meta name="referrer" content="no-referrer">';
  const htmlStartEnd = findHtmlStartEnd(html);
  if (htmlStartEnd === undefined) {
    throw new Error("MCP App HTML has an invalid document envelope");
  }
  return `${html.slice(0, htmlStartEnd)}${metadata}${html.slice(htmlStartEnd)}`;
}

function findHtmlStartEnd(html: string): number | undefined {
  const doctype = /^\s*<!doctype html>\s*/i.exec(html);
  if (!doctype) {
    return undefined;
  }
  const start = doctype[0].length;
  if (
    html.slice(start, start + 5).toLowerCase() !== "<html" ||
    !/[\s>]/.test(html[start + 5] ?? "")
  ) {
    return undefined;
  }
  let quote: '"' | "'" | undefined;
  for (let index = start + 5; index < html.length; index += 1) {
    const character = html[index];
    if (quote) {
      if (character === quote) {
        quote = undefined;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "<") {
      return undefined;
    }
    if (character === ">") {
      return index + 1;
    }
  }
  return undefined;
}

export function isProxyReady(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ["jsonrpc", "method", "params"]) &&
    Object.keys(value).length === 3 &&
    value.jsonrpc === "2.0" &&
    value.method === SANDBOX_PROXY_READY_METHOD &&
    hasEmptyParams(value.params)
  );
}

export function isSandboxReservedMessage(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.method === "string" &&
    value.method.startsWith("ui/notifications/sandbox-")
  );
}

export function createProxyUrl(input: {
  readonly instanceId: string;
  readonly nonce: string;
  readonly parentOrigin: string;
}): string {
  const url = new URL("borg-embedded://mcp-app/proxy.html");
  url.searchParams.set("instanceId", input.instanceId);
  url.searchParams.set("nonce", input.nonce);
  url.searchParams.set("parentOrigin", input.parentOrigin);
  return url.href;
}
