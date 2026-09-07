import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type {
  OAuthErrorCode,
  OAuthLoopbackHost,
  OAuthSessionSnapshot,
  PluginOAuthConnectRequest,
} from "@borg/plugin-sdk";
import type { SecretFacade } from "./persistence";

export const OAUTH_VAULT_NAMESPACE = "system.oauth";
export const OAUTH_ACCESS_TOKEN_SKEW_MS = 120_000;

const DEFAULT_AUDIT_CAPACITY = 256;
const MAX_QUERY_BYTES = 8_192;
const MAX_TOKEN_RESPONSE_BYTES = 16_384;
const MAX_ERROR_MESSAGE_BYTES = 512;
const DEFAULT_ACCESS_TOKEN_TTL_MS = 3_600_000;
const MAX_ACCESS_TOKEN_TTL_MS = 365 * 24 * 3_600_000;
const LOOPBACK_BIND_HOST = "127.0.0.1";
const SUCCESS_PAGE =
  "<!doctype html><html><body><p>You can close this window.</p></body></html>";
const FAILURE_PAGE =
  "<!doctype html><html><body><p>Authorization failed. You can close this window.</p></body></html>";

const RESERVED_EXTRA_KEYS = new Set([
  "client_id",
  "redirect_uri",
  "response_type",
  "scope",
  "state",
  "code",
  "code_challenge",
  "code_challenge_method",
  "code_verifier",
  "grant_type",
  "refresh_token",
  "client_secret",
]);

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export class OAuthError extends Error {
  constructor(
    readonly code: OAuthErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "OAuthError";
  }
}

export type OAuthAuditFailure =
  | "invalid-request"
  | "reserved-param"
  | "invalid-endpoint"
  | "host-mismatch"
  | "denied"
  | "missing-code"
  | "state-mismatch"
  | "missing-refresh-token"
  | "token-failed"
  | "query-too-large"
  | "one-shot"
  | "aborted"
  | "shut-down"
  | "open-external-failed"
  | "unavailable";

export type OAuthAuditOutcome =
  | "connected"
  | "disconnected"
  | "refreshed"
  | "rejected"
  | "failed";

export interface OAuthAuditRecord {
  readonly pluginId: string;
  readonly outcome: OAuthAuditOutcome;
  readonly authorizationOrigin?: string | undefined;
  readonly tokenOrigin?: string | undefined;
  readonly revocationOrigin?: string | undefined;
  readonly failure?: OAuthAuditFailure | undefined;
}

export interface OAuthLoopbackRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface OAuthLoopbackResponse {
  writeHead(status: number, headers?: Readonly<Record<string, string>>): void;
  end(body?: string): void;
}

export interface OAuthLoopbackServer {
  readonly port: number;
  close(): Promise<void>;
}

export type OAuthListen = (options: {
  readonly handler: (
    request: OAuthLoopbackRequest,
    response: OAuthLoopbackResponse,
  ) => void;
  readonly signal: AbortSignal;
}) => Promise<OAuthLoopbackServer>;

export type OAuthOpenExternal = (url: string) => Promise<void>;

export interface OAuthServiceOptions {
  readonly secrets: SecretFacade;
  readonly openExternal?: OAuthOpenExternal | undefined;
  readonly fetch?: typeof fetch | undefined;
  readonly listen?: OAuthListen | undefined;
  readonly now?: (() => number) | undefined;
  readonly randomBytes?: ((size: number) => Uint8Array) | undefined;
  readonly allowLoopbackHttp?: boolean | undefined;
  readonly auditCapacity?: number | undefined;
}

interface StoredGrant {
  readonly v: 1;
  readonly clientId: string;
  readonly tokenEndpoint: string;
  readonly revocationEndpoint?: string | undefined;
  readonly extraTokenParams: Readonly<Record<string, string>>;
  readonly refreshToken: string;
  readonly accessToken: string;
  readonly expiresAt: string;
}

interface OwnedConnect {
  readonly controller: AbortController;
}

interface CallbackResult {
  readonly code: string;
}

interface ParsedConnectRequest {
  readonly clientId: string;
  readonly authorization: URL;
  readonly token: URL;
  readonly revocation?: URL | undefined;
  readonly scopes: readonly string[];
  readonly loopbackHost: OAuthLoopbackHost;
  readonly extraAuthorizationParams: Readonly<Record<string, string>>;
  readonly extraTokenParams: Readonly<Record<string, string>>;
}

function positiveBound(
  candidate: number | undefined,
  fallback: number,
  description: string,
): number {
  if (candidate === undefined) {
    return fallback;
  }
  if (!Number.isInteger(candidate) || candidate < 1) {
    throw new OAuthError("invalid", `${description} is invalid`);
  }
  return candidate;
}

function boundUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return value;
  }
  let end = value.length;
  while (end > 0 && Buffer.byteLength(value.slice(0, end), "utf8") > maxBytes) {
    end -= 1;
  }
  return value.slice(0, end);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return LOOPBACK_HOSTS.has(host) || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function pkceChallenge(verifier: string): string {
  return base64Url(createHash("sha256").update(verifier).digest());
}

function originOf(url: URL): string {
  return url.origin;
}

function headerMap(headers: IncomingHttpHeaders): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      result[key.toLowerCase()] = value;
    } else if (Array.isArray(value) && typeof value[0] === "string") {
      result[key.toLowerCase()] = value[0];
    }
  }
  return result;
}

function parseHostHeader(value: string): { host: string; port?: string } {
  const trimmed = value.trim();
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    if (end < 1) {
      return { host: trimmed.toLowerCase() };
    }
    const host = trimmed.slice(1, end).toLowerCase();
    const rest = trimmed.slice(end + 1);
    if (rest.startsWith(":") && rest.length > 1) {
      return { host, port: rest.slice(1) };
    }
    return { host };
  }
  const colon = trimmed.lastIndexOf(":");
  if (colon > 0 && /^\d+$/.test(trimmed.slice(colon + 1))) {
    return {
      host: trimmed.slice(0, colon).toLowerCase(),
      port: trimmed.slice(colon + 1),
    };
  }
  return { host: trimmed.toLowerCase() };
}

function htmlResponse(
  response: OAuthLoopbackResponse,
  status: number,
  body: string,
): void {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": String(Buffer.byteLength(body)),
  });
  response.end(body);
}

function emptyResponse(response: OAuthLoopbackResponse, status: number): void {
  response.writeHead(status);
  response.end();
}

function isLoopbackHost(value: string): value is OAuthLoopbackHost {
  return value === "127.0.0.1" || value === "localhost";
}

function assertNonemptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new OAuthError("invalid", `${label} is invalid`);
  }
  return value.trim();
}

function assertExtraParams(
  params: Readonly<Record<string, string>> | undefined,
  label: string,
): Readonly<Record<string, string>> {
  if (params === undefined) {
    return {};
  }
  if (!isRecord(params)) {
    throw new OAuthError("invalid", `${label} is invalid`);
  }
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (RESERVED_EXTRA_KEYS.has(key.toLowerCase())) {
      throw new OAuthError("invalid", `${label} includes a reserved OAuth parameter`);
    }
    if (typeof value !== "string") {
      throw new OAuthError("invalid", `${label} is invalid`);
    }
    next[key] = value;
  }
  return next;
}

function assertHttpsOrLoopback(
  value: string,
  label: string,
  allowLoopbackHttp: boolean,
  requireHttps: boolean,
): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OAuthError("invalid", `${label} is invalid`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new OAuthError("invalid", `${label} must not include credentials`);
  }
  if (url.hash.length > 0) {
    throw new OAuthError("invalid", `${label} must not include a fragment`);
  }
  if (url.protocol === "https:") {
    return url;
  }
  if (
    !requireHttps &&
    allowLoopbackHttp &&
    url.protocol === "http:" &&
    isLoopbackHostname(url.hostname)
  ) {
    return url;
  }
  throw new OAuthError("invalid", `${label} must use https`);
}

function queryByteLength(url: string): number {
  const query = url.includes("?") ? url.slice(url.indexOf("?") + 1) : "";
  return Buffer.byteLength(query, "utf8");
}

function pathnameOf(url: string): string {
  try {
    return new URL(url, "http://127.0.0.1/").pathname;
  } catch {
    return url;
  }
}

function abortError(signal: AbortSignal, shutdown: boolean): OAuthError {
  if (shutdown) {
    return new OAuthError("unavailable", "OAuth service is shut down");
  }
  const reason = signal.reason;
  if (reason instanceof OAuthError) {
    return reason;
  }
  return new OAuthError("unavailable", "OAuth request was aborted", {
    ...(reason !== undefined ? { cause: reason } : {}),
  });
}

