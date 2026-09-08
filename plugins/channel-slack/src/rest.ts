import type { PluginHttp } from "@borg/plugin-sdk";
import {
  MAX_OUTBOUND_CONTENT_LENGTH,
  MAX_RATE_LIMIT_RETRIES,
  MAX_RATE_LIMIT_WAIT_MS,
  MAX_REST_RESPONSE_BYTES,
  SLACK_API_BASE,
  SLACK_AUTH_TEST_METHOD,
  SLACK_CONNECTIONS_OPEN_METHOD,
  SLACK_POST_MESSAGE_METHOD,
  isRecord,
  isSlackChannelId,
  normalizeSocketUrl,
} from "./protocol";

export type SlackRestErrorCode =
  | "auth"
  | "forbidden"
  | "not-found"
  | "rate-limited"
  | "invalid"
  | "failed";

export type SlackTokenKind = "bot" | "app";

export class SlackRestError extends Error {
  constructor(
    readonly code: SlackRestErrorCode,
    readonly status: number | undefined,
    message: string,
  ) {
    super(message);
    this.name = "SlackRestError";
  }

  get fatal(): boolean {
    return this.code === "auth" || this.code === "forbidden";
  }
}

export interface SlackRestClientOptions {
  readonly http: PluginHttp;
  readonly readBotToken: () => Promise<string | undefined>;
  readonly readAppToken: () => Promise<string | undefined>;
  readonly sleep?:
    | ((ms: number, signal?: AbortSignal | undefined) => Promise<void>)
    | undefined;
}

const AUTH_ERROR_CODES: ReadonlySet<string> = new Set([
  "invalid_auth",
  "not_authed",
  "token_revoked",
  "account_inactive",
  "invalid_token",
]);

