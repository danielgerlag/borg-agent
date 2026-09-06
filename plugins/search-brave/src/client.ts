import {
  webSearchOutputSchema,
  type WebSearchOutput,
} from "@borg/contracts";

export const BRAVE_PRODUCTION_ENDPOINT =
  "https://api.search.brave.com/res/v1/web/search";
export const BRAVE_TIMEOUT_MS = 15_000;
export const BRAVE_SECRET_KEY = "apiKey";
export const BRAVE_DEFAULT_MAX_RESULTS = 5;

export const SAFE_BRAVE_ERRORS = Object.freeze({
  cancelled: "The Brave Search request was cancelled.",
  timeout: "The Brave Search request timed out.",
  missingKey: "Brave Search is not connected. Add an API key in Settings.",
  rejected: "Brave Search rejected the request.",
  protocol: "Brave Search returned an unreadable response.",
  invalidEndpoint: "Brave Search endpoint override is not allowed.",
});

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return LOOPBACK_HOSTS.has(host) || /^127(?:\.\d{1,3}){3}$/.test(host);
}

export function resolveBraveEndpoint(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.BORG_BRAVE_ENDPOINT?.trim();
  if (!override) {
    return BRAVE_PRODUCTION_ENDPOINT;
  }
  if (env.BORG_E2E !== "1") {
    throw new Error(SAFE_BRAVE_ERRORS.invalidEndpoint);
  }
  let parsed: URL;
  try {
    parsed = new URL(override);
  } catch {
    throw new Error(SAFE_BRAVE_ERRORS.invalidEndpoint);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(SAFE_BRAVE_ERRORS.invalidEndpoint);
  }
  if (!isLoopbackHostname(parsed.hostname)) {
    throw new Error(SAFE_BRAVE_ERRORS.invalidEndpoint);
  }
  return parsed.toString();
}

export interface BraveSearchRequest {
  readonly query: string;
  readonly maxResults?: number | undefined;
}

export interface BraveClientOptions {
  readonly fetchImpl?: typeof fetch;
  readonly endpoint?: string;
  readonly timeoutMs?: number;
  getApiKey(): Promise<string | undefined>;
}

export class BraveClient {
  readonly #fetch: typeof fetch;
  readonly #endpoint: string;
  readonly #timeoutMs: number;
  readonly #getApiKey: () => Promise<string | undefined>;

  constructor(options: BraveClientOptions) {
    this.#fetch = options.fetchImpl ?? fetch;
    this.#endpoint = options.endpoint ?? resolveBraveEndpoint();
    this.#timeoutMs = options.timeoutMs ?? BRAVE_TIMEOUT_MS;
    this.#getApiKey = options.getApiKey;
  }

  async search(
    input: BraveSearchRequest,
    signal?: AbortSignal,
  ): Promise<WebSearchOutput> {
    const query = input.query.trim();
    const maxResults = input.maxResults ?? BRAVE_DEFAULT_MAX_RESULTS;
    const apiKey = await this.#getApiKey();
    if (!apiKey) {
      throw new Error(SAFE_BRAVE_ERRORS.missingKey);
    }
    const url = new URL(this.#endpoint);
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(maxResults));
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": apiKey,
        },
        redirect: "error",
        signal: combined,
      });
    } catch (error) {
      throw braveErrorFromUnknown(error, timeout, signal);
    }
    if (!response.ok) {
      await response.arrayBuffer().catch(() => undefined);
      throw new Error(SAFE_BRAVE_ERRORS.rejected);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error(SAFE_BRAVE_ERRORS.protocol);
    }
    return parseBraveResponse(payload, query);
  }
}

export function parseBraveResponse(
  payload: unknown,
  query: string,
): WebSearchOutput {
  if (!payload || typeof payload !== "object") {
    throw new Error(SAFE_BRAVE_ERRORS.protocol);
  }
  const web = (payload as { readonly web?: unknown }).web;
  const results =
    web && typeof web === "object"
      ? (web as { readonly results?: unknown }).results
      : undefined;
  if (results !== undefined && !Array.isArray(results)) {
    throw new Error(SAFE_BRAVE_ERRORS.protocol);
  }
  const hits = (results ?? []).flatMap((item) => {
    if (!item || typeof item !== "object") {
      return [];
    }
    const record = item as Record<string, unknown>;
    if (typeof record.title !== "string" || typeof record.url !== "string") {
      return [];
    }
    const title = record.title.trim();
    const url = record.url.trim();
    if (title.length === 0 || url.length === 0) {
      return [];
    }
    try {
      return [
        {
          title,
          url: new URL(url).toString(),
          snippet:
            typeof record.description === "string" ? record.description : "",
        },
      ];
    } catch {
      return [];
    }
  });
  return webSearchOutputSchema.parse({ query, hits });
}

function braveErrorFromUnknown(
  error: unknown,
  timeout: AbortSignal,
  signal: AbortSignal | undefined,
): Error {
  if (timeout.aborted && !signal?.aborted) {
    return new Error(SAFE_BRAVE_ERRORS.timeout);
  }
  if (
    (error instanceof Error && error.name === "AbortError") ||
    (error instanceof DOMException && error.name === "AbortError")
  ) {
    return new Error(SAFE_BRAVE_ERRORS.cancelled);
  }
  if (
    error instanceof Error &&
    Object.values(SAFE_BRAVE_ERRORS).includes(
      error.message as (typeof SAFE_BRAVE_ERRORS)[keyof typeof SAFE_BRAVE_ERRORS],
    )
  ) {
    return error;
  }
  return new Error(SAFE_BRAVE_ERRORS.protocol);
}
