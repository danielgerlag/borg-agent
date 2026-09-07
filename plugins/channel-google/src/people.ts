import {
  GoogleApisError,
  type GoogleApisClientOptions,
  type GoogleApisRequestInit,
} from "./googleapis";
import {
  MAX_CONTACTS_QUERY,
  MAX_REST_RESPONSE_BYTES,
  PEOPLE_API_BASE,
  isAllowedPeoplePath,
} from "./protocol";

export async function peopleRequest(
  options: GoogleApisClientOptions,
  pathWithQuery: string,
  init: GoogleApisRequestInit,
): Promise<unknown> {
  const url = new URL(pathWithQuery, `${PEOPLE_API_BASE}/`);
  const method = init.method.toUpperCase();
  if (url.origin !== PEOPLE_API_BASE || !isAllowedPeoplePath(url.pathname, method)) {
    throw new GoogleApisError(
      "invalid",
      undefined,
      "Google request path is invalid",
    );
  }
  if (url.pathname === "/v1/people:searchContacts") {
    const query = url.searchParams.get("query");
    if (
      query === null ||
      query.length < 1 ||
      query.length > MAX_CONTACTS_QUERY
    ) {
      throw new GoogleApisError(
        "invalid",
        undefined,
        "Google contacts search query is invalid",
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
