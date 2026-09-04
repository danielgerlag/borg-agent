import type { PluginHttp } from "@borg/plugin-sdk";
import {
  DISCORD_API_BASE,
  MAX_OUTBOUND_CONTENT_LENGTH,
  MAX_RATE_LIMIT_RETRIES,
  MAX_RATE_LIMIT_WAIT_MS,
  MAX_REST_RESPONSE_BYTES,
  isRecord,
  isSnowflake,
  normalizeGatewayUrl,
} from "./protocol";

export type DiscordRestErrorCode =
  | "auth"
  | "forbidden"
  | "not-found"
  | "rate-limited"
  | "invalid"
  | "failed";

/**
 * Every message here is a constant plus a status code. The bot token only ever
 * travels in an `Authorization` header, so it can never reach an error string,
 * a log line, or the kernel audit trail.
 */
export class DiscordRestError extends Error {
  constructor(
    readonly code: DiscordRestErrorCode,
    readonly status: number | undefined,
    message: string,
  ) {
    super(message);
    this.name = "DiscordRestError";
  }

  get fatal(): boolean {
    return this.code === "auth" || this.code === "forbidden";
  }
}

export interface DiscordSessionStartLimit {
  readonly remaining: number;
  readonly resetAfterMs: number;
}

export interface DiscordGatewayDiscovery {
  readonly url: string;
  readonly sessionStartLimit: DiscordSessionStartLimit | undefined;
}

export interface DiscordRestClientOptions {
  readonly http: PluginHttp;
  readonly readToken: () => Promise<string | undefined>;
  readonly sleep?:
    | ((ms: number, signal?: AbortSignal | undefined) => Promise<void>)
    | undefined;
}

const SAFE_PATH = /^\/[A-Za-z0-9/@._-]*$/;

export class DiscordRestClient {
  readonly #http: PluginHttp;
  readonly #readToken: () => Promise<string | undefined>;
  readonly #sleep: (
    ms: number,
    signal?: AbortSignal | undefined,
  ) => Promise<void>;

  constructor(options: DiscordRestClientOptions) {
    this.#http = options.http;
    this.#readToken = options.readToken;
    this.#sleep = options.sleep ?? defaultSleep;
  }

  async verifyBot(signal?: AbortSignal | undefined): Promise<{
    readonly botUserId: string;
    readonly username: string;
  }> {
    const body = await this.#request("/users/@me", { method: "GET" }, signal);
    if (!isRecord(body) || !isSnowflake(body.id)) {
      throw new DiscordRestError(
        "invalid",
        undefined,
        "Discord returned an unusable bot identity",
      );
    }
    const username = typeof body.username === "string" ? body.username : "";
    return { botUserId: body.id, username: username.slice(0, 128) };
  }

  async discoverGateway(
    signal?: AbortSignal | undefined,
  ): Promise<DiscordGatewayDiscovery> {
    const body = await this.#request("/gateway/bot", { method: "GET" }, signal);
    if (!isRecord(body)) {
      throw new DiscordRestError(
        "invalid",
        undefined,
        "Discord returned an unusable gateway descriptor",
      );
    }
    const url = normalizeGatewayUrl(body.url);
    if (url === undefined) {
      throw new DiscordRestError(
        "invalid",
        undefined,
        "Discord returned an unusable gateway url",
      );
    }
    return { url, sessionStartLimit: readSessionStartLimit(body) };
  }

  async createMessage(request: {
    readonly channelId: string;
    readonly content: string;
    readonly signal?: AbortSignal | undefined;
  }): Promise<{ readonly messageId: string }> {
    if (!isSnowflake(request.channelId)) {
      throw new DiscordRestError(
        "invalid",
        undefined,
        "Discord channel id is invalid",
      );
    }
    if (
      typeof request.content !== "string" ||
      request.content.length === 0 ||
      request.content.length > MAX_OUTBOUND_CONTENT_LENGTH
    ) {
      throw new DiscordRestError(
        "invalid",
        undefined,
        `Discord messages must be 1 to ${MAX_OUTBOUND_CONTENT_LENGTH} characters`,
      );
    }
    const body = await this.#request(
      `/channels/${request.channelId}/messages`,
      {
        method: "POST",
        body: JSON.stringify({ content: request.content }),
      },
      request.signal,
    );
    if (!isRecord(body) || !isSnowflake(body.id)) {
      throw new DiscordRestError(
        "invalid",
        undefined,
        "Discord returned an unusable message id",
      );
    }
    return { messageId: body.id };
  }

  async #request(
    path: string,
    init: { readonly method: string; readonly body?: string | undefined },
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    if (!SAFE_PATH.test(path)) {
      throw new DiscordRestError(
        "invalid",
        undefined,
        "Discord request path is invalid",
      );
    }
    const token = await this.#readToken();
    if (typeof token !== "string" || token.length === 0) {
      throw new DiscordRestError(
        "auth",
        undefined,
        "Discord bot token is not saved",
      );
    }
    const url = `${DISCORD_API_BASE}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bot ${token}`,
      Accept: "application/json",
      "User-Agent": "DiscordBot (https://github.com/borg-agent, 0.1.0)",
    };
    if (init.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      try {
        response = await this.#http.fetch(url, {
          method: init.method,
          headers,
          ...(init.body !== undefined ? { body: init.body } : {}),
          ...(signal ? { signal } : {}),
        });
      } catch {
        throw new DiscordRestError(
          "failed",
          undefined,
          signal?.aborted
            ? "Discord request was cancelled"
            : "Discord request failed",
        );
      }

      if (response.status === 429) {
        const retryAfterMs = await readRetryAfter(response);
        if (
          attempt >= MAX_RATE_LIMIT_RETRIES ||
          retryAfterMs > MAX_RATE_LIMIT_WAIT_MS
        ) {
          throw new DiscordRestError(
            "rate-limited",
            429,
            "Discord rate limited this request",
          );
        }
        await this.#sleep(retryAfterMs, signal);
        if (signal?.aborted === true) {
          throw new DiscordRestError(
            "failed",
            undefined,
            "Discord request was cancelled",
          );
        }
        continue;
      }

      if (!response.ok) {
        await discardBody(response);
        throw errorForStatus(response.status);
      }

      const text = await readBoundedText(response);
      if (text.length === 0) {
        return undefined;
      }
      try {
        return JSON.parse(text);
      } catch {
        throw new DiscordRestError(
          "invalid",
          response.status,
          "Discord returned a malformed response",
        );
      }
    }
  }
}

