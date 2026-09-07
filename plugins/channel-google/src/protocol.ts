export const GOOGLE_ADAPTER_ID = "borg.channel.google";
export const GMAIL_API_BASE = "https://gmail.googleapis.com";
export const GOOGLE_APIS_BASE = "https://www.googleapis.com";
export const GOOGLE_AUTHORIZATION_ENDPOINT =
  "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOCATION_ENDPOINT = "https://oauth2.googleapis.com/revoke";
export const GOOGLE_SCOPES = Object.freeze([
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/drive.readonly",
]);
export const GOOGLE_LOOPBACK_HOST = "127.0.0.1" as const;

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
export const MAX_MESSAGE_ID_LENGTH = 256;
export const MAX_DRIVE_SEARCH_QUERY = 200;
export const MAX_DRIVE_ITEM_ID_LENGTH = 256;
export const MAX_DRIVE_TEXT_CHARS = 8_000;
export const CALENDAR_DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const CALENDAR_DEFAULT_MAX_RESULTS = 10;
export const DRIVE_ITEM_ID_PATTERN = /^[A-Za-z0-9._~!=-]+$/;

export const EMAIL_PATTERN =
  /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;

const PROFILE_PATH = /^\/gmail\/v1\/users\/me\/profile$/;
const MESSAGES_PATH = /^\/gmail\/v1\/users\/me\/messages$/;
const SEND_PATH = /^\/gmail\/v1\/users\/me\/messages\/send$/;
const MESSAGE_PATH = /^\/gmail\/v1\/users\/me\/messages\/[A-Za-z0-9_-]{1,256}$/;
const GOOGLE_APIS_PATH_RULES: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly methods: ReadonlySet<string>;
}> = [
  {
    pattern: /^\/calendar\/v3\/calendars\/primary\/events$/,
    methods: new Set(["GET", "POST"]),
  },
  { pattern: /^\/drive\/v3\/files$/, methods: new Set(["GET"]) },
  {
    pattern: /^\/drive\/v3\/files\/[A-Za-z0-9._~!=-]+$/,
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

export function isAllowedGmailPath(path: string): boolean {
  return (
    PROFILE_PATH.test(path) ||
    MESSAGES_PATH.test(path) ||
    SEND_PATH.test(path) ||
    MESSAGE_PATH.test(path)
  );
}

export function isAllowedGoogleApisPath(path: string, method = "GET"): boolean {
  const normalized = method.toUpperCase();
  return GOOGLE_APIS_PATH_RULES.some(
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
