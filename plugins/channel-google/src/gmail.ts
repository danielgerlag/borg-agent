import type { PluginHttp } from "@borg/plugin-sdk";
import {
  GMAIL_API_BASE,
  MAX_MESSAGE_ID_LENGTH,
  MAX_OUTBOUND_CONTENT_LENGTH,
  MAX_POLL_MESSAGES,
  MAX_REST_RESPONSE_BYTES,
  isAllowedGmailPath,
  isRecord,
} from "./protocol";
import { composeInboundText, mailBodyToText } from "./text";

export type GmailErrorCode =
  | "auth"
  | "forbidden"
  | "not-found"
  | "invalid"
  | "failed";

export class GmailError extends Error {
  constructor(
    readonly code: GmailErrorCode,
    readonly status: number | undefined,
    message: string,
  ) {
    super(message);
    this.name = "GmailError";
  }
}

export interface GmailMailbox {
  readonly mailbox: string;
}

export interface GmailInboxMessage {
  readonly id: string;
  readonly text: string;
  readonly sender?: string | undefined;
  readonly receivedAt?: string | undefined;
}

export interface GmailClientOptions {
  readonly http: PluginHttp;
  readonly readToken: (signal?: AbortSignal) => Promise<string>;
}

export class GmailClient {
  readonly #http: PluginHttp;
  readonly #readToken: (signal?: AbortSignal) => Promise<string>;

  constructor(options: GmailClientOptions) {
    this.#http = options.http;
    this.#readToken = options.readToken;
  }

  async getProfile(signal?: AbortSignal): Promise<GmailMailbox> {
    const body = await this.#request(
      "/gmail/v1/users/me/profile",
      { method: "GET" },
      signal,
    );
    if (!isRecord(body) || typeof body.emailAddress !== "string") {
      throw new GmailError("invalid", undefined, "Gmail returned an unusable profile");
    }
    const mailbox = body.emailAddress.trim();
    if (mailbox.length === 0) {
      throw new GmailError("invalid", undefined, "Gmail returned an unusable mailbox");
    }
    return { mailbox };
  }

  async listInbox(signal?: AbortSignal): Promise<readonly GmailInboxMessage[]> {
    const query = new URLSearchParams({
      maxResults: String(MAX_POLL_MESSAGES),
      labelIds: "INBOX",
    });
    const body = await this.#request(
      `/gmail/v1/users/me/messages?${query.toString()}`,
      { method: "GET" },
      signal,
    );
    if (!isRecord(body)) {
      throw new GmailError("invalid", undefined, "Gmail returned an unusable inbox");
    }
    const listed = Array.isArray(body.messages) ? body.messages : [];
    const messages: GmailInboxMessage[] = [];
    for (const item of listed) {
      if (!isRecord(item) || typeof item.id !== "string") {
        continue;
      }
      const id = item.id;
      if (id.length === 0 || id.length > MAX_MESSAGE_ID_LENGTH) {
        continue;
      }
      messages.push(await this.#getMessage(id, signal));
    }
    return messages;
  }

  async sendMail(request: {
    readonly from: string;
    readonly to: string;
    readonly text: string;
    readonly signal?: AbortSignal | undefined;
  }): Promise<{ readonly messageId: string }> {
    if (
      request.text.length === 0 ||
      request.text.length > MAX_OUTBOUND_CONTENT_LENGTH
    ) {
      throw new GmailError(
        "invalid",
        undefined,
        `Gmail messages must be 1 to ${MAX_OUTBOUND_CONTENT_LENGTH} characters`,
      );
    }
    const raw = encodeBase64Url(rfc822(request.from, request.to, request.text));
    const body = await this.#request(
      "/gmail/v1/users/me/messages/send",
      {
        method: "POST",
        body: JSON.stringify({ raw }),
      },
      request.signal,
    );
    if (!isRecord(body) || typeof body.id !== "string" || body.id.length === 0) {
      throw new GmailError("invalid", undefined, "Gmail returned an unusable message id");
    }
    return { messageId: body.id };
  }

  async #getMessage(
    id: string,
    signal: AbortSignal | undefined,
  ): Promise<GmailInboxMessage> {
    const body = await this.#request(
      `/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=full`,
      { method: "GET" },
      signal,
    );
    const parsed = parseGmailMessage(body);
    if (!parsed) {
      throw new GmailError("invalid", undefined, "Gmail returned an unusable message");
    }
    return parsed;
  }

  async #request(
    pathWithQuery: string,
    init: { readonly method: string; readonly body?: string | undefined },
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    const url = new URL(pathWithQuery, `${GMAIL_API_BASE}/`);
    if (url.origin !== GMAIL_API_BASE || !isAllowedGmailPath(url.pathname)) {
      throw new GmailError("invalid", undefined, "Gmail request path is invalid");
    }
    const token = await this.#readToken(signal);
    if (token.length === 0) {
      throw new GmailError("auth", undefined, "Google is not connected");
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
      throw new GmailError(
        "failed",
        undefined,
        signal?.aborted ? "Gmail request was cancelled" : "Gmail request failed",
      );
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
      return JSON.parse(text) as unknown;
    } catch {
      throw new GmailError(
        "invalid",
        response.status,
        "Gmail returned a malformed response",
      );
    }
  }
}