export class SlackRestClient {
  readonly #http: PluginHttp;
  readonly #readBotToken: () => Promise<string | undefined>;
  readonly #readAppToken: () => Promise<string | undefined>;
  readonly #sleep: (
    ms: number,
    signal?: AbortSignal | undefined,
  ) => Promise<void>;

  constructor(options: SlackRestClientOptions) {
    this.#http = options.http;
    this.#readBotToken = options.readBotToken;
    this.#readAppToken = options.readAppToken;
    this.#sleep = options.sleep ?? defaultSleep;
  }

  async authTest(signal?: AbortSignal | undefined): Promise<{
    readonly botUserId: string;
  }> {
    const body = await this.#request(
      SLACK_AUTH_TEST_METHOD,
      "bot",
      {
        method: "POST",
        body: "{}",
        contentType: "application/json",
      },
      signal,
    );
    if (!isRecord(body) || typeof body.user_id !== "string") {
      throw new SlackRestError(
        "invalid",
        undefined,
        "Slack returned an unusable bot identity",
      );
    }
    const botUserId = body.user_id.trim();
    if (botUserId.length === 0) {
      throw new SlackRestError(
        "invalid",
        undefined,
        "Slack returned an unusable bot identity",
      );
    }
    return { botUserId: botUserId.slice(0, 32) };
  }

  async openConnection(
    signal?: AbortSignal | undefined,
  ): Promise<{ readonly url: string }> {
    const body = await this.#request(
      SLACK_CONNECTIONS_OPEN_METHOD,
      "app",
      {
        method: "POST",
        contentType: "application/x-www-form-urlencoded",
      },
      signal,
    );
    if (!isRecord(body)) {
      throw new SlackRestError(
        "invalid",
        undefined,
        "Slack returned an unusable Socket Mode url",
      );
    }
    const url = normalizeSocketUrl(body.url);
    if (url === undefined) {
      throw new SlackRestError(
        "invalid",
        undefined,
        "Slack returned an unusable Socket Mode url",
      );
    }
    return { url };
  }

  async postMessage(request: {
    readonly channel: string;
    readonly text: string;
    readonly signal?: AbortSignal | undefined;
  }): Promise<{ readonly ts: string }> {
    if (!isSlackChannelId(request.channel)) {
      throw new SlackRestError(
        "invalid",
        undefined,
        "Slack channel id is invalid",
      );
    }
    if (
      typeof request.text !== "string" ||
      request.text.length === 0 ||
      request.text.length > MAX_OUTBOUND_CONTENT_LENGTH
    ) {
      throw new SlackRestError(
        "invalid",
        undefined,
        `Slack messages must be 1 to ${MAX_OUTBOUND_CONTENT_LENGTH} characters`,
      );
    }
    const body = await this.#request(
      SLACK_POST_MESSAGE_METHOD,
      "bot",
      {
        method: "POST",
        body: JSON.stringify({
          channel: request.channel,
          text: request.text,
        }),
        contentType: "application/json",
      },
      request.signal,
    );
    if (!isRecord(body) || typeof body.ts !== "string" || body.ts.length === 0) {
      throw new SlackRestError(
        "invalid",
        undefined,
        "Slack returned an unusable message timestamp",
      );
    }
    return { ts: body.ts.slice(0, 64) };
  }

  async #request(
    method: string,
    tokenKind: SlackTokenKind,
    init: {
      readonly method: string;
      readonly body?: string | undefined;
      readonly contentType?: string | undefined;
    },
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    const token = await this.#readToken(tokenKind);
    if (typeof token !== "string" || token.length === 0) {
      throw new SlackRestError(
        "auth",
        undefined,
        tokenKind === "bot"
          ? "Slack bot token is not saved"
          : "Slack app-level token is not saved",
      );
    }
    const url = `${SLACK_API_BASE}/${method}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    };
    if (init.contentType !== undefined) {
      headers["Content-Type"] = init.contentType;
    }

    for (let attempt = 0; ; attempt += 1) {
      let response: Response;
      try {
        response = await this.#http.fetch(url, {
          method: init.method,
          headers,
          redirect: "error",
          ...(init.body !== undefined ? { body: init.body } : {}),
          ...(signal ? { signal } : {}),
        });
      } catch {
        throw new SlackRestError(
          "failed",
          undefined,
          signal?.aborted
            ? "Slack request was cancelled"
            : "Slack request failed",
        );
      }

      if (response.status === 429) {
        const retryAfterMs = await readRetryAfter(response);
        if (
          attempt >= MAX_RATE_LIMIT_RETRIES ||
          retryAfterMs > MAX_RATE_LIMIT_WAIT_MS
        ) {
          throw new SlackRestError(
            "rate-limited",
            429,
            "Slack rate limited this request",
          );
        }
        await this.#sleep(retryAfterMs, signal);
        if (signal?.aborted === true) {
          throw new SlackRestError(
            "failed",
            undefined,
            "Slack request was cancelled",
          );
        }
        continue;
      }

      if (!response.ok) {
        await discardBody(response);
        throw errorForStatus(response.status, tokenKind);
      }

      const text = await readBoundedText(response);
      if (text.length === 0) {
        throw new SlackRestError(
          "invalid",
          response.status,
          "Slack returned a malformed response",
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new SlackRestError(
          "invalid",
          response.status,
          "Slack returned a malformed response",
        );
      }
      if (!isRecord(parsed) || parsed.ok !== true) {
        const slackError =
          isRecord(parsed) && typeof parsed.error === "string"
            ? parsed.error
            : undefined;
        throw errorForSlackCode(slackError, tokenKind, response.status);
      }
      return parsed;
    }
  }

  async #readToken(kind: SlackTokenKind): Promise<string | undefined> {
    return kind === "bot" ? this.#readBotToken() : this.#readAppToken();
  }
}

function errorForStatus(
  status: number,
  tokenKind: SlackTokenKind,
): SlackRestError {
  if (status === 401) {
    return new SlackRestError(
      "auth",
      status,
      tokenKind === "bot"
        ? "Slack rejected the bot token"
        : "Slack rejected the app token",
    );
  }
  if (status === 403) {
    return new SlackRestError(
      "forbidden",
      status,
      "Slack denied access to this resource",
    );
  }
  if (status === 404) {
    return new SlackRestError(
      "not-found",
      status,
      "Slack could not find this resource",
    );
  }
  return new SlackRestError(
    "failed",
    status,
    `Slack request failed with status ${status}`,
  );
}

function errorForSlackCode(
  code: string | undefined,
  tokenKind: SlackTokenKind,
  status: number | undefined,
): SlackRestError {
  if (code !== undefined && AUTH_ERROR_CODES.has(code)) {
    return new SlackRestError(
      "auth",
      status,
      tokenKind === "bot"
        ? "Slack rejected the bot token"
        : "Slack rejected the app token",
    );
  }
  if (code === "missing_scope" || code === "not_allowed_token_type") {
    return new SlackRestError(
      "forbidden",
      status,
      "Slack denied access to this resource",
    );
  }
  if (code === "channel_not_found") {
    return new SlackRestError(
      "not-found",
      status,
      "Slack could not find this resource",
    );
  }
  return new SlackRestError("failed", status, "Slack request failed");
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
      throw new SlackRestError(
        "invalid",
        response.status,
        "Slack response is too large",
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
        throw new SlackRestError(
          "invalid",
          response.status,
          "Slack response is too large",
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
    throw new SlackRestError(
      "invalid",
      response.status,
      "Slack response is not valid UTF-8",
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
