import { connect as tlsConnect } from "node:tls";
import { Duplex } from "node:stream";
import type {
  PluginTlsConnectOptions,
  PluginTlsSocket,
} from "@borg/plugin-sdk";

const MAX_SOCKETS_PER_PLUGIN = 4;
const HANDSHAKE_TIMEOUT_MS = 15_000;
const DEFAULT_AUDIT_CAPACITY = 256;
const MAX_HOST_LENGTH = 253;
const MAX_ERROR_MESSAGE_BYTES = 512;

const CERT_FAILURE_CODES = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_UNTRUSTED",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_REVOKED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_SSL_CERTIFICATE_VERIFY_FAILED",
]);

export class TlsError extends Error {
  constructor(
    readonly code: "invalid" | "unavailable" | "failed" | "closed",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "TlsError";
  }
}

export type TlsAuditFailure =
  | "invalid-host"
  | "invalid-port"
  | "invalid-servername"
  | "aborted"
  | "socket-limit"
  | "handshake-timeout"
  | "cert-untrusted"
  | "connect-failed"
  | "shut-down"
  | "socket-error";

export interface TlsAuditRecord {
  readonly pluginId: string;
  readonly host: string;
  readonly port: number;
  readonly servername: string;
  readonly outcome: "opened" | "rejected" | "closed" | "failed";
  readonly failure?: TlsAuditFailure | undefined;
}

export interface TlsAuthority {
  readonly host: string;
  readonly port: number;
  readonly servername: string;
}

export interface TlsTransport {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  destroy(error?: Error): void;
}

export type TlsConnectFactory = (options: {
  readonly host: string;
  readonly port: number;
  readonly servername: string;
  readonly signal: AbortSignal;
}) => Promise<TlsTransport>;

export interface TlsServiceOptions {
  readonly tlsConnect?: TlsConnectFactory | undefined;
  readonly auditCapacity?: number | undefined;
  readonly handshakeTimeoutMs?: number | undefined;
  readonly maxSocketsPerPlugin?: number | undefined;
}

type TeardownReason = "disposed" | "aborted" | "deactivated" | "shutdown";

interface OwnedTls {
  readonly finished: boolean;
  teardown(reason: TeardownReason): void;
}

interface SocketScope {
  readonly pluginId: string;
  readonly host: string;
  readonly port: number;
  readonly servername: string;
  readonly signal?: AbortSignal | undefined;
  audit(record: TlsAuditRecord): void;
  release(owned: OwnedTls): void;
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
    throw new TlsError("invalid", `${description} is invalid`);
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

function looksLikeHostPort(value: string): boolean {
  return /^\[[^\]]+\]:\d+$/.test(value) || /^[^[\]:]+:\d+$/.test(value);
}

function stripIpv6Brackets(value: string): string {
  if (value.startsWith("[") && value.endsWith("]")) {
    return value.slice(1, -1);
  }
  return value;
}

