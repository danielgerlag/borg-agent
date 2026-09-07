import type {
  ChannelAdapter,
  ChannelAdapterReceipt,
  ChannelInboundDraft,
  ChannelSendRequest,
  DataClassification,
  Disposable,
  PluginLogger,
  PluginRuntime,
  PluginTls,
} from "@borg/plugin-sdk";
import { ImapSession } from "./imap-session";

export const IMAP_CHANNEL_ADAPTER_ID = "borg.channel.imap";
export const IMAP_PASSWORD_SECRET_KEY = "password";
export const IMAP_DEFAULT_MAILBOX = "INBOX";

export interface ImapOutboundRecord {
  readonly idempotencyKey: string;
  readonly destinationId: string;
  readonly text: string;
  readonly externalId: string;
  readonly sentAt: string;
}

export interface ImapChannelInjectInput {
  readonly text: string;
  readonly destinationId?: string | undefined;
  readonly externalId?: string | undefined;
  readonly sender?: string | undefined;
  readonly classification?: DataClassification | undefined;
}

export interface ImapChannelInjectResult {
  readonly accepted: true;
  readonly externalId: string;
}

export class ImapChannelDisposedError extends Error {
  constructor(message = "IMAP channel is disposed") {
    super(message);
    this.name = "ImapChannelDisposedError";
  }
}

export class ImapChannelNotStartedError extends Error {
  constructor(message = "IMAP channel has no active ingest") {
    super(message);
    this.name = "ImapChannelNotStartedError";
  }
}

export interface ImapTransportLiveOptions {
  readonly tls?: PluginTls | undefined;
  readonly runtime?: PluginRuntime | undefined;
  readonly logger?: PluginLogger | undefined;
  readonly readPassword?: (() => Promise<string | undefined>) | undefined;
}

export class ImapFakeTransport implements ChannelAdapter {
  readonly id = IMAP_CHANNEL_ADAPTER_ID;
  readonly capacity = "private" as const;
  destinations: readonly string[] = [IMAP_DEFAULT_MAILBOX];

  readonly #tls: PluginTls | undefined;
  readonly #runtime: PluginRuntime | undefined;
  readonly #logger: PluginLogger | undefined;
  readonly #readPassword: (() => Promise<string | undefined>) | undefined;
  #host = "";
  #port = 993;
  #username = "";
  #session: ImapSession | undefined;
  #task: Disposable | undefined;
  #disposed = false;
  #ingest: ((draft: ChannelInboundDraft) => void | Promise<void>) | undefined;
  readonly #outbound = new Map<string, ImapOutboundRecord>();
  readonly #pending = new Map<string, Promise<ChannelAdapterReceipt>>();
  #inboundSequence = 0;

  constructor(options: ImapTransportLiveOptions = {}) {
    this.#tls = options.tls;
    this.#runtime = options.runtime;
    this.#logger = options.logger;
    this.#readPassword = options.readPassword;
  }

