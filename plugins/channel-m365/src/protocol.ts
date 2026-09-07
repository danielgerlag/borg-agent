export const M365_ADAPTER_ID = "borg.channel.m365";
export const GRAPH_API_BASE = "https://graph.microsoft.com";
export const M365_AUTHORITY = "https://login.microsoftonline.com";
export const M365_DEFAULT_TENANT = "common";
export const M365_SCOPES = Object.freeze([
  "offline_access",
  "User.Read",
  "Mail.Read",
  "Mail.Send",
]);
export const M365_LOOPBACK_HOST = "localhost" as const;

export const FALLBACK_DESTINATION = "inbox";
export const SEEN_STORE_KEY = "seen-message-ids";
export const POLL_INTERVAL_MS = 30_000;
export const MAX_POLL_MESSAGES = 25;
export const MAX_SEEN_IDS = 500;
export const MAX_ALLOWED_RECIPIENTS = 64;
export const MAX_REST_RESPONSE_BYTES = 65_536;
export const MAX_OUTBOUND_CONTENT_LENGTH = 65_536;
export const MAX_INBOUND_CONTENT_LENGTH = 65_536;
export const MAX_DIAGNOSTIC_CHARS = 200;
export const MAX_EMAIL_LENGTH = 320;
export const MAX_TENANT_LENGTH = 253;

export const EMAIL_PATTERN =
  /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
export const TENANT_PATTERN = /^[A-Za-z0-9._-]+$/;

const SAFE_PATH = /^\/v1\.0\/(?:me|me\/mailFolders\/inbox\/messages|me\/sendMail)$/;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function boundDiagnostic(value: string): string {
  return value.length <= MAX_DIAGNOSTIC_CHARS
    ? value
    : value.slice(0, MAX_DIAGNOSTIC_CHARS);
}

export function isAllowedGraphPath(path: string): boolean {
  return SAFE_PATH.test(path);
}

export function m365AuthorizationEndpoint(tenant: string): string {
  return `${M365_AUTHORITY}/${encodeURIComponent(tenant)}/oauth2/v2.0/authorize`;
}

export function m365TokenEndpoint(tenant: string): string {
  return `${M365_AUTHORITY}/${encodeURIComponent(tenant)}/oauth2/v2.0/token`;
}

export function normalizeEmail(value: string): string {
  return value.trim();
}

export function emailKey(value: string): string {
  return normalizeEmail(value).toLowerCase();
}

export function isEmailAddress(value: string): boolean {
  const trimmed = normalizeEmail(value);
  return (
    trimmed.length > 0 &&
    trimmed.length <= MAX_EMAIL_LENGTH &&
    EMAIL_PATTERN.test(trimmed)
  );
}
