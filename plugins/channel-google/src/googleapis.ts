import type { PluginHttp } from "@borg/plugin-sdk";
import {
  GOOGLE_APIS_BASE,
  MAX_DRIVE_SEARCH_QUERY,
  MAX_REST_RESPONSE_BYTES,
  isAllowedGoogleApisPath,
  isRecord,
} from "./protocol";

export type GoogleApisErrorCode =
  | "auth"
  | "forbidden"
  | "not-found"
  | "invalid"
  | "failed";

export class GoogleApisError extends Error {
  constructor(
    readonly code: GoogleApisErrorCode,
    readonly status: number | undefined,
    message: string,
  ) {
    super(message);
    this.name = "GoogleApisError";
  }
}

export interface GoogleApisClientOptions {
  readonly http: PluginHttp;
  readonly readToken: (signal?: AbortSignal) => Promise<string>;
}

export interface GoogleApisRequestInit {
  readonly method: string;
  readonly body?: string | undefined;
  readonly accept?: string | undefined;
  readonly mode?: "json" | "text" | undefined;
  readonly signal?: AbortSignal | undefined;
}

export async function googleApisRequest(
  options: GoogleApisClientOptions,
  pathWithQuery: string,
  init: GoogleApisRequestInit,
): Promise<unknown> {
  const url = new URL(pathWithQuery, `${GOOGLE_APIS_BASE}/`);
  const method = init.method.toUpperCase();
  if (
    url.origin !== GOOGLE_APIS_BASE ||
    !isAllowedGoogleApisPath(url.pathname, method)
  ) {
    throw new GoogleApisError(
      "invalid",
      undefined,
      "Google request path is invalid",
    );
  }
  if (url.pathname === "/drive/v3/files" && method === "GET") {
    const query = url.searchParams.get("q");
    if (
      query === null ||
      query.length < 1 ||
      query.length > MAX_DRIVE_SEARCH_QUERY
    ) {
      throw new GoogleApisError(
        "invalid",
        undefined,
        "Google Drive search query is invalid",
      );
    }
  }
  const token = await options.readToken(init.signal);
  if (token.length === 0) {
    throw new GoogleApisError("auth", undefined, "Google is not connected");
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: init.accept ?? "application/json",
  };
  if (init.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  let response: Response;
  try {
    response = await options.http.fetch(url, {
      method,
      headers,
      redirect: "error",
      ...(init.body !== undefined ? { body: init.body } : {}),
      ...(init.signal ? { signal: init.signal } : {}),
    });
  } catch {
    throw new GoogleApisError(
      "failed",
      undefined,
      init.signal?.aborted
        ? "Google request was cancelled"
        : "Google request failed",
    );
  }
  if (!response.ok) {
    await discardBody(response);
    throw errorForStatus(response.status);
  }
  const text = await readBoundedText(response);
  if (init.mode === "text") {
    return text;
  }
  if (text.length === 0) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new GoogleApisError(
      "invalid",
      response.status,
      "Google returned a malformed response",
    );
  }
}

export function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

export { isRecord };

function errorForStatus(status: number): GoogleApisError {
  if (status === 401) {
    return new GoogleApisError("auth", status, "Google rejected the access token");
  }
  if (status === 403) {
    return new GoogleApisError(
      "forbidden",
      status,
      "Google denied access to this resource",
    );
  }
  if (status === 404) {
    return new GoogleApisError(
      "not-found",
      status,
      "Google could not find this resource",
    );
  }
  return new GoogleApisError(
    "failed",
    status,
    `Google request failed with status ${status}`,
  );
}

async function readBoundedText(response: Response): Promise<string> {
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_REST_RESPONSE_BYTES) {
    throw new GoogleApisError(
      "invalid",
      response.status,
      "Google response is too large",
    );
  }
  return text;
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
  }
}