  configureEndpoint(options: {
    readonly host: string;
    readonly port: number;
    readonly username: string;
  }): void {
    this.#host = options.host;
    this.#port = options.port;
    this.#username = options.username;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  listOutbound(): readonly ImapOutboundRecord[] {
    return Object.freeze(
      [...this.#outbound.values()].map((record) => Object.freeze({ ...record })),
    );
  }

  start(options: {
    readonly ingest: (draft: ChannelInboundDraft) => void | Promise<void>;
    readonly signal: AbortSignal;
  }): Disposable {
    this.#assertLive();
    options.signal.throwIfAborted();
    void this.#stopSession();
    this.#ingest = options.ingest;
    const onAbort = (): void => {
      this.#clearIngest();
      void this.#stopSession();
    };
    options.signal.addEventListener("abort", onAbort, { once: true });
    this.#startSession(options.ingest, options.signal);
    return {
      dispose: async () => {
        options.signal.removeEventListener("abort", onAbort);
        await this.#stopSession();
        this.#clearIngest();
      },
    };
  }

  async send(request: ChannelSendRequest): Promise<ChannelAdapterReceipt> {
    this.#assertLive();
    request.signal?.throwIfAborted();
    const existing = this.#receiptFor(request.idempotencyKey);
    if (existing) {
      return existing;
    }
    const pending = this.#pending.get(request.idempotencyKey);
    if (pending) {
      return pending;
    }
    const created = this.#dispatchSend(request);
    this.#pending.set(request.idempotencyKey, created);
    try {
      return await created;
    } finally {
      if (this.#pending.get(request.idempotencyKey) === created) {
        this.#pending.delete(request.idempotencyKey);
      }
    }
  }

  async inject(
    input: ImapChannelInjectInput,
    signal?: AbortSignal,
  ): Promise<ImapChannelInjectResult> {
    this.#assertLive();
    signal?.throwIfAborted();
    const ingest = this.#ingest;
    if (!ingest) {
      throw new ImapChannelNotStartedError();
    }
    const externalId =
      input.externalId ?? `imap-in:${String((this.#inboundSequence += 1))}`;
    const draft: ChannelInboundDraft = {
      text: input.text,
      destinationId: input.destinationId ?? this.destinations[0] ?? IMAP_DEFAULT_MAILBOX,
      externalId,
      receivedAt: new Date().toISOString(),
      ...(input.sender !== undefined ? { sender: input.sender } : {}),
      ...(input.classification !== undefined
        ? { classification: input.classification }
        : {}),
    };
    await ingest(draft);
    this.#assertLive();
    signal?.throwIfAborted();
    return Object.freeze({ accepted: true as const, externalId });
  }

  dispose(): void {
    this.#disposed = true;
    void this.#stopSession();
    this.#clearIngest();
    this.#pending.clear();
  }

  #startSession(
    ingest: (draft: ChannelInboundDraft) => void | Promise<void>,
    signal: AbortSignal,
  ): void {
    const tls = this.#tls;
    const readPassword = this.#readPassword;
    if (!tls || !readPassword || this.#host.length === 0 || this.#username.length === 0) {
      return;
    }
    const session = new ImapSession({
      tls,
      readPassword,
      host: this.#host,
      port: this.#port,
      username: this.#username,
      mailbox: this.destinations[0] ?? IMAP_DEFAULT_MAILBOX,
      ingest,
    });
    this.#session = session;
    const run = (taskSignal: AbortSignal): Promise<void> =>
      session.run(AbortSignal.any([taskSignal, signal])).catch((error: unknown) => {
        this.#logger?.error("IMAP TLS session failed", {
          reason: error instanceof Error ? error.message : "failed",
        });
      });
    try {
      if (!this.#runtime) {
        throw new Error("IMAP background runtime is unavailable");
      }
      this.#task = this.#runtime.spawn(run);
    } catch {
      void run(signal);
    }
  }

  async #stopSession(): Promise<void> {
    const task = this.#task;
    const session = this.#session;
    this.#task = undefined;
    this.#session = undefined;
    task?.dispose();
    await session?.dispose();
  }

  async #dispatchSend(request: ChannelSendRequest): Promise<ChannelAdapterReceipt> {
    const session = this.#session;
    if (session?.connected) {
      const receipt = await session.append(request.text, request.signal);
      this.#outbound.set(
        request.idempotencyKey,
        Object.freeze({
          idempotencyKey: request.idempotencyKey,
          destinationId: request.destinationId,
          text: request.text,
          externalId: receipt.externalId,
          sentAt: receipt.sentAt,
        }),
      );
      return Object.freeze({
        externalId: receipt.externalId,
        sentAt: receipt.sentAt,
      });
    }
    return this.#commitSend(request);
  }

  #commitSend(request: ChannelSendRequest): ChannelAdapterReceipt {
    this.#assertLive();
    request.signal?.throwIfAborted();
    const existing = this.#receiptFor(request.idempotencyKey);
    if (existing) {
      return existing;
    }
    const sentAt = new Date().toISOString();
    const externalId = `imap:${request.idempotencyKey}`;
    this.#outbound.set(
      request.idempotencyKey,
      Object.freeze({
        idempotencyKey: request.idempotencyKey,
        destinationId: request.destinationId,
        text: request.text,
        externalId,
        sentAt,
      }),
    );
    return Object.freeze({ externalId, sentAt });
  }

  #receiptFor(idempotencyKey: string): ChannelAdapterReceipt | undefined {
    const recorded = this.#outbound.get(idempotencyKey);
    if (!recorded) {
      return undefined;
    }
    return Object.freeze({
      externalId: recorded.externalId,
      sentAt: recorded.sentAt,
    });
  }

  #clearIngest(): void {
    this.#ingest = undefined;
  }

  #assertLive(): void {
    if (this.#disposed) {
      throw new ImapChannelDisposedError();
    }
  }
}
