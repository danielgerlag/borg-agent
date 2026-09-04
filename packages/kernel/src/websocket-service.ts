import type {
  Disposable,
  PluginWebSocketConnectOptions,
  PluginWebSocketConnection,
} from "@borg/plugin-sdk";

const MAX_MESSAGE_BYTES = 1_048_576;
const MAX_QUEUED_MESSAGES = 256;
const MAX_SOCKETS_PER_PLUGIN = 4;
const OPEN_TIMEOUT_MS = 15_000;
const MAX_PROTOCOLS = 8;
const MAX_PROTOCOL_LENGTH = 64;
const MAX_CLOSE_REASON_BYTES = 123;
const MAX_ERROR_MESSAGE_BYTES = 512;
const DEFAULT_AUDIT_CAPACITY = 256;
const PROTOCOL_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const CLOSE_TOO_LARGE = 1009;
const CLOSE_NORMAL = 1000;
const CLOSE_GOING_AWAY = 1001;
const SOCKET_OPEN = 1;

export class WebSocketError extends Error {
  constructor(
    readonly code: "invalid" | "unavailable" | "closed" | "failed",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WebSocketError";
  }
}

export interface WebSocketAuditRecord {
  readonly pluginId: string;
  readonly origin: string;
  readonly outcome: "opened" | "rejected" | "closed" | "failed";
  readonly code?: number | undefined;
  readonly failure?: string | undefined;
}

export interface WebSocketLike {
  readonly readyState: number;
  binaryType?: string;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type WebSocketFactory = (
  url: string,
  protocols?: readonly string[] | undefined,
) => WebSocketLike;

export interface WebSocketServiceOptions {
  readonly webSocketFactory?: WebSocketFactory | undefined;
  readonly auditCapacity?: number | undefined;
  readonly openTimeoutMs?: number | undefined;
  readonly maxSocketsPerPlugin?: number | undefined;
}

type TeardownReason = "disposed" | "aborted" | "deactivated" | "shutdown";

interface ConnectionScope {
  readonly pluginId: string;
  readonly origin: string;
  readonly maxMessageBytes: number;
  readonly maxQueuedMessages: number;
  readonly openTimeoutMs: number;
  readonly signal?: AbortSignal | undefined;
  audit(record: WebSocketAuditRecord): void;
  release(connection: BrokeredConnection): void;
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
    throw new WebSocketError("invalid", `${description} is invalid`);
  }
  return candidate;
}

function clampBound(
  candidate: number | undefined,
  fallback: number,
  limit: number,
  description: string,
): number {
  if (candidate === undefined) {
    return fallback;
  }
  if (typeof candidate !== "number" || !Number.isFinite(candidate)) {
    throw new WebSocketError("invalid", `${description} is invalid`);
  }
  return Math.min(Math.max(1, Math.floor(candidate)), limit);
}

function defaultWebSocketFactory(
  url: string,
  protocols?: readonly string[] | undefined,
): WebSocketLike {
  const constructor = globalThis.WebSocket;
  if (typeof constructor !== "function") {
    throw new WebSocketError(
      "unavailable",
      "This runtime does not provide WebSocket support",
    );
  }
  const socket =
    protocols && protocols.length > 0
      ? new constructor(url, [...protocols])
      : new constructor(url);
  return socket as unknown as WebSocketLike;
}

function readNumber(source: unknown, key: string): number | undefined {
  if (typeof source !== "object" || source === null) {
    return undefined;
  }
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function readString(source: unknown, key: string): string | undefined {
  if (typeof source !== "object" || source === null) {
    return undefined;
  }
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
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

function readData(event: unknown): unknown {
  if (typeof event !== "object" || event === null) {
    return undefined;
  }
  return (event as Record<string, unknown>).data;
}

function isBlobLike(
  value: unknown,
): value is { readonly size: number; arrayBuffer(): Promise<ArrayBuffer> } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { size?: unknown }).size === "number" &&
    typeof (value as { arrayBuffer?: unknown }).arrayBuffer === "function"
  );
}

function inboundByteSize(data: unknown): number | undefined {
  if (typeof data === "string") {
    return Buffer.byteLength(data, "utf8");
  }
  if (data instanceof ArrayBuffer) {
    return data.byteLength;
  }
  if (ArrayBuffer.isView(data)) {
    return data.byteLength;
  }
  if (isBlobLike(data)) {
    return data.size;
  }
  return undefined;
}

