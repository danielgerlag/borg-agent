import type {
  ChannelAdapter,
  ChannelAdapterReceipt,
  ChannelInboundDraft,
  ChannelSendRequest,
  DataClassification,
  Disposable,
} from "@borg/plugin-sdk";

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

export class ImapFakeTransport implements ChannelAdapter {
  readonly id = IMAP_CHANNEL_ADAPTER_ID;
  readonly capacity = "private" as const;
  destinations: readonly string[] = [IMAP_DEFAULT_MAILBOX];

  #disposed = false;
  #ingest: ((draft: ChannelInboundDraft) => void | Promise<void>) | undefined;
  readonly #outbound = new Map<string, ImapOutboundRecord>();
  readonly #pending = new Map<string, Promise<ChannelAdapterReceipt>>();
  #inboundSequence = 0;

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
    this.#ingest = options.ingest;
    const onAbort = (): void => {
      this.#clearIngest();
    };
    options.signal.addEventListener("abort", onAbort, { once: true });
    return {
      dispose: () => {
        options.signal.removeEventListener("abort", onAbort);
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
    const created = Promise.resolve(this.#commitSend(request));
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
    this.#clearIngest();
    this.#pending.clear();
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
