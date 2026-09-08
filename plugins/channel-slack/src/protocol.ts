export const SLACK_ADAPTER_ID = "borg.channel.slack";
export const SLACK_BOT_TOKEN_SECRET_KEY = "botToken";
export const SLACK_APP_TOKEN_SECRET_KEY = "appToken";

export const SLACK_API_BASE = "https://slack.com/api";
export const SLACK_AUTH_TEST_METHOD = "auth.test";
export const SLACK_CONNECTIONS_OPEN_METHOD = "apps.connections.open";
export const SLACK_POST_MESSAGE_METHOD = "chat.postMessage";

export const CHANNEL_ID_PATTERN = /^[CGD][A-Z0-9]{8,}$/;

export const MAX_CHANNEL_ID_LENGTH = 32;
export const MAX_ALLOWED_CHANNEL_IDS = 128;
export const MIN_ALLOWED_CHANNEL_IDS = 1;
export const MAX_ENVELOPE_CHARS = 262_144;
export const MAX_REST_RESPONSE_BYTES = 65_536;
export const MAX_OUTBOUND_CONTENT_LENGTH = 4_000;
export const MAX_INBOUND_CONTENT_LENGTH = 4_000;
export const MAX_ENVELOPE_ID_LENGTH = 128;
export const MAX_USER_ID_LENGTH = 32;
export const MAX_TS_LENGTH = 64;
export const MAX_AUTHOR_NAME_LENGTH = 128;
export const MAX_DIAGNOSTIC_CHARS = 200;
export const MAX_SOCKET_URL_LENGTH = 2_048;
export const MAX_ENVELOPE_TYPE_LENGTH = 64;

export const SOCKET_HELLO_TIMEOUT_MS = 15_000;
export const STABLE_SESSION_MS = 30_000;

export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_CAP_MS = 60_000;
export const MAX_BACKOFF_EXPONENT = 6;
export const MIN_RECONNECT_DELAY_MS = 100;

export const MAX_RATE_LIMIT_RETRIES = 2;
export const MAX_RATE_LIMIT_WAIT_MS = 60_000;

export const CLOSE_NORMAL = 1_000;
export const CLOSE_ABANDON = 4_000;

const SLACK_SOCKET_HOST = /(?:^|\.)slack\.com$/;

export interface SocketEnvelope {
  readonly type: string;
  readonly envelopeId: string | undefined;
  readonly payload: unknown;
}

export interface SlackInboundMessage {
  readonly ts: string;
  readonly channelId: string;
  readonly userId: string;
  readonly userName: string | undefined;
  readonly text: string;
  readonly threadTs: string | undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isSlackChannelId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_CHANNEL_ID_LENGTH &&
    CHANNEL_ID_PATTERN.test(value)
  );
}

export function encodeAck(envelopeId: string): string {
  return JSON.stringify({ envelope_id: envelopeId });
}

export function encodePong(): string {
  return JSON.stringify({ type: "pong" });
}

export function parseSocketEnvelope(raw: string): SocketEnvelope | undefined {
  if (typeof raw !== "string" || raw.length === 0) {
    return undefined;
  }
  if (raw.length > MAX_ENVELOPE_CHARS) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) {
    return undefined;
  }
  const type = parsed.type;
  if (
    typeof type !== "string" ||
    type.length === 0 ||
    type.length > MAX_ENVELOPE_TYPE_LENGTH
  ) {
    return undefined;
  }
  const envelopeId = parsed.envelope_id;
  if (
    envelopeId !== undefined &&
    (typeof envelopeId !== "string" ||
      envelopeId.length === 0 ||
      envelopeId.length > MAX_ENVELOPE_ID_LENGTH ||
      /[\s\0]/.test(envelopeId))
  ) {
    return undefined;
  }
  return {
    type,
    envelopeId: typeof envelopeId === "string" ? envelopeId : undefined,
    payload: parsed.payload,
  };
}

export function parseMessageEvent(
  payload: unknown,
): SlackInboundMessage | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  const event = payload.event;
  if (!isRecord(event)) {
    return undefined;
  }
  if (event.type !== "message") {
    return undefined;
  }
  if (event.bot_id !== undefined) {
    return undefined;
  }
  if (event.subtype !== undefined) {
    return undefined;
  }
  if (!isSlackChannelId(event.channel)) {
    return undefined;
  }
  const userId = event.user;
  if (
    typeof userId !== "string" ||
    userId.length === 0 ||
    userId.length > MAX_USER_ID_LENGTH ||
    /[\s\0]/.test(userId)
  ) {
    return undefined;
  }
  const text = event.text;
  if (text !== undefined && typeof text !== "string") {
    return undefined;
  }
  if (typeof text === "string" && text.length > MAX_INBOUND_CONTENT_LENGTH) {
    return undefined;
  }
  const ts = event.ts;
  if (
    typeof ts !== "string" ||
    ts.length === 0 ||
    ts.length > MAX_TS_LENGTH ||
    /[\s\0]/.test(ts)
  ) {
    return undefined;
  }
  const threadTs = event.thread_ts;
  if (
    threadTs !== undefined &&
    (typeof threadTs !== "string" ||
      threadTs.length === 0 ||
      threadTs.length > MAX_TS_LENGTH ||
      /[\s\0]/.test(threadTs))
  ) {
    return undefined;
  }
  const profile = isRecord(event.user_profile) ? event.user_profile : undefined;
  const displayName =
    profile && typeof profile.display_name === "string"
      ? profile.display_name
      : undefined;
  const profileName =
    profile && typeof profile.name === "string" ? profile.name : undefined;
  const userNameSource =
    displayName && displayName.length > 0
      ? displayName
      : profileName && profileName.length > 0
        ? profileName
        : undefined;
  const userName =
    userNameSource === undefined
      ? undefined
      : userNameSource.slice(0, MAX_AUTHOR_NAME_LENGTH);
  return {
    ts,
    channelId: event.channel,
    userId,
    userName,
    text: typeof text === "string" ? text : "",
    threadTs: typeof threadTs === "string" ? threadTs : undefined,
  };
}

/**
 * Accepts only credential-free `wss:` Slack URLs so a hostile
 * apps.connections.open payload cannot redirect the socket at another origin.
 */
export function normalizeSocketUrl(candidate: unknown): string | undefined {
  if (
    typeof candidate !== "string" ||
    candidate.length === 0 ||
    candidate.length > MAX_SOCKET_URL_LENGTH
  ) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return undefined;
  }
  if (url.protocol !== "wss:") {
    return undefined;
  }
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    (url.port !== "" && url.port !== "443")
  ) {
    return undefined;
  }
  if (url.hostname.length === 0 || !SLACK_SOCKET_HOST.test(url.hostname)) {
    return undefined;
  }
  return url.href;
}

export function boundDiagnostic(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length <= MAX_DIAGNOSTIC_CHARS
    ? collapsed
    : `${collapsed.slice(0, MAX_DIAGNOSTIC_CHARS)}…`;
}