class HandlerSet<TArgs extends readonly unknown[]> {
  readonly #handlers = new Map<
    symbol,
    (...args: TArgs) => void | Promise<void>
  >();

  constructor(private readonly label: string) {}

  add(handler: (...args: TArgs) => void | Promise<void>): Disposable {
    if (typeof handler !== "function") {
      throw new WebSocketError(
        "invalid",
        `WebSocket ${this.label} handler must be a function`,
      );
    }
    const token = Symbol(this.label);
    this.#handlers.set(token, handler);
    return {
      dispose: () => {
        this.#handlers.delete(token);
      },
    };
  }

  async emit(...args: TArgs): Promise<void> {
    for (const handler of [...this.#handlers.values()]) {
      try {
        await handler(...args);
      } catch (error) {
        console.error(`[kernel] websocket ${this.label} handler failed`, error);
      }
    }
  }

  clear(): void {
    this.#handlers.clear();
  }
}

class BrokeredConnection implements PluginWebSocketConnection {
  readonly ready: Promise<void>;
  readonly #socket: WebSocketLike;
  readonly #scope: ConnectionScope;
  readonly #messages = new HandlerSet<[string]>("message");
  readonly #closes = new HandlerSet<[number, string]>("close");
  readonly #errors = new HandlerSet<[Error]>("error");
  readonly #queue: unknown[] = [];
  readonly #listeners: readonly {
    readonly type: string;
    readonly listener: (event: unknown) => void;
  }[];
  readonly #onAbort?: (() => void) | undefined;
  #settle?: { resolve(): void; reject(error: Error): void } | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #opened = false;
  #finished = false;
  #suppressed = false;
  #pumping = false;

