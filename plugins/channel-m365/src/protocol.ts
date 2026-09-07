export const M365_ADAPTER_ID = "borg.channel.m365";
export const GRAPH_API_BASE = "https://graph.microsoft.com";
export const M365_AUTHORITY = "https://login.microsoftonline.com";
export const M365_DEFAULT_TENANT = "common";
export const M365_SCOPES = Object.freeze([
  "offline_access",
  "User.Read",
  "Mail.Read",
  "Mail.Send",
  "Calendars.ReadWrite",
  "Files.Read",
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
export const MAX_DRIVE_SEARCH_QUERY = 200;
export const MAX_DRIVE_ITEM_ID_LENGTH = 256;
export const MAX_DRIVE_TEXT_CHARS = 8_000;
export const CALENDAR_DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const CALENDAR_DEFAULT_MAX_RESULTS = 10;

export const EMAIL_PATTERN =
  /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
export const TENANT_PATTERN = /^[A-Za-z0-9._-]+$/;
export const DRIVE_ITEM_ID_PATTERN = /^[A-Za-z0-9._~!=-]+$/;

const GRAPH_PATH_RULES: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly methods: ReadonlySet<string>;
}> = [
  { pattern: /^\/v1\.0\/me$/, methods: new Set(["GET"]) },
  {
    pattern: /^\/v1\.0\/me\/mailFolders\/inbox\/messages$/,
    methods: new Set(["GET"]),
  },
  { pattern: /^\/v1\.0\/me\/sendMail$/, methods: new Set(["POST"]) },
  { pattern: /^\/v1\.0\/me\/calendarView$/, methods: new Set(["GET"]) },
  { pattern: /^\/v1\.0\/me\/events$/, methods: new Set(["POST"]) },
  { pattern: /^\/v1\.0\/me\/drive\/root\/search$/, methods: new Set(["GET"]) },
  {
    pattern: /^\/v1\.0\/me\/drive\/items\/[A-Za-z0-9._~!=-]+(?:\/content)?$/,
    methods: new Set(["GET"]),
  },
];

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function boundDiagnostic(value: string): string {
  return value.length <= MAX_DIAGNOSTIC_CHARS
    ? value
    : value.slice(0, MAX_DIAGNOSTIC_CHARS);
}

export function isAllowedGraphPath(path: string, method = "GET"): boolean {
  const normalized = method.toUpperCase();
  return GRAPH_PATH_RULES.some(
    (rule) => rule.pattern.test(path) && rule.methods.has(normalized),
  );
}

export function isDriveItemId(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_DRIVE_ITEM_ID_LENGTH &&
    DRIVE_ITEM_ID_PATTERN.test(value)
  );
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
