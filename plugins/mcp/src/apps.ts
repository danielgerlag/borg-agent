import {
  mcpAppCspSchema,
  mcpAppPermissionsSchema,
  type McpAppCsp,
  type McpAppPermissions,
} from "@borg/contracts";
import { createHash } from "node:crypto";
import {
  MAX_HTML_BYTES,
  MCP_APP_HTML_MIME,
  isRecord,
} from "./protocol";
import type { McpResourceContents } from "./client";

const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const PERMISSION_KEYS = [
  "camera",
  "microphone",
  "geolocation",
  "clipboardWrite",
] as const;

export interface ValidatedMcpApp {
  readonly html: string;
  readonly csp: McpAppCsp;
  readonly permissions: McpAppPermissions;
}

export function isUiResourceUri(uri: string): boolean {
  return uri.startsWith("ui://");
}

export function isMcpAppHtmlMime(value: string): boolean {
  const [type, ...params] = value.split(";").map((part) => part.trim().toLowerCase());
  return type === "text/html" && params.includes("profile=mcp-app");
}

export function isHtml5Document(html: string): boolean {
  const doctype = /^\s*<!doctype html>\s*/i.exec(html);
  if (!doctype) {
    return false;
  }
  const start = doctype[0].length;
  if (
    html.slice(start, start + 5).toLowerCase() !== "<html" ||
    !/[\s>]/.test(html[start + 5] ?? "")
  ) {
    return false;
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
      return false;
    }
    if (character === ">") {
      return true;
    }
  }
  return false;
}

export function createAppInstanceId(parts: {
  readonly sessionId: string;
  readonly serverId: string;
  readonly resourceUri: string;
  readonly toolCallId: string;
}): string {
  const digest = createHash("sha256")
    .update(
      `${parts.sessionId}\0${parts.serverId}\0${parts.resourceUri}\0${parts.toolCallId}`,
    )
    .digest();
  const bytes = Uint8Array.from(digest.subarray(0, 16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function validateAppResource(
  resourceUri: string,
  contents: readonly McpResourceContents[],
): ValidatedMcpApp {
  if (!isUiResourceUri(resourceUri)) {
    throw new Error("MCP app resource URI is invalid");
  }
  const matches = contents.filter(
    (entry) =>
      entry.uri === resourceUri &&
      typeof entry.mimeType === "string" &&
      isMcpAppHtmlMime(entry.mimeType),
  );
  if (matches.length !== 1) {
    throw new Error("MCP app resource must contain exactly one HTML item");
  }
  const resource = matches[0]!;
  const html = decodeHtml(resource);
  const bytes = new TextEncoder().encode(html);
  if (bytes.byteLength > MAX_HTML_BYTES) {
    throw new Error("MCP app HTML exceeds the size cap");
  }
  if (!isHtml5Document(html)) {
    throw new Error("MCP app HTML must be an HTML5 document");
  }
  const meta = isRecord(resource._meta) && isRecord(resource._meta.ui)
    ? resource._meta.ui
    : {};
  return {
    html,
    csp: mcpAppCspSchema.parse(isRecord(meta.csp) ? meta.csp : {}),
    permissions: normalizeRequestedPermissions(meta.permissions),
  };
}

export function normalizeRequestedPermissions(value: unknown): McpAppPermissions {
  const source = isRecord(value) ? value : {};
  const requested = Object.fromEntries(
    PERMISSION_KEYS.map((key) => [key, isRequestedPermission(source[key])]),
  );
  return mcpAppPermissionsSchema.parse(requested);
}

function isRequestedPermission(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).length === 0;
}

function decodeHtml(resource: McpResourceContents): string {
  const hasText = typeof resource.text === "string";
  const hasBlob = typeof resource.blob === "string";
  if (hasText === hasBlob) {
    throw new Error("MCP app resource must contain exactly one of text or blob");
  }
  if (hasText) {
    return resource.text as string;
  }
  return decodeCanonicalBase64(resource.blob as string);
}

function decodeCanonicalBase64(value: string): string {
  if (!CANONICAL_BASE64.test(value) || value.length === 0) {
    throw new Error("MCP app resource blob is not canonical base64");
  }
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) {
    throw new Error("MCP app resource blob is not canonical base64");
  }
  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return decoded;
}

export function mcpAppMime(): string {
  return MCP_APP_HTML_MIME;
}