  constructor(socket: WebSocketLike, scope: ConnectionScope) {
    this.#socket = socket;
    this.#scope = scope;
    this.ready = new Promise<void>((resolve, reject) => {
      this.#settle = { resolve, reject };
    });
    // Nobody is required to await ready; keep its rejection observed here so a
    // failed handshake cannot surface as an unhandled rejection.
    void this.ready.catch(() => undefined);

    try {
      socket.binaryType = "arraybuffer";
    } catch {
      // Some implementations expose binaryType as read-only; decoding handles
      // both blob and arraybuffer payloads anyway.
    }

    this.#listeners = Object.freeze([
      { type: "open", listener: () => this.#handleOpen() },
      { type: "message", listener: (event: unknown) => this.#handleMessage(event) },
      { type: "close", listener: (event: unknown) => this.#handleClose(event) },
      { type: "error", listener: (event: unknown) => this.#handleError(event) },
    ]);
    for (const { type, listener } of this.#listeners) {
      socket.addEventListener(type, listener);
    }

    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      if (this.#opened || this.#finished) {
        return;
      }
      this.#fail("open-timeout", new WebSocketError("failed", "WebSocket did not open in time"));
    }, scope.openTimeoutMs);

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

  onMessage(handler: (data: string) => void | Promise<void>): Disposable {
    return this.#messages.add(handler);
  }

  onClose(
    handler: (code: number, reason: string) => void | Promise<void>,
  ): Disposable {
    return this.#closes.add(handler);
  }

  onError(handler: (error: Error) => void | Promise<void>): Disposable {
    return this.#errors.add(handler);
  }

  send(data: string): void {
    if (this.#finished || this.#suppressed) {
      throw new WebSocketError("closed", "WebSocket is no longer usable");
    }
    if (typeof data !== "string") {
      throw new WebSocketError("invalid", "WebSocket payloads must be strings");
    }
    if (!this.#opened || this.#socket.readyState !== SOCKET_OPEN) {
      throw new WebSocketError("closed", "WebSocket is not open");
    }
    const size = Buffer.byteLength(data, "utf8");
    if (size > this.#scope.maxMessageBytes) {
      throw new WebSocketError(
        "invalid",
        `WebSocket payload of ${size} bytes exceeds the ${this.#scope.maxMessageBytes} byte limit`,
      );
    }
    try {
      this.#socket.send(data);
    } catch (error) {
      throw new WebSocketError("failed", "WebSocket send failed", {
        cause: error,
      });
    }
  }

  close(code?: number, reason?: string): void {
    if (code !== undefined && (!Number.isInteger(code) || (code !== CLOSE_NORMAL && (code < 3000 || code > 4999)))) {
      throw new WebSocketError(
        "invalid",
        "WebSocket close code must be 1000 or between 3000 and 4999",
      );
    }
    if (reason !== undefined) {
      if (typeof reason !== "string") {
        throw new WebSocketError("invalid", "WebSocket close reason must be a string");
      }
      if (Buffer.byteLength(reason, "utf8") > MAX_CLOSE_REASON_BYTES) {
        throw new WebSocketError(
          "invalid",
          `WebSocket close reason must stay within ${MAX_CLOSE_REASON_BYTES} bytes`,
        );
      }
    }
    this.#closeSocket(code ?? CLOSE_NORMAL, reason);
  }

  dispose(): void {
    this.teardown("disposed");
  }

  teardown(reason: TeardownReason): void {
    if (this.#finished) {
      return;
    }
    this.#suppressed = true;
    this.#queue.length = 0;
    const code = reason === "disposed" ? CLOSE_NORMAL : CLOSE_GOING_AWAY;
    this.#closeSocket(code, undefined);
    this.#finish(code, reason);
  }

  #handleOpen(): void {
    if (this.#finished || this.#suppressed) {
      return;
    }
    this.#opened = true;
    this.#clearTimer();
    this.#scope.audit({
      pluginId: this.#scope.pluginId,
      origin: this.#scope.origin,
      outcome: "opened",
    });
    this.#settle?.resolve();
    this.#settle = undefined;
  }

  #handleMessage(event: unknown): void {
    if (this.#finished || this.#suppressed) {
      return;
    }
    const data = readData(event);
    const size = inboundByteSize(data);
    if (size === undefined) {
      console.error("[kernel] websocket delivered an unsupported payload type");
      return;
    }
    if (size > this.#scope.maxMessageBytes) {
      this.#rejectFrame("message-too-large");
      return;
    }
    const depth = this.#queue.length + (this.#pumping ? 1 : 0);
    if (depth >= this.#scope.maxQueuedMessages) {
      this.#rejectFrame("queue-overflow");
      return;
    }
    this.#queue.push(data);
    void this.#pump();
  }

  async #pump(): Promise<void> {
    if (this.#pumping) {
      return;
    }
    this.#pumping = true;
    try {
      while (this.#queue.length > 0) {
        if (this.#finished || this.#suppressed) {
          this.#queue.length = 0;
          return;
        }
        const next = this.#queue.shift();
        let text: string;
        try {
          text = await decodeFrame(next);
        } catch (error) {
          console.error("[kernel] websocket payload could not be decoded", error);
          continue;
        }
        if (this.#finished || this.#suppressed) {
          this.#queue.length = 0;
          return;
        }
        await this.#messages.emit(text);
      }
    } finally {
      this.#pumping = false;
    }
  }

  #handleClose(event: unknown): void {
    const code = readNumber(event, "code") ?? CLOSE_NORMAL;
    const reason = readString(event, "reason") ?? "";
    if (this.#finished) {
      return;
    }
    if (!this.#opened) {
      this.#scope.audit({
        pluginId: this.#scope.pluginId,
        origin: this.#scope.origin,
        outcome: "failed",
        code,
        failure: "closed-before-open",
      });
      this.#settle?.reject(
        new WebSocketError("closed", "WebSocket closed before it opened"),
      );
      this.#settle = undefined;
      this.#finish(code, "closed");
      return;
    }
    this.#scope.audit({
      pluginId: this.#scope.pluginId,
      origin: this.#scope.origin,
      outcome: "closed",
      code,
    });
    const suppressed = this.#suppressed;
    this.#finish(code, "closed");
    if (!suppressed) {
      void this.#closes.emit(code, boundUtf8(reason, MAX_CLOSE_REASON_BYTES));
    }
    this.#closes.clear();
  }

  #handleError(event: unknown): void {
    if (this.#finished) {
      return;
    }
    const message = boundUtf8(
      readString(event, "message") ?? "WebSocket failed",
      MAX_ERROR_MESSAGE_BYTES,
    );
    const error = new WebSocketError("failed", message);
    if (!this.#opened) {
      this.#fail("handshake-failed", error);
      return;
    }
    this.#scope.audit({
      pluginId: this.#scope.pluginId,
      origin: this.#scope.origin,
      outcome: "failed",
      failure: "socket-error",
    });
    if (!this.#suppressed) {
      void this.#errors.emit(error);
    }
  }

  #rejectFrame(failure: "message-too-large" | "queue-overflow"): void {
    this.#suppressed = true;
    this.#queue.length = 0;
    this.#scope.audit({
      pluginId: this.#scope.pluginId,
      origin: this.#scope.origin,
      outcome: "failed",
      code: CLOSE_TOO_LARGE,
      failure,
    });
    this.#closeSocket(CLOSE_TOO_LARGE, undefined);
    this.#finish(CLOSE_TOO_LARGE, failure);
  }

  #fail(failure: string, error: Error): void {
    this.#scope.audit({
      pluginId: this.#scope.pluginId,
      origin: this.#scope.origin,
      outcome: "failed",
      failure,
    });
    this.#settle?.reject(error);
    this.#settle = undefined;
    this.#suppressed = true;
    this.#closeSocket(CLOSE_NORMAL, undefined);
    this.#finish(CLOSE_NORMAL, failure);
  }

  #closeSocket(code: number, reason: string | undefined): void {
    try {
      // Reserved codes such as 1009 are rejected by the WHATWG close() API, so
      // fall back to a normal closure while the audit keeps the real cause.
      if (reason === undefined) {
        this.#socket.close(code);
      } else {
        this.#socket.close(code, reason);
      }
    } catch {
      try {
        this.#socket.close(CLOSE_NORMAL);
      } catch (error) {
        console.error("[kernel] websocket could not be closed", error);
      }
    }
  }

  #finish(code: number, reason: string): void {
    if (this.#finished) {
      return;
    }
    this.#finished = true;
    this.#clearTimer();
    this.#queue.length = 0;
    for (const { type, listener } of this.#listeners) {
      try {
        this.#socket.removeEventListener(type, listener);
      } catch (error) {
        console.error("[kernel] websocket listener removal failed", error);
      }
    }
    if (this.#onAbort && this.#scope.signal) {
      this.#scope.signal.removeEventListener("abort", this.#onAbort);
    }
    if (this.#settle) {
      this.#settle.reject(
        new WebSocketError("closed", `WebSocket was ${reason} with code ${code}`),
      );
      this.#settle = undefined;
    }
    this.#messages.clear();
    this.#errors.clear();
    this.#scope.release(this);
  }

  #clearTimer(): void {
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }
}

