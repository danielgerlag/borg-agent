export const MCP_APP_CSP_QUERY_MAX_CHARS = 8_192;

export interface McpAppCspFields {
  readonly resourceDomains: readonly string[];
  readonly connectDomains: readonly string[];
  readonly frameDomains: readonly string[];
  readonly baseUriDomains: readonly string[];
}

export interface McpAppPermissionFlags {
  readonly camera: boolean;
  readonly microphone: boolean;
  readonly geolocation: boolean;
  readonly clipboardWrite: boolean;
}

export interface McpAppNetworkGrant {
  readonly connect: readonly string[];
  readonly resource: readonly string[];
  readonly frame: readonly string[];
  readonly base: readonly string[];
}

const EMPTY_GRANT: McpAppNetworkGrant = {
  connect: [],
  resource: [],
  frame: [],
  base: [],
};

export function parseMcpAppNetworkGrant(
  csp: McpAppCspFields,
): McpAppNetworkGrant {
  return {
    connect: unique(csp.connectDomains.map(parseGrantedDomain).filter(isPresent)),
    resource: unique(csp.resourceDomains.map(parseGrantedDomain).filter(isPresent)),
    frame: unique(csp.frameDomains.map(parseGrantedDomain).filter(isPresent)),
    base: unique(csp.baseUriDomains.map(parseGrantedDomain).filter(isPresent)),
  };
}

export function buildAppCsp(grant: McpAppNetworkGrant): string {
  const resources = joinOrigins(grant.resource);
  const connect = joinOrigins(grant.connect) || "'none'";
  const frames = joinOrigins(grant.frame) || "'none'";
  const base = joinOrigins(grant.base) || "'none'";
  const workers = resources || "'none'";
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline'${suffix(resources)}`,
    `style-src 'unsafe-inline'${suffix(resources)}`,
    `connect-src ${connect}`,
    `img-src data: blob:${suffix(resources)}`,
    `font-src data:${suffix(resources)}`,
    `media-src data:${suffix(resources)}`,
    `frame-src ${frames}`,
    "object-src 'none'",
    `worker-src ${workers}`,
    `base-uri ${base}`,
    "form-action 'none'",
  ].join("; ");
}

export function buildProxyCsp(): string {
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    "frame-src 'self'",
    "connect-src 'none'",
    "img-src data: blob:",
    "font-src data:",
    "media-src 'none'",
    "object-src 'none'",
    "worker-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

export function buildAllowAttribute(
  permissions: McpAppPermissionFlags,
): string | undefined {
  const tokens: string[] = [];
  if (permissions.camera) {
    tokens.push("camera");
  }
  if (permissions.microphone) {
    tokens.push("microphone");
  }
  if (permissions.geolocation) {
    tokens.push("geolocation");
  }
  if (permissions.clipboardWrite) {
    tokens.push("clipboard-write");
  }
  return tokens.length > 0 ? tokens.join("; ") : undefined;
}

export function buildPermissionsPolicy(
  permissions: McpAppPermissionFlags,
): string {
  const token = (feature: string, granted: boolean): string =>
    `${feature}=${granted ? "*" : "()"}`;
  return [
    "accelerometer=()",
    "autoplay=()",
    token("camera", permissions.camera),
    "clipboard-read=()",
    token("clipboard-write", permissions.clipboardWrite),
    "display-capture=()",
    "fullscreen=()",
    token("geolocation", permissions.geolocation),
    "gyroscope=()",
    "hid=()",
    "idle-detection=()",
    token("microphone", permissions.microphone),
    "midi=()",
    "payment=()",
    "publickey-credentials-get=()",
    "screen-wake-lock=()",
    "serial=()",
    "usb=()",
    "window-management=()",
  ].join(", ");
}

export function encodeMcpAppCspQuery(csp: McpAppCspFields): string | undefined {
  const grant = parseMcpAppNetworkGrant(csp);
  if (
    grant.connect.length === 0 &&
    grant.resource.length === 0 &&
    grant.frame.length === 0 &&
    grant.base.length === 0
  ) {
    return undefined;
  }
  const encoded = utf8ToBase64Url(
    JSON.stringify({
      connectDomains: grant.connect,
      resourceDomains: grant.resource,
      frameDomains: grant.frame,
      baseUriDomains: grant.base,
    }),
  );
  return encoded.length <= MCP_APP_CSP_QUERY_MAX_CHARS ? encoded : undefined;
}

export function encodeMcpAppPermissionsQuery(
  permissions: McpAppPermissionFlags,
): string | undefined {
  const tokens: string[] = [];
  if (permissions.camera) {
    tokens.push("camera");
  }
  if (permissions.microphone) {
    tokens.push("microphone");
  }
  if (permissions.geolocation) {
    tokens.push("geolocation");
  }
  if (permissions.clipboardWrite) {
    tokens.push("clipboard-write");
  }
  return tokens.length > 0 ? tokens.join(",") : undefined;
}

export function grantFromProxyUrl(candidate: string): McpAppNetworkGrant {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return EMPTY_GRANT;
  }
  const raw = url.searchParams.get("csp");
  if (raw === null || raw.length === 0) {
    return EMPTY_GRANT;
  }
  if (raw.length > MCP_APP_CSP_QUERY_MAX_CHARS) {
    return EMPTY_GRANT;
  }
  try {
    const parsed: unknown = JSON.parse(base64UrlToUtf8(raw));
    if (!isCspFields(parsed)) {
      return EMPTY_GRANT;
    }
    return parseMcpAppNetworkGrant(parsed);
  } catch {
    return EMPTY_GRANT;
  }
}

