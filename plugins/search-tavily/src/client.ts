import {
  webSearchOutputSchema,
  type WebSearchOutput,
} from "@borg/contracts";

export const TAVILY_PRODUCTION_ENDPOINT = "https://api.tavily.com/search";
export const TAVILY_TIMEOUT_MS = 15_000;
export const TAVILY_SECRET_KEY = "apiKey";
export const TAVILY_DEFAULT_MAX_RESULTS = 5;

export const SAFE_TAVILY_ERRORS = Object.freeze({
  cancelled: "The Tavily request was cancelled.",
  timeout: "The Tavily request timed out.",
  missingKey: "Tavily is not connected. Add an API key in Settings.",
  rejected: "Tavily rejected the request.",
  protocol: "Tavily returned an unreadable response.",
  invalidEndpoint: "Tavily endpoint override is not allowed.",
});

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return LOOPBACK_HOSTS.has(host) || /^127(?:\.\d{1,3}){3}$/.test(host);
}

export function resolveTavilyEndpoint(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.BORG_TAVILY_ENDPOINT?.trim();
  if (!override) {
    return TAVILY_PRODUCTION_ENDPOINT;
  }
  if (env.BORG_E2E !== "1") {
    throw new Error(SAFE_TAVILY_ERRORS.invalidEndpoint);
  }
  let parsed: URL;
  try {
    parsed = new URL(override);
  } catch {
    throw new Error(SAFE_TAVILY_ERRORS.invalidEndpoint);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(SAFE_TAVILY_ERRORS.invalidEndpoint);
  }
  if (!isLoopbackHostname(parsed.hostname)) {
    throw new Error(SAFE_TAVILY_ERRORS.invalidEndpoint);
  }
  return parsed.toString();
}

export interface TavilySearchRequest {
  readonly query: string;
  readonly maxResults?: number | undefined;
}

export interface TavilyClientOptions {
  readonly fetchImpl?: typeof fetch;
  readonly endpoint?: string;
  readonly timeoutMs?: number;
  getApiKey(): Promise<string | undefined>;
}

export class TavilyClient {
  readonly #fetch: typeof fetch;
  readonly #endpoint: string;
  readonly #timeoutMs: number;
  readonly #getApiKey: () => Promise<string | undefined>;

  constructor(options: TavilyClientOptions) {
    this.#fetch = options.fetchImpl ?? fetch;
    this.#endpoint = options.endpoint ?? resolveTavilyEndpoint();
    this.#timeoutMs = options.timeoutMs ?? TAVILY_TIMEOUT_MS;
    this.#getApiKey = options.getApiKey;
  }

  async search(
    input: TavilySearchRequest,
    signal?: AbortSignal,
  ): Promise<WebSearchOutput> {
    const query = input.query.trim();
    const maxResults = input.maxResults ?? TAVILY_DEFAULT_MAX_RESULTS;
    const apiKey = await this.#getApiKey();
    if (!apiKey) {
      throw new Error(SAFE_TAVILY_ERRORS.missingKey);
    }
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await this.#fetch(this.#endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          query,
          max_results: maxResults,
          api_key: apiKey,
        }),
        redirect: "error",
        signal: combined,
      });
    } catch (error) {
      throw tavilyErrorFromUnknown(error, timeout, signal);
    }
    if (!response.ok) {
      await response.arrayBuffer().catch(() => undefined);
      throw new Error(SAFE_TAVILY_ERRORS.rejected);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error(SAFE_TAVILY_ERRORS.protocol);
    }
    return parseTavilyResponse(payload, query);
  }
}

export function parseTavilyResponse(
  payload: unknown,
  query: string,
): WebSearchOutput {
  if (!payload || typeof payload !== "object") {
    throw new Error(SAFE_TAVILY_ERRORS.protocol);
  }
  const results = (payload as { readonly results?: unknown }).results;
  if (results !== undefined && !Array.isArray(results)) {
    throw new Error(SAFE_TAVILY_ERRORS.protocol);
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
            typeof record.content === "string" ? record.content : "",
        },
      ];
    } catch {
      return [];
    }
  });
  return webSearchOutputSchema.parse({ query, hits });
}

function tavilyErrorFromUnknown(
  error: unknown,
  timeout: AbortSignal,
  signal: AbortSignal | undefined,
): Error {
  if (timeout.aborted && !signal?.aborted) {
    return new Error(SAFE_TAVILY_ERRORS.timeout);
  }
  if (
    (error instanceof Error && error.name === "AbortError") ||
    (error instanceof DOMException && error.name === "AbortError")
  ) {
    return new Error(SAFE_TAVILY_ERRORS.cancelled);
  }
  if (
    error instanceof Error &&
    Object.values(SAFE_TAVILY_ERRORS).includes(
      error.message as (typeof SAFE_TAVILY_ERRORS)[keyof typeof SAFE_TAVILY_ERRORS],
    )
  ) {
    return error;
  }
  return new Error(SAFE_TAVILY_ERRORS.protocol);
}