function isForbiddenHostChar(value: string): boolean {
  return /[\0\s/?#@\\]/.test(value);
}

function isPlausibleHost(value: string): boolean {
  if (value.length === 0 || value.length > MAX_HOST_LENGTH) {
    return false;
  }
  if (isForbiddenHostChar(value) || value.startsWith("/") || value.startsWith(".")) {
    return false;
  }
  if (looksLikeHostPort(value)) {
    return false;
  }
  const unbracketed = stripIpv6Brackets(value);
  if (unbracketed.length === 0 || /[\[\]]/.test(unbracketed)) {
    return false;
  }
  if (unbracketed.includes(":")) {
    return /^[0-9a-fA-F:]+$/.test(unbracketed) && unbracketed.includes("::")
      ? true
      : (unbracketed.match(/:/g) ?? []).length >= 2;
  }
  return /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(unbracketed);
}

function auditText(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  return boundUtf8(value.replace(/[\0-\u001F]/g, ""), MAX_HOST_LENGTH);
}

function auditPort(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function parseTlsAuthority(
  options: PluginTlsConnectOptions,
): TlsAuthority {
  if (typeof options.host !== "string" || !isPlausibleHost(options.host)) {
    throw new TlsError("invalid", "TLS host is invalid");
  }
  const host = stripIpv6Brackets(options.host);
  if (!isPlausibleHost(host) || looksLikeHostPort(host)) {
    throw new TlsError("invalid", "TLS host is invalid");
  }

  const port = options.port;
  if (
    typeof port !== "number" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    throw new TlsError("invalid", "TLS port is invalid");
  }

  const servernameInput = options.servername;
  const servername =
    servernameInput === undefined ? host : stripIpv6Brackets(servernameInput);
  if (
    typeof servername !== "string" ||
    !isPlausibleHost(servername) ||
    looksLikeHostPort(servername)
  ) {
    throw new TlsError("invalid", "TLS servername is invalid");
  }

  return { host, port, servername };
}

function classifyParseFailure(error: unknown): TlsAuditFailure {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("port")) {
    return "invalid-port";
  }
  if (message.includes("servername")) {
    return "invalid-servername";
  }
  return "invalid-host";
}

function readErrorCode(error: unknown): string {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return "";
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : "";
}

function isCertUntrusted(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 6; depth += 1) {
    if (typeof current !== "object" || current === null) {
      return false;
    }
    const code = readErrorCode(current);
    const rawMessage =
      current instanceof Error
        ? current.message
        : typeof (current as { message?: unknown }).message === "string"
          ? (current as { message: string }).message
          : "";
    const message = rawMessage.replace(
      /-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g,
      "",
    );
    if (
      CERT_FAILURE_CODES.has(code) ||
      /certificat|self-signed|unable to verify|untrusted|altname/i.test(
        message,
      )
    ) {
      return true;
    }
    current = "cause" in current ? (current as { cause?: unknown }).cause : undefined;
  }
  return false;
}