function errorForStatus(status: number): DiscordRestError {
  if (status === 401) {
    return new DiscordRestError("auth", status, "Discord rejected the bot token");
  }
  if (status === 403) {
    return new DiscordRestError(
      "forbidden",
      status,
      "Discord denied access to this resource",
    );
  }
  if (status === 404) {
    return new DiscordRestError(
      "not-found",
      status,
      "Discord could not find this resource",
    );
  }
  return new DiscordRestError(
    "failed",
    status,
    `Discord request failed with status ${status}`,
  );
}

function readSessionStartLimit(
  body: Record<string, unknown>,
): DiscordSessionStartLimit | undefined {
  const limit = body.session_start_limit;
  if (!isRecord(limit)) {
    return undefined;
  }
  const remaining = limit.remaining;
  const resetAfter = limit.reset_after;
  if (typeof remaining !== "number" || !Number.isFinite(remaining)) {
    return undefined;
  }
  const resetAfterMs =
    typeof resetAfter === "number" && Number.isFinite(resetAfter)
      ? Math.max(0, Math.floor(resetAfter))
      : 0;
  return {
    remaining: Math.max(0, Math.floor(remaining)),
    resetAfterMs,
  };
}

async function readRetryAfter(response: Response): Promise<number> {
  let seconds: number | undefined;
  try {
    const text = await readBoundedText(response);
    const parsed: unknown = text.length > 0 ? JSON.parse(text) : undefined;
    if (isRecord(parsed) && typeof parsed.retry_after === "number") {
      seconds = parsed.retry_after;
    }
  } catch {
    seconds = undefined;
  }
  if (seconds === undefined) {
    const header = response.headers.get("retry-after");
    const parsed = header === null ? Number.NaN : Number.parseFloat(header);
    seconds = Number.isFinite(parsed) ? parsed : 1;
  }
  if (!Number.isFinite(seconds) || seconds < 0) {
    return 1_000;
  }
  return Math.min(Math.ceil(seconds * 1_000), MAX_RATE_LIMIT_WAIT_MS + 1);
}

async function readBoundedText(response: Response): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    if (text.length > MAX_REST_RESPONSE_BYTES) {
      throw new DiscordRestError(
        "invalid",
        response.status,
        "Discord response is too large",
      );
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > MAX_REST_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new DiscordRestError(
          "invalid",
          response.status,
          "Discord response is too large",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new DiscordRestError(
      "invalid",
      response.status,
      "Discord response is not valid UTF-8",
    );
  }
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
  }
}

function defaultSleep(
  ms: number,
  signal?: AbortSignal | undefined,
): Promise<void> {
  return new Promise<void>((resolve) => {
    const finish = (): void => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      finish();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
    }
  });
}