export function permissionsFromProxyUrl(
  candidate: string,
): McpAppPermissionFlags {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return {
      camera: false,
      microphone: false,
      geolocation: false,
      clipboardWrite: false,
    };
  }
  const raw = url.searchParams.get("perm") ?? "";
  const tokens = new Set(raw.split(",").filter((token) => token.length > 0));
  return {
    camera: tokens.has("camera"),
    microphone: tokens.has("microphone"),
    geolocation: tokens.has("geolocation"),
    clipboardWrite: tokens.has("clipboard-write"),
  };
}

export function mcpAppRequestAllowed(
  requestUrl: string,
  resourceType: string,
  grant: McpAppNetworkGrant,
): boolean {
  const bucket = bucketForResourceType(resourceType);
  if (bucket === undefined) {
    return false;
  }
  return originMatchesGrant(requestUrl, grant[bucket]);
}

export function originMatchesGrant(
  requestUrl: string,
  allowed: readonly string[],
): boolean {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return false;
  }
  const origin = url.origin.toLowerCase();
  for (const entry of allowed) {
    const allowedEntry = entry.toLowerCase();
    if (allowedEntry.startsWith("https://*.") || allowedEntry.startsWith("wss://*.")) {
      const scheme = allowedEntry.startsWith("wss:") ? "wss:" : "https:";
      const suffix = allowedEntry.slice(allowedEntry.indexOf("*") + 1);
      if (
        url.protocol === scheme &&
        suffix.startsWith(".") &&
        url.hostname.length > suffix.length &&
        url.hostname.endsWith(suffix)
      ) {
        return true;
      }
      continue;
    }
    if (origin === allowedEntry) {
      return true;
    }
  }
  return false;
}

function bucketForResourceType(
  resourceType: string,
): keyof McpAppNetworkGrant | undefined {
  switch (resourceType) {
    case "xhr":
    case "webSocket":
      return "connect";
    case "image":
    case "font":
    case "stylesheet":
    case "script":
    case "media":
      return "resource";
    case "subFrame":
      return "frame";
    default:
      return undefined;
  }
}

function parseGrantedDomain(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 2_048) {
    return undefined;
  }
  if (/[;'"`<>\\\s]/.test(trimmed) || trimmed === "*" || trimmed.startsWith("'")) {
    return undefined;
  }
  const wildcard = /^(https|wss):\/\/\*\.([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)$/i.exec(
    trimmed,
  );
  if (wildcard) {
    return `${wildcard[1]!.toLowerCase()}://*.${wildcard[2]!.toLowerCase()}`;
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    url.search !== ""
  ) {
    return undefined;
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    return undefined;
  }
  if (url.protocol === "https:" || url.protocol === "wss:") {
    return url.origin.toLowerCase();
  }
  if (
    (url.protocol === "http:" || url.protocol === "ws:") &&
    isLoopbackHostname(url.hostname)
  ) {
    return url.origin.toLowerCase();
  }
  return undefined;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized)
  );
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function isPresent(value: string | undefined): value is string {
  return value !== undefined;
}

function joinOrigins(values: readonly string[]): string {
  return values.join(" ");
}

function suffix(value: string): string {
  return value.length === 0 ? "" : ` ${value}`;
}

function isCspFields(value: unknown): value is McpAppCspFields {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    isStringArray(record.connectDomains) &&
    isStringArray(record.resourceDomains) &&
    isStringArray(record.frameDomains) &&
    isStringArray(record.baseUriDomains)
  );
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function utf8ToBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToUtf8(value: string): string {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  const binary = atob(`${padded}${pad}`);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
