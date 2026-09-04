export const DISCORD_ADAPTER_ID = "borg.channel.discord";
export const DISCORD_TOKEN_SECRET_KEY = "botToken";

// The REST origin is a constant so no configuration path can retarget an
// authenticated request at another host.
export const DISCORD_API_BASE = "https://discord.com/api/v10";
export const DISCORD_GATEWAY_VERSION = 10;
export const DISCORD_GATEWAY_ENCODING = "json";

export const INTENT_GUILDS = 1;
export const INTENT_GUILD_MESSAGES = 512;
export const INTENT_DIRECT_MESSAGES = 4_096;
export const INTENT_MESSAGE_CONTENT = 32_768;
export const GATEWAY_INTENTS =
  INTENT_GUILDS |
  INTENT_GUILD_MESSAGES |
  INTENT_DIRECT_MESSAGES |
  INTENT_MESSAGE_CONTENT;

export const IDENTIFY_PROPERTIES = Object.freeze({
  os: "borg",
  browser: "borg-agent",
  device: "borg-agent",
});

export const OP_DISPATCH = 0;
export const OP_HEARTBEAT = 1;
export const OP_IDENTIFY = 2;
export const OP_RESUME = 6;
export const OP_RECONNECT = 7;
export const OP_INVALID_SESSION = 9;
export const OP_HELLO = 10;
export const OP_HEARTBEAT_ACK = 11;

export const MIN_HEARTBEAT_INTERVAL_MS = 1_000;
export const MAX_HEARTBEAT_INTERVAL_MS = 120_000;
export const GATEWAY_HELLO_TIMEOUT_MS = 15_000;
export const GATEWAY_READY_TIMEOUT_MS = 30_000;

export const MAX_GATEWAY_FRAME_CHARS = 262_144;
export const MAX_REST_RESPONSE_BYTES = 65_536;
export const MAX_OUTBOUND_CONTENT_LENGTH = 2_000;
export const MAX_INBOUND_CONTENT_LENGTH = 4_000;
export const MAX_SESSION_ID_LENGTH = 256;
export const MAX_RESUME_URL_LENGTH = 512;
export const MAX_AUTHOR_NAME_LENGTH = 128;
export const MAX_DIAGNOSTIC_CHARS = 200;

export const MAX_ALLOWED_GUILD_IDS = 64;
export const MAX_ALLOWED_CHANNEL_IDS = 128;
export const MIN_ALLOWED_CHANNEL_IDS = 1;

export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_CAP_MS = 60_000;
export const MAX_BACKOFF_EXPONENT = 6;
export const MIN_RECONNECT_DELAY_MS = 100;
export const INVALID_SESSION_MIN_DELAY_MS = 1_000;
export const INVALID_SESSION_MAX_DELAY_MS = 5_000;

export const MAX_RATE_LIMIT_RETRIES = 2;
export const MAX_RATE_LIMIT_WAIT_MS = 60_000;
export const MAX_SESSION_START_WAIT_MS = 60_000;

export const CLOSE_NORMAL = 1_000;
// Discord keeps a session resumable when the client closes with a non-1000
// code, so every voluntary teardown that wants to resume uses this one.
export const CLOSE_ABANDON = 4_000;
export const CLOSE_ABNORMAL = 1_006;

export const FATAL_CLOSE_CODES: ReadonlySet<number> = new Set([
  4_004, 4_010, 4_011, 4_012, 4_013, 4_014,
]);
export const RESUMABLE_CLOSE_CODES: ReadonlySet<number> = new Set([
  4_000, 4_001, 4_002, 4_003, 4_005, 4_006, 4_008,
]);
export const NON_RESUMABLE_CLOSE_CODES: ReadonlySet<number> = new Set([
  4_007, 4_009,
]);

export const SNOWFLAKE_PATTERN = /^[0-9]{17,20}$/;
const DISCORD_GATEWAY_HOST =
  /^gateway(?:-[a-z0-9-]+)?\.discord\.gg$/;

export interface GatewayFrame {
  readonly op: number;
  readonly s: number | null;
  readonly t: string | null;
  readonly d: unknown;
}

export type OutboundFrame =
  | { readonly op: typeof OP_HEARTBEAT; readonly d: number | null }
  | {
      readonly op: typeof OP_IDENTIFY;
      readonly d: {
        readonly intents: number;
        readonly properties: {
          readonly os: string;
          readonly browser: string;
          readonly device: string;
        };
      };
      readonly withToken: true;
    }
  | {
      readonly op: typeof OP_RESUME;
      readonly d: { readonly session_id: string; readonly seq: number };
      readonly withToken: true;
    };

export interface DiscordInboundMessage {
  readonly id: string;
  readonly channelId: string;
  readonly authorId: string;
  readonly authorName: string;
  readonly content: string;
  readonly guildId: string | undefined;
  readonly threadId: string | undefined;
}