async function decodeFrame(data: unknown): Promise<string> {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof ArrayBuffer) {
    return new TextDecoder().decode(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new TextDecoder().decode(data);
  }
  if (isBlobLike(data)) {
    return new TextDecoder().decode(await data.arrayBuffer());
  }
  throw new WebSocketError("invalid", "WebSocket payload type is unsupported");
}

export class WebSocketService {
  readonly #factory: WebSocketFactory;
  readonly #auditCapacity: number;
  readonly #openTimeoutMs: number;
  readonly #maxSocketsPerPlugin: number;
  readonly #owned = new Map<string, Set<BrokeredConnection>>();
  readonly #audit: WebSocketAuditRecord[] = [];
  readonly #shutdown = new AbortController();

  constructor(options: WebSocketServiceOptions = {}) {
    this.#factory = options.webSocketFactory ?? defaultWebSocketFactory;
    this.#auditCapacity = positiveBound(
      options.auditCapacity,
      DEFAULT_AUDIT_CAPACITY,
      "WebSocket audit capacity",
    );
    this.#openTimeoutMs = positiveBound(
      options.openTimeoutMs,
      OPEN_TIMEOUT_MS,
      "WebSocket open timeout",
    );
    this.#maxSocketsPerPlugin = Math.min(
      positiveBound(
        options.maxSocketsPerPlugin,
        MAX_SOCKETS_PER_PLUGIN,
        "WebSocket socket bound",
      ),
      MAX_SOCKETS_PER_PLUGIN,
    );
  }

  async connect(
    pluginId: string,
    url: string,
    options?: PluginWebSocketConnectOptions | undefined,
  ): Promise<PluginWebSocketConnection> {
    if (this.#shutdown.signal.aborted) {
      throw new WebSocketError("unavailable", "WebSocket service is shut down");
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch (error) {
      this.#record({
        pluginId,
        origin: "null",
        outcome: "rejected",
        failure: "invalid-url",
      });
      throw new WebSocketError("invalid", "WebSocket URL is invalid", {
        cause: error,
      });
    }
    const origin = parsed.origin;
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
      this.#record({
        pluginId,
        origin,
        outcome: "rejected",
        failure: "unsupported-protocol",
      });
      throw new WebSocketError("invalid", "Only ws and wss URLs are allowed");
    }
    if (parsed.username !== "" || parsed.password !== "") {
      this.#record({
        pluginId,
        origin,
        outcome: "rejected",
        failure: "url-credentials",
      });
      throw new WebSocketError(
        "invalid",
        "WebSocket URLs must not include credentials",
      );
    }
    if (options?.signal?.aborted) {
      this.#record({
        pluginId,
        origin,
        outcome: "rejected",
        failure: "aborted",
      });
      throw new WebSocketError("unavailable", "WebSocket request was aborted");
    }
    const live = this.#owned.get(pluginId);
    if (live && live.size >= this.#maxSocketsPerPlugin) {
      this.#record({
        pluginId,
        origin,
        outcome: "rejected",
        failure: "socket-limit",
      });
      throw new WebSocketError(
        "unavailable",
        `Plugin ${pluginId} already holds ${this.#maxSocketsPerPlugin} sockets`,
      );
    }

    let protocols: readonly string[] | undefined;
    if (options?.protocols !== undefined) {
      if (
        !Array.isArray(options.protocols) ||
        options.protocols.length > MAX_PROTOCOLS ||
        !options.protocols.every(
          (protocol) =>
            typeof protocol === "string" &&
            protocol.length > 0 &&
            protocol.length <= MAX_PROTOCOL_LENGTH &&
            PROTOCOL_TOKEN.test(protocol),
        ) ||
        new Set(options.protocols).size !== options.protocols.length
      ) {
        this.#record({
          pluginId,
          origin,
          outcome: "rejected",
          failure: "invalid-subprotocol",
        });
        throw new WebSocketError(
          "invalid",
          "WebSocket subprotocols are invalid",
        );
      }
      protocols = [...options.protocols];
    }

    const maxMessageBytes = clampBound(
      options?.maxMessageBytes,
      MAX_MESSAGE_BYTES,
      MAX_MESSAGE_BYTES,
      "WebSocket message bound",
    );
    const maxQueuedMessages = clampBound(
      options?.maxQueuedMessages,
      MAX_QUEUED_MESSAGES,
      MAX_QUEUED_MESSAGES,
      "WebSocket queue bound",
    );

    let socket: WebSocketLike;
    try {
      socket = this.#factory(parsed.href, protocols);
    } catch (error) {
      this.#record({
        pluginId,
        origin,
        outcome: "failed",
        failure: "connect-failed",
      });
      throw error instanceof WebSocketError
        ? error
        : new WebSocketError("failed", "WebSocket could not be created", {
            cause: error,
          });
    }

    const connection = new BrokeredConnection(socket, {
      pluginId,
      origin,
      maxMessageBytes,
      maxQueuedMessages,
      openTimeoutMs: this.#openTimeoutMs,
      audit: (record) => this.#record(record),
      release: (released) => this.#release(pluginId, released),
      ...(options?.signal ? { signal: options.signal } : {}),
    });
    const owned = this.#owned.get(pluginId) ?? new Set<BrokeredConnection>();
    owned.add(connection);
    this.#owned.set(pluginId, owned);
    if (connection.finished) {
      this.#release(pluginId, connection);
    }
    return connection;
  }

  abortOwned(pluginId: string): void {
    const owned = this.#owned.get(pluginId);
    if (!owned) {
      return;
    }
    this.#owned.delete(pluginId);
    for (const connection of [...owned]) {
      connection.teardown("deactivated");
    }
  }

  shutdown(): void {
    if (!this.#shutdown.signal.aborted) {
      this.#shutdown.abort(new Error("WebSocket service is shutting down"));
    }
    for (const [pluginId, owned] of [...this.#owned]) {
      this.#owned.delete(pluginId);
      for (const connection of [...owned]) {
        connection.teardown("shutdown");
      }
    }
  }

  countOwned(pluginId: string): number {
    return this.#owned.get(pluginId)?.size ?? 0;
  }

  listAudit(): readonly WebSocketAuditRecord[] {
    return this.#audit.map((record) => Object.freeze({ ...record }));
  }

  #release(pluginId: string, connection: BrokeredConnection): void {
    const owned = this.#owned.get(pluginId);
    if (!owned) {
      return;
    }
    owned.delete(connection);
    if (owned.size === 0) {
      this.#owned.delete(pluginId);
    }
  }

  #record(record: WebSocketAuditRecord): void {
    this.#audit.push(Object.freeze({ ...record }));
    const overflow = this.#audit.length - this.#auditCapacity;
    if (overflow > 0) {
      this.#audit.splice(0, overflow);
    }
  }
}
