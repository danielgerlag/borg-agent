import type { PluginHttp } from "@borg/plugin-sdk";
import {
  GRAPH_API_BASE,
  MAX_OUTBOUND_CONTENT_LENGTH,
  MAX_POLL_MESSAGES,
  MAX_REST_RESPONSE_BYTES,
  isAllowedGraphPath,
  isRecord,
} from "./protocol";
import { composeInboundText, mailBodyToText } from "./text";

export type GraphErrorCode =
  | "auth"
  | "forbidden"
  | "not-found"
  | "invalid"
  | "failed";

export class GraphError extends Error {
  constructor(
    readonly code: GraphErrorCode,
    readonly status: number | undefined,
    message: string,
  ) {
    super(message);
    this.name = "GraphError";
  }
}

export interface GraphMailbox {
  readonly mailbox: string;
}

export interface GraphInboxMessage {
  readonly id: string;
  readonly text: string;
  readonly sender?: string | undefined;
  readonly receivedAt?: string | undefined;
}

export interface GraphClientOptions {
  readonly http: PluginHttp;
  readonly readToken: (signal?: AbortSignal) => Promise<string>;
}

export class GraphClient {
  readonly #http: PluginHttp;
  readonly #readToken: (signal?: AbortSignal) => Promise<string>;

  constructor(options: GraphClientOptions) {
    this.#http = options.http;
    this.#readToken = options.readToken;
  }

  async getMe(signal?: AbortSignal): Promise<GraphMailbox> {
    const body = await this.#request("/v1.0/me", { method: "GET" }, signal);
    if (!isRecord(body)) {
      throw new GraphError("invalid", undefined, "Graph returned an unusable profile");
    }
    const mailbox =
      readString(body.mail) ?? readString(body.userPrincipalName);
    if (!mailbox) {
      throw new GraphError("invalid", undefined, "Graph returned an unusable mailbox");
    }
    return { mailbox };
  }

  async listInbox(signal?: AbortSignal): Promise<readonly GraphInboxMessage[]> {
    const query = new URLSearchParams({
      $top: String(MAX_POLL_MESSAGES),
      $select: "id,subject,from,body,receivedDateTime",
      $orderby: "receivedDateTime desc",
    });
    const body = await this.#request(
      `/v1.0/me/mailFolders/inbox/messages?${query.toString()}`,
      { method: "GET" },
      signal,
    );
    if (!isRecord(body) || !Array.isArray(body.value)) {
      throw new GraphError("invalid", undefined, "Graph returned an unusable inbox");
    }
    const messages: GraphInboxMessage[] = [];
    for (const item of body.value) {
      const parsed = parseInboxMessage(item);
      if (parsed) {
        messages.push(parsed);
      }
    }
    return messages;
  }

  async sendMail(request: {
    readonly to: string;
    readonly text: string;
    readonly signal?: AbortSignal | undefined;
  }): Promise<void> {
    if (
      request.text.length === 0 ||
      request.text.length > MAX_OUTBOUND_CONTENT_LENGTH
    ) {
      throw new GraphError(
        "invalid",
        undefined,
        `Microsoft 365 messages must be 1 to ${MAX_OUTBOUND_CONTENT_LENGTH} characters`,
      );
    }
    await this.#request(
      "/v1.0/me/sendMail",
      {
        method: "POST",
        body: JSON.stringify({
          message: {
            subject: "Message",
            body: { contentType: "Text", content: request.text },
            toRecipients: [{ emailAddress: { address: request.to } }],
          },
        }),
      },
      request.signal,
    );
  }

  async #request(
    pathWithQuery: string,
    init: { readonly method: string; readonly body?: string | undefined },
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    const url = new URL(pathWithQuery, `${GRAPH_API_BASE}/`);
    if (url.origin !== GRAPH_API_BASE || !isAllowedGraphPath(url.pathname)) {
      throw new GraphError("invalid", undefined, "Graph request path is invalid");
    }
    const token = await this.#readToken(signal);
    if (token.length === 0) {
      throw new GraphError("auth", undefined, "Microsoft 365 is not connected");
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    };
    if (init.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    let response: Response;
    try {
      response = await this.#http.fetch(url, {
        method: init.method,
        headers,
        ...(init.body !== undefined ? { body: init.body } : {}),
        ...(signal ? { signal } : {}),
      });
    } catch {
      throw new GraphError(
        "failed",
        undefined,
        signal?.aborted ? "Graph request was cancelled" : "Graph request failed",
      );
    }
    if (!response.ok) {
      await discardBody(response);
      throw errorForStatus(response.status);
    }
    if (response.status === 202 || response.status === 204) {
      await discardBody(response);
      return undefined;
    }
    const text = await readBoundedText(response);
    if (text.length === 0) {
      return undefined;
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new GraphError(
        "invalid",
        response.status,
        "Graph returned a malformed response",
      );
    }
  }
}

function parseInboxMessage(value: unknown): GraphInboxMessage | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0) {
    return undefined;
  }
  const subject = readString(value.subject);
  const receivedAt = readString(value.receivedDateTime);
  const from = isRecord(value.from) ? value.from.emailAddress : undefined;
  const sender = isRecord(from) ? readString(from.address) : undefined;
  const body = isRecord(value.body) ? value.body : undefined;
  const content = isRecord(body) ? readString(body.content) ?? "" : "";
  const contentType = isRecord(body) ? readString(body.contentType) ?? "text" : "text";
  return {
    id: value.id,
    text: composeInboundText(subject, mailBodyToText(content, contentType)),
    ...(sender ? { sender } : {}),
    ...(receivedAt ? { receivedAt } : {}),
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function errorForStatus(status: number): GraphError {
  if (status === 401) {
    return new GraphError("auth", status, "Graph rejected the access token");
  }
  if (status === 403) {
    return new GraphError("forbidden", status, "Graph denied access to this resource");
  }
  if (status === 404) {
    return new GraphError("not-found", status, "Graph could not find this resource");
  }
  return new GraphError("failed", status, `Graph request failed with status ${status}`);
}

async function readBoundedText(response: Response): Promise<string> {
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_REST_RESPONSE_BYTES) {
    throw new GraphError(
      "invalid",
      response.status,
      "Graph response is too large",
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