async function raceAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  shutdown: () => boolean,
): Promise<T> {
  if (signal.aborted) {
    throw abortError(signal, shutdown());
  }
  let onAbort: (() => void) | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      onAbort = () => reject(abortError(signal, shutdown()));
      signal.addEventListener("abort", onAbort, { once: true });
      void promise.then(resolve, reject);
    });
  } finally {
    if (onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

function parseGrant(value: string): StoredGrant | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || parsed.v !== 1) {
    return undefined;
  }
  if (
    typeof parsed.clientId !== "string" ||
    parsed.clientId.length === 0 ||
    typeof parsed.tokenEndpoint !== "string" ||
    parsed.tokenEndpoint.length === 0 ||
    typeof parsed.refreshToken !== "string" ||
    parsed.refreshToken.length === 0 ||
    typeof parsed.accessToken !== "string" ||
    parsed.accessToken.length === 0 ||
    typeof parsed.expiresAt !== "string" ||
    parsed.expiresAt.length === 0
  ) {
    return undefined;
  }
  const extra = parsed.extraTokenParams;
  const extraTokenParams: Record<string, string> = {};
  if (extra !== undefined) {
    if (!isRecord(extra)) {
      return undefined;
    }
    for (const [key, item] of Object.entries(extra)) {
      if (typeof item !== "string") {
        return undefined;
      }
      extraTokenParams[key] = item;
    }
  }
  const revocationEndpoint =
    typeof parsed.revocationEndpoint === "string" &&
    parsed.revocationEndpoint.length > 0
      ? parsed.revocationEndpoint
      : undefined;
  return {
    v: 1,
    clientId: parsed.clientId,
    tokenEndpoint: parsed.tokenEndpoint,
    extraTokenParams,
    refreshToken: parsed.refreshToken,
    accessToken: parsed.accessToken,
    expiresAt: parsed.expiresAt,
    ...(revocationEndpoint !== undefined ? { revocationEndpoint } : {}),
  };
}

function parseTokenJson(
  value: unknown,
  now: number,
  requireRefresh: boolean,
): {
  readonly accessToken: string;
  readonly refreshToken?: string | undefined;
  readonly expiresAt: string;
} {
  if (!isRecord(value)) {
    throw new OAuthError("failed", "Token endpoint returned an unusable response");
  }
  if (typeof value.access_token !== "string" || value.access_token.length === 0) {
    throw new OAuthError("failed", "Token endpoint returned an unusable response");
  }
  const refreshToken =
    typeof value.refresh_token === "string" && value.refresh_token.length > 0
      ? value.refresh_token
      : undefined;
  if (requireRefresh && refreshToken === undefined) {
    throw new OAuthError("failed", "Token response did not include a refresh token");
  }
  const expiresIn = value.expires_in;
  const ttlMs =
    typeof expiresIn === "number" && Number.isFinite(expiresIn)
      ? Math.min(
          Math.max(0, expiresIn) * 1_000,
          MAX_ACCESS_TOKEN_TTL_MS,
        )
      : DEFAULT_ACCESS_TOKEN_TTL_MS;
  return {
    accessToken: value.access_token,
    expiresAt: new Date(now + ttlMs).toISOString(),
    ...(refreshToken !== undefined ? { refreshToken } : {}),
  };
}

function defaultListen(options: {
  readonly handler: (
    request: OAuthLoopbackRequest,
    response: OAuthLoopbackResponse,
  ) => void;
  readonly signal: AbortSignal;
}): Promise<OAuthLoopbackServer> {
  if (options.signal.aborted) {
    return Promise.reject(abortError(options.signal, false));
  }
  return new Promise((resolve, reject) => {
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      options.handler(
        {
          method: request.method ?? "GET",
          url: request.url ?? "/",
          headers: headerMap(request.headers),
        },
        {
          writeHead(status, headers) {
            response.writeHead(status, headers ? { ...headers } : undefined);
          },
          end(body) {
            response.end(body);
          },
        },
      );
    });
    const onAbort = (): void => {
      server.close();
    };
    const onError = (error: Error): void => {
      options.signal.removeEventListener("abort", onAbort);
      reject(
        new OAuthError("failed", "OAuth loopback listen failed", { cause: error }),
      );
    };
    server.once("error", onError);
    server.listen(0, LOOPBACK_BIND_HOST, () => {
      server.off("error", onError);
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        options.signal.removeEventListener("abort", onAbort);
        reject(new OAuthError("failed", "OAuth loopback listen failed"));
        return;
      }
      options.signal.addEventListener("abort", onAbort, { once: true });
      if (options.signal.aborted) {
        onAbort();
        reject(abortError(options.signal, false));
        return;
      }
      resolve({
        port: address.port,
        close: () =>
          new Promise<void>((closeResolve) => {
            options.signal.removeEventListener("abort", onAbort);
            server.close(() => closeResolve());
          }),
      });
    });
  });
}