function parseGmailMessage(value: unknown): GmailInboxMessage | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || value.id.length === 0) {
    return undefined;
  }
  const payload = isRecord(value.payload) ? value.payload : undefined;
  const headers = payload && Array.isArray(payload.headers) ? payload.headers : [];
  const subject = headerValue(headers, "Subject");
  const sender = headerValue(headers, "From");
  const receivedAt = headerValue(headers, "Date");
  const part = findBodyPart(payload);
  const body = part
    ? mailBodyToText(decodeBase64Url(part.data), part.mimeType)
    : "";
  return {
    id: value.id,
    text: composeInboundText(subject, body),
    ...(sender ? { sender } : {}),
    ...(receivedAt ? { receivedAt } : {}),
  };
}

function headerValue(
  headers: readonly unknown[],
  name: string,
): string | undefined {
  const needle = name.toLowerCase();
  for (const header of headers) {
    if (!isRecord(header)) {
      continue;
    }
    if (typeof header.name !== "string" || typeof header.value !== "string") {
      continue;
    }
    if (header.name.toLowerCase() === needle && header.value.trim().length > 0) {
      return header.value.trim();
    }
  }
  return undefined;
}

function findBodyPart(
  payload: Record<string, unknown> | undefined,
): { readonly mimeType: string; readonly data: string } | undefined {
  if (!payload) {
    return undefined;
  }
  const plain = findPartByMime(payload, "text/plain");
  if (plain) {
    return plain;
  }
  return findPartByMime(payload, "text/html");
}

function findPartByMime(
  node: Record<string, unknown>,
  mimeType: string,
): { readonly mimeType: string; readonly data: string } | undefined {
  const actual = typeof node.mimeType === "string" ? node.mimeType : "";
  const body = isRecord(node.body) ? node.body : undefined;
  const data = body && typeof body.data === "string" ? body.data : undefined;
  if (actual.toLowerCase().startsWith(mimeType) && data) {
    return { mimeType: actual, data };
  }
  const parts = Array.isArray(node.parts) ? node.parts : [];
  for (const part of parts) {
    if (!isRecord(part)) {
      continue;
    }
    const nested = findPartByMime(part, mimeType);
    if (nested) {
      return nested;
    }
  }
  return undefined;
}

function encodeBase64Url(value: string): string {
  return Buffer.from(value, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const pad =
    normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  return Buffer.from(`${normalized}${pad}`, "base64").toString("utf8");
}

function rfc822(from: string, to: string, text: string): string {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
  return [
    `From: ${from}`,
    `To: ${to}`,
    "Subject: Message",
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    normalized,
  ].join("\r\n");
}

function errorForStatus(status: number): GmailError {
  if (status === 401) {
    return new GmailError("auth", status, "Gmail rejected the access token");
  }
  if (status === 403) {
    return new GmailError("forbidden", status, "Gmail denied access to this resource");
  }
  if (status === 404) {
    return new GmailError("not-found", status, "Gmail could not find this resource");
  }
  return new GmailError("failed", status, `Gmail request failed with status ${status}`);
}

async function readBoundedText(response: Response): Promise<string> {
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_REST_RESPONSE_BYTES) {
    throw new GmailError(
      "invalid",
      response.status,
      "Gmail response is too large",
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