export interface ReadyPayload {
  readonly sessionId: string;
  readonly botUserId: string;
  readonly resumeGatewayUrl: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isSnowflake(value: unknown): value is string {
  return typeof value === "string" && SNOWFLAKE_PATTERN.test(value);
}

export function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

export function buildIdentifyFrame(): OutboundFrame {
  return {
    op: OP_IDENTIFY,
    d: { intents: GATEWAY_INTENTS, properties: IDENTIFY_PROPERTIES },
    withToken: true,
  };
}

export function buildResumeFrame(
  sessionId: string,
  sequence: number,
): OutboundFrame {
  return {
    op: OP_RESUME,
    d: { session_id: sessionId, seq: sequence },
    withToken: true,
  };
}

export function buildHeartbeatFrame(sequence: number | null): OutboundFrame {
  return { op: OP_HEARTBEAT, d: sequence };
}

/**
 * Serializes an outbound frame, injecting the bot token only for the frames
 * that authenticate. The reducer never sees the token.
 */
export function encodeOutboundFrame(
  frame: OutboundFrame,
  token: string,
): string {
  if (frame.op === OP_HEARTBEAT) {
    return JSON.stringify({ op: frame.op, d: frame.d });
  }
  return JSON.stringify({
    op: frame.op,
    d: { ...frame.d, token },
  });
}

export function parseGatewayFrame(raw: string): GatewayFrame | undefined {
  if (typeof raw !== "string" || raw.length === 0) {
    return undefined;
  }
  if (raw.length > MAX_GATEWAY_FRAME_CHARS) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !isSafeInteger(parsed.op) || parsed.op < 0) {
    return undefined;
  }
  const sequence = parsed.s;
  if (
    sequence !== undefined &&
    sequence !== null &&
    (!isSafeInteger(sequence) || sequence < 0)
  ) {
    return undefined;
  }
  const name = parsed.t;
  if (
    name !== undefined &&
    name !== null &&
    (typeof name !== "string" || name.length === 0 || name.length > 64)
  ) {
    return undefined;
  }
  return {
    op: parsed.op,
    s: typeof sequence === "number" ? sequence : null,
    t: typeof name === "string" ? name : null,
    d: parsed.d,
  };
}

export function parseHelloInterval(data: unknown): number | undefined {
  if (!isRecord(data)) {
    return undefined;
  }
  const interval = data.heartbeat_interval;
  if (
    !isSafeInteger(interval) ||
    interval < MIN_HEARTBEAT_INTERVAL_MS ||
    interval > MAX_HEARTBEAT_INTERVAL_MS
  ) {
    return undefined;
  }
  return interval;
}

/**
 * Accepts only credential-free `wss:` gateway URLs so a hostile READY payload
 * cannot redirect the next resume at an attacker-controlled origin.
 */
export function normalizeGatewayUrl(candidate: unknown): string | undefined {
  if (
    typeof candidate !== "string" ||
    candidate.length === 0 ||
    candidate.length > MAX_RESUME_URL_LENGTH
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
  if (url.hostname.length === 0) {
    return undefined;
  }
  if (!DISCORD_GATEWAY_HOST.test(url.hostname)) {
    return undefined;
  }
  return `${url.origin}${url.pathname === "/" ? "" : url.pathname}`;
}

export function withGatewayQuery(url: string): string {
  return `${url}?v=${DISCORD_GATEWAY_VERSION}&encoding=${DISCORD_GATEWAY_ENCODING}`;
}

export function parseReadyPayload(data: unknown): ReadyPayload | undefined {
  if (!isRecord(data)) {
    return undefined;
  }
  const sessionId = data.session_id;
  if (
    typeof sessionId !== "string" ||
    sessionId.length === 0 ||
    sessionId.length > MAX_SESSION_ID_LENGTH ||
    /[\s\0]/.test(sessionId)
  ) {
    return undefined;
  }
  const user = data.user;
  if (!isRecord(user) || !isSnowflake(user.id)) {
    return undefined;
  }
  const resumeGatewayUrl = normalizeGatewayUrl(data.resume_gateway_url);
  if (resumeGatewayUrl === undefined) {
    return undefined;
  }
  return { sessionId, botUserId: user.id, resumeGatewayUrl };
}

export function parseMessageCreate(
  data: unknown,
): DiscordInboundMessage | undefined {
  if (!isRecord(data)) {
    return undefined;
  }
  if (!isSnowflake(data.id) || !isSnowflake(data.channel_id)) {
    return undefined;
  }
  const author = data.author;
  if (!isRecord(author) || !isSnowflake(author.id)) {
    return undefined;
  }
  const content = data.content;
  if (
    typeof content !== "string" ||
    content.length > MAX_INBOUND_CONTENT_LENGTH
  ) {
    return undefined;
  }
  if (data.guild_id !== undefined && !isSnowflake(data.guild_id)) {
    return undefined;
  }
  const guildId = isSnowflake(data.guild_id) ? data.guild_id : undefined;
  const thread = data.thread;
  const threadId =
    isRecord(thread) && isSnowflake(thread.id) ? thread.id : undefined;
  const username = author.username;
  const authorName =
    typeof username === "string" && username.length > 0
      ? username.slice(0, MAX_AUTHOR_NAME_LENGTH)
      : author.id;
  return {
    id: data.id,
    channelId: data.channel_id,
    authorId: author.id,
    authorName,
    content,
    guildId,
    threadId,
  };
}

export function isBotAuthor(data: unknown): boolean {
  if (!isRecord(data)) {
    return false;
  }
  const author = data.author;
  return isRecord(author) && author.bot === true;
}

export function boundDiagnostic(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length <= MAX_DIAGNOSTIC_CHARS
    ? collapsed
    : `${collapsed.slice(0, MAX_DIAGNOSTIC_CHARS)}…`;
}