function sanitizeTlsMessage(message: string): string {
  const withoutPem = message.replace(
    /-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g,
    "[redacted]",
  );
  const withoutPaths = withoutPem.replace(
    /(?:\/(?:[^\s"'`]+\/)+[^\s"'`]+|[A-Za-z]:\\[^\s"'`]+)/g,
    "[redacted]",
  );
  return boundUtf8(withoutPaths, MAX_ERROR_MESSAGE_BYTES);
}

function mapConnectError(error: unknown): TlsError {
  if (error instanceof TlsError) {
    return new TlsError(error.code, sanitizeTlsMessage(error.message), {
      cause: error,
    });
  }
  const message =
    error instanceof Error && error.message.length > 0
      ? error.message
      : "TLS connect failed";
  if (isCertUntrusted(error)) {
    return new TlsError("failed", "TLS certificate is untrusted", {
      cause: error,
    });
  }
  return new TlsError("failed", sanitizeTlsMessage(message), { cause: error });
}

function defaultTlsConnectFactory(options: {
  readonly host: string;
  readonly port: number;
  readonly servername: string;
  readonly signal: AbortSignal;
}): Promise<TlsTransport> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const socket = tlsConnect({
      host: options.host,
      port: options.port,
      servername: options.servername,
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
    });

    const finish = (error?: TlsError, transport?: TlsTransport): void => {
      if (settled) {
        if (error) {
          socket.destroy();
        }
        return;
      }
      settled = true;
      options.signal.removeEventListener("abort", onAbort);
      socket.removeListener("secureConnect", onSecure);
      socket.removeListener("error", onError);
      if (error) {
        socket.destroy();
        reject(error);
        return;
      }
      if (!transport) {
        socket.destroy();
        reject(new TlsError("failed", "TLS connect failed"));
        return;
      }
      resolve(transport);
    };

    const onAbort = (): void => {
      finish(new TlsError("unavailable", "TLS connect was aborted"));
    };
    const onSecure = (): void => {
      const web = Duplex.toWeb(socket) as {
        readable: ReadableStream<Uint8Array>;
        writable: WritableStream<Uint8Array>;
      };
      finish(undefined, {
        readable: web.readable,
        writable: web.writable,
        destroy(error) {
          socket.destroy(error);
        },
      });
    };
    const onError = (error: Error): void => {
      finish(mapConnectError(error));
    };

    if (options.signal.aborted) {
      onAbort();
      return;
    }
    options.signal.addEventListener("abort", onAbort, { once: true });
    socket.once("secureConnect", onSecure);
    socket.once("error", onError);
  });
}

class PendingHandshake implements OwnedTls {
  readonly controller = new AbortController();
  #finished = false;

  get finished(): boolean {
    return this.#finished;
  }

  teardown(reason: TeardownReason): void {
    if (this.#finished) {
      return;
    }
    this.#finished = true;
    if (!this.controller.signal.aborted) {
      this.controller.abort(
        new TlsError("unavailable", `TLS handshake was ${reason}`),
      );
    }
  }
}

class BrokeredTlsSocket implements PluginTlsSocket, OwnedTls {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  readonly closed: Promise<void>;
  readonly #transport: TlsTransport;
  readonly #scope: SocketScope;
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #writer: WritableStreamDefaultWriter<Uint8Array>;
  readonly #onAbort?: (() => void) | undefined;
  #resolveClosed: () => void = () => undefined;
  #finished = false;
  #failure: TlsAuditFailure | undefined;

  constructor(transport: TlsTransport, scope: SocketScope) {
    this.#transport = transport;
    this.#scope = scope;
    this.#reader = transport.readable.getReader();
    this.#writer = transport.writable.getWriter();
    this.closed = new Promise<void>((resolve) => {
      this.#resolveClosed = resolve;
    });
    const self = this;
    this.readable = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (self.#finished) {
          controller.close();
          return;
        }
        try {
          const result = await self.#reader.read();
          if (self.#finished) {
            controller.close();
            return;
          }
          if (result.done) {
            controller.close();
            self.#finish("closed");
            return;
          }
          controller.enqueue(result.value);
        } catch (error) {
          if (self.#finished) {
            controller.close();
            return;
          }
          self.#failure = "socket-error";
          controller.error(
            new TlsError("failed", "TLS socket failed", { cause: error }),
          );
          self.#finish("failed");
        }
      },
      cancel() {
        return self.#reader.cancel().then(
          () => undefined,
          () => undefined,
        );
      },
    });
    this.writable = new WritableStream<Uint8Array>({
      async write(chunk) {
        if (self.#finished) {
          throw new TlsError("closed", "TLS socket is closed");
        }
        try {
          await self.#writer.write(chunk);
        } catch (error) {
          if (self.#finished) {
            throw new TlsError("closed", "TLS socket is closed", {
              cause: error,
            });
          }
          self.#failure = "socket-error";
          self.#finish("failed");
          throw new TlsError("failed", "TLS write failed", { cause: error });
        }
      },
      async close() {
        if (self.#finished) {
          return;
        }
        try {
          await self.#writer.close();
        } catch {
          // The transport may already be destroyed by teardown.
        }
      },
      abort(reason) {
        return self.#writer.abort(reason).then(
          () => undefined,
          () => undefined,
        );
      },
    });

    if (scope.signal) {
      const onAbort = (): void => {
        this.teardown("aborted");
      };
      this.#onAbort = onAbort;
      scope.signal.addEventListener("abort", onAbort, { once: true });
      if (scope.signal.aborted) {
        this.teardown("aborted");
      }
    }
  }

  get finished(): boolean {
    return this.#finished;
  }

  close(): Promise<void> {
    this.teardown("disposed");
    return this.closed;
  }

  dispose(): void {
    void this.close();
  }

  teardown(reason: TeardownReason): void {
    if (this.#finished) {
      return;
    }
    try {
      this.#transport.destroy(
        new TlsError("closed", `TLS socket was ${reason}`),
      );
    } catch {
      // destroy is best-effort
    }
    void this.#reader.cancel().catch(() => undefined);
    void this.#writer.abort().catch(() => undefined);
    this.#finish("closed");
  }

  #finish(outcome: "closed" | "failed"): void {
    if (this.#finished) {
      return;
    }
    this.#finished = true;
    if (this.#onAbort && this.#scope.signal) {
      this.#scope.signal.removeEventListener("abort", this.#onAbort);
    }
    const failure = this.#failure;
    if (outcome === "failed") {
      this.#scope.audit({
        pluginId: this.#scope.pluginId,
        host: this.#scope.host,
        port: this.#scope.port,
        servername: this.#scope.servername,
        outcome: "failed",
        ...(failure ? { failure } : { failure: "socket-error" }),
      });
    } else {
      this.#scope.audit({
        pluginId: this.#scope.pluginId,
        host: this.#scope.host,
        port: this.#scope.port,
        servername: this.#scope.servername,
        outcome: "closed",
      });
    }
    this.#scope.release(this);
    this.#resolveClosed();
  }
}

export class TlsService {
  readonly #tlsConnect: TlsConnectFactory;
  readonly #auditCapacity: number;
  readonly #handshakeTimeoutMs: number;
  readonly #maxSocketsPerPlugin: number;
  readonly #owned = new Map<string, Set<OwnedTls>>();
  readonly #audit: TlsAuditRecord[] = [];
  readonly #shutdown = new AbortController();

  constructor(options: TlsServiceOptions = {}) {
    this.#tlsConnect = options.tlsConnect ?? defaultTlsConnectFactory;
    this.#auditCapacity = positiveBound(
      options.auditCapacity,
      DEFAULT_AUDIT_CAPACITY,
      "TLS audit capacity",
    );
    this.#handshakeTimeoutMs = positiveBound(
      options.handshakeTimeoutMs,
      HANDSHAKE_TIMEOUT_MS,
      "TLS handshake timeout",
    );
    this.#maxSocketsPerPlugin = Math.min(
      positiveBound(
        options.maxSocketsPerPlugin,
        MAX_SOCKETS_PER_PLUGIN,
        "TLS socket bound",
      ),
      MAX_SOCKETS_PER_PLUGIN,
    );
  }

  async connect(
    pluginId: string,
    options: PluginTlsConnectOptions,
  ): Promise<PluginTlsSocket> {
    const attempted = {
      host: auditText(options.host),
      port: auditPort(options.port),
      servername: auditText(
        options.servername === undefined ? options.host : options.servername,
      ),
    };
    if (this.#shutdown.signal.aborted) {
      this.#record({
        pluginId,
        ...attempted,
        outcome: "rejected",
        failure: "shut-down",
      });
      throw new TlsError("unavailable", "TLS service is shut down");
    }

    let authority: TlsAuthority;
    try {
      authority = parseTlsAuthority(options);
    } catch (error) {
      this.#record({
        pluginId,
        ...attempted,
        outcome: "rejected",
        failure: classifyParseFailure(error),
      });
      throw error instanceof TlsError
        ? error
        : new TlsError("invalid", "TLS destination is invalid", {
            cause: error,
          });
    }

    if (options.signal?.aborted) {
      this.#record({
        pluginId,
        host: authority.host,
        port: authority.port,
        servername: authority.servername,
        outcome: "rejected",
        failure: "aborted",
      });
      throw new TlsError("unavailable", "TLS connect was aborted");
    }

    const live = this.#owned.get(pluginId);
    if (live && live.size >= this.#maxSocketsPerPlugin) {
      this.#record({
        pluginId,
        host: authority.host,
        port: authority.port,
        servername: authority.servername,
        outcome: "rejected",
        failure: "socket-limit",
      });
      throw new TlsError(
        "unavailable",
        `Plugin ${pluginId} already holds ${this.#maxSocketsPerPlugin} sockets`,
      );
    }

    // In-flight handshakes occupy an owned slot so abortOwned and the cap
    // apply before the socket exists.
    const pending = new PendingHandshake();
    this.#addOwned(pluginId, pending);

    const timeout = new AbortController();
    const timer = setTimeout(() => {
      timeout.abort(new TlsError("failed", "TLS handshake timed out"));
    }, this.#handshakeTimeoutMs);

    const signal = AbortSignal.any([
      ...(options.signal ? [options.signal] : []),
      pending.controller.signal,
      this.#shutdown.signal,
      timeout.signal,
    ]);

    let transport: TlsTransport;
    try {
      transport = await this.#tlsConnect({
        host: authority.host,
        port: authority.port,
        servername: authority.servername,
        signal,
      });
    } catch (error) {
      clearTimeout(timer);
      const failure = this.#classifyConnectFailure(signal, timeout.signal, error);
      this.#release(pluginId, pending);
      pending.teardown("aborted");
      this.#record({
        pluginId,
        host: authority.host,
        port: authority.port,
        servername: authority.servername,
        outcome: "failed",
        failure,
      });
      throw this.#connectThrow(failure, error);
    }
    clearTimeout(timer);

    if (
      pending.finished ||
      this.#shutdown.signal.aborted ||
      options.signal?.aborted
    ) {
      try {
        transport.destroy();
      } catch {
        // already gone
      }
      this.#release(pluginId, pending);
      const failure = this.#shutdown.signal.aborted
        ? "shut-down"
        : "aborted";
      this.#record({
        pluginId,
        host: authority.host,
        port: authority.port,
        servername: authority.servername,
        outcome: "failed",
        failure,
      });
      throw new TlsError(
        "unavailable",
        failure === "shut-down"
          ? "TLS service is shut down"
          : "TLS connect was aborted",
      );
    }

    this.#release(pluginId, pending);
    const socket = new BrokeredTlsSocket(transport, {
      pluginId,
      host: authority.host,
      port: authority.port,
      servername: authority.servername,
      audit: (record) => this.#record(record),
      release: (owned) => this.#release(pluginId, owned),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    this.#addOwned(pluginId, socket);
    if (socket.finished) {
      this.#release(pluginId, socket);
      throw new TlsError("unavailable", "TLS connect was aborted");
    }
    this.#record({
      pluginId,
      host: authority.host,
      port: authority.port,
      servername: authority.servername,
      outcome: "opened",
    });
    return socket;
  }

  abortOwned(pluginId: string): void {
    const owned = this.#owned.get(pluginId);
    if (!owned) {
      return;
    }
    this.#owned.delete(pluginId);
    for (const socket of [...owned]) {
      socket.teardown("deactivated");
    }
  }

  shutdown(): void {
    if (!this.#shutdown.signal.aborted) {
      this.#shutdown.abort(new Error("TLS service is shutting down"));
    }
    for (const [pluginId, owned] of [...this.#owned]) {
      this.#owned.delete(pluginId);
      for (const socket of [...owned]) {
        socket.teardown("shutdown");
      }
    }
  }

  countOwned(pluginId: string): number {
    return this.#owned.get(pluginId)?.size ?? 0;
  }

  listAudit(): readonly TlsAuditRecord[] {
    return this.#audit.map((record) => Object.freeze({ ...record }));
  }

  #addOwned(pluginId: string, owned: OwnedTls): void {
    const set = this.#owned.get(pluginId) ?? new Set<OwnedTls>();
    set.add(owned);
    this.#owned.set(pluginId, set);
  }

  #release(pluginId: string, owned: OwnedTls): void {
    const set = this.#owned.get(pluginId);
    if (!set) {
      return;
    }
    set.delete(owned);
    if (set.size === 0) {
      this.#owned.delete(pluginId);
    }
  }

  #record(record: TlsAuditRecord): void {
    this.#audit.push(Object.freeze({ ...record }));
    const overflow = this.#audit.length - this.#auditCapacity;
    if (overflow > 0) {
      this.#audit.splice(0, overflow);
    }
  }

  #classifyConnectFailure(
    signal: AbortSignal,
    timeoutSignal: AbortSignal,
    error: unknown,
  ): TlsAuditFailure {
    if (this.#shutdown.signal.aborted) {
      return "shut-down";
    }
    if (timeoutSignal.aborted) {
      return "handshake-timeout";
    }
    if (signal.aborted) {
      return "aborted";
    }
    if (isCertUntrusted(error)) {
      return "cert-untrusted";
    }
    return "connect-failed";
  }

  #connectThrow(failure: TlsAuditFailure, error: unknown): TlsError {
    if (failure === "shut-down") {
      return new TlsError("unavailable", "TLS service is shut down", {
        cause: error,
      });
    }
    if (failure === "aborted") {
      return new TlsError("unavailable", "TLS connect was aborted", {
        cause: error,
      });
    }
    if (failure === "handshake-timeout") {
      return new TlsError("failed", "TLS handshake timed out", {
        cause: error,
      });
    }
    if (failure === "cert-untrusted") {
      return new TlsError("failed", "TLS certificate is untrusted", {
        cause: error,
      });
    }
    return mapConnectError(error);
  }
}