export class OAuthService {
  readonly #secrets: SecretFacade;
  readonly #openExternal: OAuthOpenExternal | undefined;
  readonly #fetch: typeof fetch;
  readonly #listen: OAuthListen;
  readonly #now: () => number;
  readonly #randomBytes: (size: number) => Uint8Array;
  readonly #allowLoopbackHttp: boolean;
  readonly #auditCapacity: number;
  readonly #audit: OAuthAuditRecord[] = [];
  readonly #owned = new Map<string, Set<OwnedConnect>>();
  readonly #refresh = new Map<string, Promise<string>>();
  readonly #generation = new Map<string, number>();
  readonly #shutdown = new AbortController();

  constructor(options: OAuthServiceOptions) {
    this.#secrets = options.secrets;
    this.#openExternal = options.openExternal;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#listen = options.listen ?? defaultListen;
    this.#now = options.now ?? Date.now;
    this.#randomBytes = options.randomBytes ?? ((size) => nodeRandomBytes(size));
    this.#allowLoopbackHttp = options.allowLoopbackHttp === true;
    this.#auditCapacity = positiveBound(
      options.auditCapacity,
      DEFAULT_AUDIT_CAPACITY,
      "OAuth audit capacity",
    );
  }

  async connect(
    pluginId: string,
    request: PluginOAuthConnectRequest,
    signal?: AbortSignal,
  ): Promise<OAuthSessionSnapshot> {
    if (this.#shutdown.signal.aborted) {
      this.#record({
        pluginId,
        outcome: "rejected",
        failure: "shut-down",
      });
      throw new OAuthError("unavailable", "OAuth service is shut down");
    }
    if (signal?.aborted) {
      this.#record({
        pluginId,
        outcome: "rejected",
        failure: "aborted",
      });
      throw abortError(signal, false);
    }

    const generation = this.#generation.get(pluginId) ?? 0;
    let authorizationOrigin: string | undefined;
    let tokenOrigin: string | undefined;
    let parsed: ParsedConnectRequest;
    try {
      parsed = this.#parseConnectRequest(request);
      authorizationOrigin = originOf(parsed.authorization);
      tokenOrigin = originOf(parsed.token);
    } catch (error) {
      const failure = this.#classifyInvalid(error);
      this.#record({
        pluginId,
        outcome: "rejected",
        failure,
        ...(authorizationOrigin ? { authorizationOrigin } : {}),
        ...(tokenOrigin ? { tokenOrigin } : {}),
      });
      throw error instanceof OAuthError
        ? error
        : new OAuthError("invalid", "OAuth connect request is invalid", {
            cause: error,
          });
    }

    const owned: OwnedConnect = { controller: new AbortController() };
    this.#addOwned(pluginId, owned);
    const combined = AbortSignal.any([
      ...(signal ? [signal] : []),
      owned.controller.signal,
      this.#shutdown.signal,
    ]);

    try {
      const snapshot = await this.#runConnect({
        pluginId,
        generation,
        parsed,
        signal: combined,
      });
      this.#record({
        pluginId,
        outcome: "connected",
        authorizationOrigin,
        tokenOrigin,
      });
      return snapshot;
    } catch (error) {
      const failure = this.#classifyConnectFailure(combined, error);
      this.#record({
        pluginId,
        outcome: failure === "denied" ? "rejected" : "failed",
        authorizationOrigin,
        tokenOrigin,
        failure,
      });
      throw this.#connectThrow(failure, error);
    } finally {
      this.#release(pluginId, owned);
    }
  }

  async snapshot(pluginId: string): Promise<OAuthSessionSnapshot> {
    const grant = await this.#loadGrant(pluginId);
    if (!grant) {
      return { connected: false };
    }
    return {
      connected: true,
      expiresAt: grant.expiresAt,
    };
  }

  async accessToken(pluginId: string, signal?: AbortSignal): Promise<string> {
    if (this.#shutdown.signal.aborted) {
      throw new OAuthError("unavailable", "OAuth service is shut down");
    }
    if (signal?.aborted) {
      throw abortError(signal, false);
    }
    const grant = await this.#loadGrant(pluginId);
    if (!grant) {
      throw new OAuthError("unavailable", "OAuth grant is unavailable");
    }
    if (this.#isFresh(grant)) {
      return grant.accessToken;
    }
    return this.#refreshGrant(pluginId, grant, signal);
  }

  async disconnect(pluginId: string): Promise<void> {
    this.#bump(pluginId);
    this.#abortOwned(pluginId, "deactivated");
    const grant = await this.#loadGrant(pluginId);
    if (grant?.revocationEndpoint) {
      await this.#revoke(pluginId, grant);
    }
    await this.#secrets.delete(OAUTH_VAULT_NAMESPACE, pluginId);
    this.#record({
      pluginId,
      outcome: "disconnected",
      ...(grant
        ? {
            tokenOrigin: this.#safeOrigin(grant.tokenEndpoint),
            ...(grant.revocationEndpoint
              ? { revocationOrigin: this.#safeOrigin(grant.revocationEndpoint) }
              : {}),
          }
        : {}),
    });
  }

  abortOwned(pluginId: string): void {
    this.#bump(pluginId);
    this.#abortOwned(pluginId, "deactivated");
  }

  shutdown(): void {
    if (!this.#shutdown.signal.aborted) {
      this.#shutdown.abort(new Error("OAuth service is shutting down"));
    }
    for (const pluginId of [...this.#owned.keys()]) {
      this.#bump(pluginId);
      this.#abortOwned(pluginId, "shutdown");
    }
  }

  countOwned(pluginId: string): number {
    return this.#owned.get(pluginId)?.size ?? 0;
  }

  listAudit(): readonly OAuthAuditRecord[] {
    return this.#audit.map((record) => Object.freeze({ ...record }));
  }

  #parseConnectRequest(request: PluginOAuthConnectRequest): ParsedConnectRequest {
    const clientId = assertNonemptyString(request.clientId, "OAuth client id");
    const authorization = assertHttpsOrLoopback(
      assertNonemptyString(
        request.authorizationEndpoint,
        "OAuth authorization endpoint",
      ),
      "OAuth authorization endpoint",
      false,
      true,
    );
    const token = assertHttpsOrLoopback(
      assertNonemptyString(request.tokenEndpoint, "OAuth token endpoint"),
      "OAuth token endpoint",
      this.#allowLoopbackHttp,
      false,
    );
    const revocation =
      request.revocationEndpoint === undefined
        ? undefined
        : assertHttpsOrLoopback(
            assertNonemptyString(
              request.revocationEndpoint,
              "OAuth revocation endpoint",
            ),
            "OAuth revocation endpoint",
            this.#allowLoopbackHttp,
            false,
          );
    if (!Array.isArray(request.scopes) || request.scopes.length === 0) {
      throw new OAuthError("invalid", "OAuth scopes are invalid");
    }
    const scopes = request.scopes.map((scope) =>
      assertNonemptyString(scope, "OAuth scope"),
    );
    const loopbackHost = request.loopbackHost ?? "127.0.0.1";
    if (!isLoopbackHost(loopbackHost)) {
      throw new OAuthError("invalid", "OAuth loopback host is invalid");
    }
    return {
      clientId,
      authorization,
      token,
      scopes,
      loopbackHost,
      extraAuthorizationParams: assertExtraParams(
        request.extraAuthorizationParams,
        "OAuth authorization parameters",
      ),
      extraTokenParams: assertExtraParams(
        request.extraTokenParams,
        "OAuth token parameters",
      ),
      ...(revocation ? { revocation } : {}),
    };
  }

  async #runConnect(input: {
    readonly pluginId: string;
    readonly generation: number;
    readonly parsed: ParsedConnectRequest;
    readonly signal: AbortSignal;
  }): Promise<OAuthSessionSnapshot> {
    const { pluginId, generation, parsed, signal } = input;
    const state = base64Url(this.#randomBytes(32));
    const verifier = base64Url(this.#randomBytes(32));
    const challenge = pkceChallenge(verifier);
    let consumed = false;
    let settled = false;
    let resolveCallback: ((result: CallbackResult) => void) | undefined;
    let rejectCallback: ((error: OAuthError) => void) | undefined;
    const callback = new Promise<CallbackResult>((resolve, reject) => {
      resolveCallback = resolve;
      rejectCallback = reject;
    });
    void callback.catch(() => undefined);

    const finishCallback = (error?: OAuthError, result?: CallbackResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (error) {
        rejectCallback?.(error);
        return;
      }
      if (!result) {
        rejectCallback?.(new OAuthError("failed", "OAuth callback failed"));
        return;
      }
      resolveCallback?.(result);
    };

    const bound = { port: 0 };
    const server = await this.#listen({
      signal,
      handler: (request, response) => {
        const method = request.method.toUpperCase();
        const path = pathnameOf(request.url);
        if (path === "/favicon.ico") {
          emptyResponse(response, 204);
          return;
        }
        if (method !== "GET") {
          emptyResponse(response, 405);
          return;
        }
        if (consumed) {
          htmlResponse(response, 400, FAILURE_PAGE);
          return;
        }
        if (queryByteLength(request.url) > MAX_QUERY_BYTES) {
          htmlResponse(response, 400, FAILURE_PAGE);
          finishCallback(
            new OAuthError("invalid", "OAuth callback query is too large"),
          );
          consumed = true;
          return;
        }
        const hostHeader = request.headers.host;
        if (typeof hostHeader !== "string" || !this.#hostMatches(hostHeader, parsed.loopbackHost, bound.port)) {
          htmlResponse(response, 400, FAILURE_PAGE);
          return;
        }
        let callbackUrl: URL;
        try {
          callbackUrl = new URL(request.url, `http://${parsed.loopbackHost}/`);
        } catch {
          htmlResponse(response, 400, FAILURE_PAGE);
          return;
        }
        const errorCode = callbackUrl.searchParams.get("error");
        if (errorCode === "access_denied") {
          consumed = true;
          htmlResponse(response, 400, FAILURE_PAGE);
          finishCallback(new OAuthError("denied", "The user denied the authorization request"));
          return;
        }
        if (errorCode) {
          consumed = true;
          htmlResponse(response, 400, FAILURE_PAGE);
          finishCallback(new OAuthError("failed", "Authorization endpoint returned an error"));
          return;
        }
        const returnedState = callbackUrl.searchParams.get("state");
        const code = callbackUrl.searchParams.get("code");
        if (returnedState !== state) {
          htmlResponse(response, 400, FAILURE_PAGE);
          return;
        }
        if (typeof code !== "string" || code.length === 0) {
          consumed = true;
          htmlResponse(response, 400, FAILURE_PAGE);
          finishCallback(new OAuthError("invalid", "OAuth callback code is missing"));
          return;
        }
        consumed = true;
        htmlResponse(response, 200, SUCCESS_PAGE);
        finishCallback(undefined, { code });
      },
    });
    bound.port = server.port;

    try {
      if (signal.aborted) {
        throw abortError(signal, this.#shutdown.signal.aborted);
      }
      const redirectUri = `http://${parsed.loopbackHost}:${server.port}/`;
      const authorizeUrl = new URL(parsed.authorization.href);
      authorizeUrl.searchParams.set("client_id", parsed.clientId);
      authorizeUrl.searchParams.set("redirect_uri", redirectUri);
      authorizeUrl.searchParams.set("response_type", "code");
      authorizeUrl.searchParams.set("scope", parsed.scopes.join(" "));
      authorizeUrl.searchParams.set("state", state);
      authorizeUrl.searchParams.set("code_challenge", challenge);
      authorizeUrl.searchParams.set("code_challenge_method", "S256");
      for (const [key, value] of Object.entries(parsed.extraAuthorizationParams)) {
        authorizeUrl.searchParams.set(key, value);
      }
      this.#assertAuthorizeUrl(authorizeUrl);

      const openExternal = this.#openExternal;
      if (!openExternal) {
        throw new OAuthError("unavailable", "OAuth browser open is unavailable");
      }
      try {
        await raceAbort(
          openExternal(authorizeUrl.href),
          signal,
          () => this.#shutdown.signal.aborted,
        );
      } catch (error) {
        if (error instanceof OAuthError) {
          throw error;
        }
        throw new OAuthError("failed", "Opening the authorization page failed", {
          cause: error,
        });
      }

      const { code } = await raceAbort(
        callback,
        signal,
        () => this.#shutdown.signal.aborted,
      );
      const tokens = await this.#exchangeToken({
        tokenUrl: parsed.token,
        body: {
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          client_id: parsed.clientId,
          code_verifier: verifier,
          ...parsed.extraTokenParams,
        },
        requireRefresh: true,
        signal,
      });
      if ((this.#generation.get(pluginId) ?? 0) !== generation) {
        throw new OAuthError("unavailable", "OAuth connect was aborted");
      }
      const refreshToken = tokens.refreshToken;
      if (refreshToken === undefined) {
        throw new OAuthError("failed", "Token response did not include a refresh token");
      }
      const grant: StoredGrant = {
        v: 1,
        clientId: parsed.clientId,
        tokenEndpoint: parsed.token.href,
        extraTokenParams: parsed.extraTokenParams,
        refreshToken,
        accessToken: tokens.accessToken,
        expiresAt: tokens.expiresAt,
        ...(parsed.revocation
          ? { revocationEndpoint: parsed.revocation.href }
          : {}),
      };
      await this.#secrets.set(
        OAUTH_VAULT_NAMESPACE,
        pluginId,
        JSON.stringify(grant),
      );
      return {
        connected: true,
        expiresAt: grant.expiresAt,
      };
    } finally {
      try {
        await server.close();
      } catch {
      }
      finishCallback(new OAuthError("unavailable", "OAuth connect was aborted"));
    }
  }

  async #refreshGrant(
    pluginId: string,
    grant: StoredGrant,
    signal?: AbortSignal,
  ): Promise<string> {
    const existing = this.#refresh.get(pluginId);
    if (existing) {
      return existing;
    }
    const run = this.#refreshNow(pluginId, grant, signal);
    this.#refresh.set(pluginId, run);
    try {
      return await run;
    } finally {
      if (this.#refresh.get(pluginId) === run) {
        this.#refresh.delete(pluginId);
      }
    }
  }

  async #refreshNow(
    pluginId: string,
    grant: StoredGrant,
    signal?: AbortSignal,
  ): Promise<string> {
    const generation = this.#generation.get(pluginId) ?? 0;
    const owned: OwnedConnect = { controller: new AbortController() };
    this.#addOwned(pluginId, owned);
    const combined = AbortSignal.any([
      ...(signal ? [signal] : []),
      owned.controller.signal,
      this.#shutdown.signal,
    ]);
    const tokenUrl = assertHttpsOrLoopback(
      grant.tokenEndpoint,
      "OAuth token endpoint",
      this.#allowLoopbackHttp,
      false,
    );
    try {
      const tokens = await this.#exchangeToken({
        tokenUrl,
        body: {
          grant_type: "refresh_token",
          refresh_token: grant.refreshToken,
          client_id: grant.clientId,
          ...grant.extraTokenParams,
        },
        requireRefresh: false,
        signal: combined,
      });
      if ((this.#generation.get(pluginId) ?? 0) !== generation) {
        throw new OAuthError("unavailable", "OAuth refresh was aborted");
      }
      const next: StoredGrant = {
        ...grant,
        accessToken: tokens.accessToken,
        expiresAt: tokens.expiresAt,
        refreshToken: tokens.refreshToken ?? grant.refreshToken,
      };
      await this.#secrets.set(
        OAUTH_VAULT_NAMESPACE,
        pluginId,
        JSON.stringify(next),
      );
      this.#record({
        pluginId,
        outcome: "refreshed",
        tokenOrigin: originOf(tokenUrl),
      });
      return next.accessToken;
    } catch (error) {
      const failure = this.#classifyConnectFailure(combined, error);
      this.#record({
        pluginId,
        outcome: "failed",
        tokenOrigin: originOf(tokenUrl),
        failure,
      });
      throw this.#connectThrow(failure, error);
    } finally {
      this.#release(pluginId, owned);
    }
  }

  async #exchangeToken(input: {
    readonly tokenUrl: URL;
    readonly body: Readonly<Record<string, string>>;
    readonly requireRefresh: boolean;
    readonly signal: AbortSignal;
  }): Promise<{
    readonly accessToken: string;
    readonly refreshToken?: string | undefined;
    readonly expiresAt: string;
  }> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(input.body)) {
      params.set(key, value);
    }
    let response: Response;
    try {
      response = await this.#fetch(input.tokenUrl, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
        redirect: "error",
        signal: input.signal,
      });
    } catch (error) {
      if (input.signal.aborted) {
        throw abortError(input.signal, this.#shutdown.signal.aborted);
      }
      throw new OAuthError("failed", "Token request failed", { cause: error });
    }
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_TOKEN_RESPONSE_BYTES) {
      throw new OAuthError("failed", "Token endpoint returned an unusable response");
    }
    if (!response.ok) {
      throw new OAuthError("failed", "Token endpoint rejected the request");
    }
    let parsed: unknown;
    try {
      parsed = text.length === 0 ? undefined : (JSON.parse(text) as unknown);
    } catch {
      throw new OAuthError("failed", "Token endpoint returned an unusable response");
    }
    return parseTokenJson(parsed, this.#now(), input.requireRefresh);
  }

  async #revoke(pluginId: string, grant: StoredGrant): Promise<void> {
    let url: URL;
    try {
      url = assertHttpsOrLoopback(
        grant.revocationEndpoint ?? "",
        "OAuth revocation endpoint",
        this.#allowLoopbackHttp,
        false,
      );
    } catch {
      return;
    }
    const params = new URLSearchParams({
      token: grant.refreshToken,
      token_type_hint: "refresh_token",
      client_id: grant.clientId,
    });
    try {
      await this.#fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        body: params.toString(),
        redirect: "error",
        signal: this.#shutdown.signal,
      });
    } catch {
      this.#record({
        pluginId,
        outcome: "failed",
        revocationOrigin: originOf(url),
        failure: "token-failed",
      });
    }
  }

  async #loadGrant(pluginId: string): Promise<StoredGrant | undefined> {
    const raw = await this.#secrets.get(OAUTH_VAULT_NAMESPACE, pluginId);
    if (typeof raw !== "string" || raw.length === 0) {
      return undefined;
    }
    return parseGrant(raw);
  }

  #isFresh(grant: StoredGrant): boolean {
    const expiresAt = Date.parse(grant.expiresAt);
    if (!Number.isFinite(expiresAt)) {
      return false;
    }
    return expiresAt - OAUTH_ACCESS_TOKEN_SKEW_MS > this.#now();
  }

  #assertAuthorizeUrl(url: URL): void {
    if (url.protocol !== "https:") {
      throw new OAuthError("invalid", "OAuth authorization endpoint must use https");
    }
    if (url.username !== "" || url.password !== "") {
      throw new OAuthError("invalid", "OAuth authorization endpoint must not include credentials");
    }
  }

  #hostMatches(header: string, advertiseHost: OAuthLoopbackHost, port: number): boolean {
    const parsed = parseHostHeader(header);
    if (parsed.host !== advertiseHost.toLowerCase()) {
      return false;
    }
    if (parsed.port === undefined) {
      return port === 80;
    }
    return Number.parseInt(parsed.port, 10) === port;
  }

  #safeOrigin(value: string): string | undefined {
    try {
      return originOf(new URL(value));
    } catch {
      return undefined;
    }
  }

  #addOwned(pluginId: string, owned: OwnedConnect): void {
    const set = this.#owned.get(pluginId) ?? new Set<OwnedConnect>();
    set.add(owned);
    this.#owned.set(pluginId, set);
  }

  #release(pluginId: string, owned: OwnedConnect): void {
    const set = this.#owned.get(pluginId);
    if (!set) {
      return;
    }
    set.delete(owned);
    if (set.size === 0) {
      this.#owned.delete(pluginId);
    }
  }

  #abortOwned(pluginId: string, reason: "deactivated" | "shutdown"): void {
    const owned = this.#owned.get(pluginId);
    if (!owned) {
      return;
    }
    this.#owned.delete(pluginId);
    for (const item of owned) {
      if (!item.controller.signal.aborted) {
        item.controller.abort(
          new OAuthError(
            "unavailable",
            reason === "shutdown"
              ? "OAuth service is shut down"
              : "OAuth request was aborted",
          ),
        );
      }
    }
  }

  #bump(pluginId: string): void {
    this.#generation.set(pluginId, (this.#generation.get(pluginId) ?? 0) + 1);
  }

  #record(record: OAuthAuditRecord): void {
    this.#audit.push(Object.freeze({ ...record }));
    const overflow = this.#audit.length - this.#auditCapacity;
    if (overflow > 0) {
      this.#audit.splice(0, overflow);
    }
  }

  #classifyInvalid(error: unknown): OAuthAuditFailure {
    const message = error instanceof Error ? error.message : "";
    if (/reserved/i.test(message)) {
      return "reserved-param";
    }
    if (/endpoint/i.test(message) || /https/i.test(message) || /credentials/i.test(message)) {
      return "invalid-endpoint";
    }
    return "invalid-request";
  }

  #classifyConnectFailure(signal: AbortSignal, error: unknown): OAuthAuditFailure {
    if (this.#shutdown.signal.aborted) {
      return "shut-down";
    }
    if (error instanceof OAuthError) {
      if (error.code === "denied") {
        return "denied";
      }
      if (error.message.includes("host")) {
        return "host-mismatch";
      }
      if (error.message.includes("state")) {
        return "state-mismatch";
      }
      if (error.message.includes("code is missing")) {
        return "missing-code";
      }
      if (error.message.includes("query is too large")) {
        return "query-too-large";
      }
      if (error.message.includes("refresh token")) {
        return "missing-refresh-token";
      }
      if (error.message.includes("Opening the authorization")) {
        return "open-external-failed";
      }
      if (error.code === "unavailable") {
        return signal.aborted ? "aborted" : "unavailable";
      }
      if (error.code === "failed") {
        return "token-failed";
      }
      return "invalid-request";
    }
    if (signal.aborted) {
      return "aborted";
    }
    return "token-failed";
  }

  #connectThrow(failure: OAuthAuditFailure, error: unknown): OAuthError {
    if (error instanceof OAuthError) {
      return new OAuthError(error.code, boundUtf8(error.message, MAX_ERROR_MESSAGE_BYTES), {
        cause: error,
      });
    }
    if (failure === "shut-down") {
      return new OAuthError("unavailable", "OAuth service is shut down", {
        cause: error,
      });
    }
    if (failure === "aborted") {
      return new OAuthError("unavailable", "OAuth request was aborted", {
        cause: error,
      });
    }
    return new OAuthError("failed", "OAuth request failed", { cause: error });
  }
}
