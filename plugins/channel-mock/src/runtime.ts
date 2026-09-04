import type {
  ChannelAdapter,
  ChannelAdapterReceipt,
  ChannelInboundDraft,
  ChannelSendRequest,
  DataClassification,
  Disposable,
} from "@borg/plugin-sdk";

export const MOCK_CHANNEL_ADAPTER_ID = "borg.channel.mock";
export const MOCK_CHANNEL_DESTINATION = "default";

export interface MockOutboundRecord {
  readonly idempotencyKey: string;
  readonly destinationId: string;
  readonly text: string;
  readonly externalId: string;
  readonly sentAt: string;
}

export interface MockChannelInjectInput {
  readonly text: string;
  readonly destinationId?: string | undefined;
  readonly externalId?: string | undefined;
  readonly sender?: string | undefined;
  readonly classification?: DataClassification | undefined;
}

export interface MockChannelInjectResult {
  readonly accepted: true;
  readonly externalId: string;
}

export class MockChannelDisposedError extends Error {
  constructor(message = "Mock channel is disposed") {
    super(message);
    this.name = "MockChannelDisposedError";
  }
}

export class MockChannelNotStartedError extends Error {
  constructor(message = "Mock channel has no active ingest") {
    super(message);
    this.name = "MockChannelNotStartedError";
  }
}

export class MockChannelRuntime implements ChannelAdapter {
  readonly id = MOCK_CHANNEL_ADAPTER_ID;
  readonly capacity = "public" as const;
  readonly destinations = [MOCK_CHANNEL_DESTINATION] as const;

  #disposed = false;
  #ingest: ((draft: ChannelInboundDraft) => void | Promise<void>) | undefined;
  readonly #outbound = new Map<string, MockOutboundRecord>();
  readonly #pending = new Map<string, Promise<ChannelAdapterReceipt>>();
  #inboundSequence = 0;

  get disposed(): boolean {
    return this.#disposed;
  }

  listOutbound(): readonly MockOutboundRecord[] {
    return Object.freeze([...this.#outbound.values()].map((record) =>
      Object.freeze({ ...record }),
    ));
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
    input: MockChannelInjectInput,
    signal?: AbortSignal,
  ): Promise<MockChannelInjectResult> {
    this.#assertLive();
    signal?.throwIfAborted();
    const ingest = this.#ingest;
    if (!ingest) {
      throw new MockChannelNotStartedError();
    }
    const externalId =
      input.externalId ?? `mock-in:${String((this.#inboundSequence += 1))}`;
    const draft: ChannelInboundDraft = {
      text: input.text,
      destinationId: input.destinationId ?? MOCK_CHANNEL_DESTINATION,
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
    const externalId = `mock:${request.idempotencyKey}`;
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
      throw new MockChannelDisposedError();
    }
  }
}
