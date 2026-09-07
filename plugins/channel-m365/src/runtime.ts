import type { M365ChannelStatus } from "@borg/contracts";
import type {
  ChannelAdapterReceipt,
  ChannelInboundDraft,
  ChannelSendRequest,
  DataClassification,
  Disposable,
  JsonValue,
  PluginContext,
} from "@borg/plugin-sdk";
import {
  buildDestinations,
  describeM365ConfigError,
  parseM365ChannelConfig,
  type M365ChannelConfig,
} from "./config";
import { GraphClient, GraphError } from "./graph";
import {
  FALLBACK_DESTINATION,
  M365_ADAPTER_ID,
  M365_LOOPBACK_HOST,
  M365_SCOPES,
  POLL_INTERVAL_MS,
  SEEN_STORE_KEY,
  MAX_SEEN_IDS,
  boundDiagnostic,
  emailKey,
  m365AuthorizationEndpoint,
  m365TokenEndpoint,
} from "./protocol";

export interface M365ChannelInjectInput {
  readonly text: string;
  readonly destinationId?: string | undefined;
  readonly externalId?: string | undefined;
  readonly sender?: string | undefined;
  readonly classification?: DataClassification | undefined;
}

export interface M365ChannelInjectResult {
  readonly accepted: true;
  readonly externalId: string;
}

export class M365ChannelNotStartedError extends Error {
  constructor(message = "Microsoft 365 channel has no active ingest") {
    super(message);
    this.name = "M365ChannelNotStartedError";
  }
}

export class M365ChannelController {
  readonly #context: PluginContext;
  readonly #graph: GraphClient;
  #config: M365ChannelConfig;
  #registration: Disposable | undefined;
  #task: Disposable | undefined;
  #configWatch: Disposable | undefined;
  #ingest: ((draft: ChannelInboundDraft) => void | Promise<void>) | undefined;
  #queue: Promise<void> = Promise.resolve();
  #configError: string | undefined;
  #error: string | undefined;
  #disposed = false;
  #inboundSequence = 0;
  readonly #outbound = new Map<string, ChannelAdapterReceipt>();
  readonly #pending = new Map<string, Promise<ChannelAdapterReceipt>>();

  constructor(context: PluginContext) {
    this.#context = context;
    this.#config = parseM365ChannelConfig({});
    this.#graph = new GraphClient({
      http: context.http,
      readToken: (signal) => context.oauth.accessToken(signal),
    });
  }

  async initialize(): Promise<void> {
    this.#config = this.#read(await this.#context.config.get());
    this.#configWatch = this.#context.config.watch((next) => {
      void this.#onConfigChanged(next);
    });
    await this.#sync();
  }

  async status(): Promise<M365ChannelStatus> {
    const snapshot = await this.#context.oauth.snapshot();
    const mailbox = this.#config.mailbox.trim();
    const error = this.#configError ?? this.#error;
    return {
      connected: snapshot.connected,
      hasClientId: this.#config.clientId.trim().length > 0,
      ...(mailbox.length > 0 ? { mailbox } : {}),
      ...(error !== undefined ? { error } : {}),
    };
  }

  async connect(signal?: AbortSignal): Promise<M365ChannelStatus> {
    const clientId = this.#config.clientId.trim();
    if (clientId.length === 0) {
      throw new Error("Paste a Microsoft public native client id before connecting");
    }
    this.#error = undefined;
    await this.#context.oauth.connect(
      {
        clientId,
        authorizationEndpoint: m365AuthorizationEndpoint(this.#config.tenant),
        tokenEndpoint: m365TokenEndpoint(this.#config.tenant),
        scopes: M365_SCOPES,
        loopbackHost: M365_LOOPBACK_HOST,
        extraAuthorizationParams: { prompt: "select_account" },
      },
      signal,
    );
    const me = await this.#graph.getMe(signal);
    await this.#context.config.update({ mailbox: me.mailbox });
    return this.status();
  }

  async disconnect(): Promise<M365ChannelStatus> {
    await this.#context.oauth.disconnect();
    await this.#context.config.update({ mailbox: "" });
    this.#error = undefined;
    return this.status();
  }

  async inject(
    input: M365ChannelInjectInput,
    signal?: AbortSignal,
  ): Promise<M365ChannelInjectResult> {
    signal?.throwIfAborted();
    const ingest = this.#ingest;
    if (!ingest) {
      throw new M365ChannelNotStartedError();
    }
    const externalId =
      input.externalId ?? `m365-in:${String((this.#inboundSequence += 1))}`;
    const draft: ChannelInboundDraft = {
      text: input.text,
      destinationId:
        input.destinationId ??
        this.#mailboxOrFallback(),
      externalId,
      receivedAt: new Date().toISOString(),
      ...(input.sender !== undefined ? { sender: input.sender } : {}),
      ...(input.classification !== undefined
        ? { classification: input.classification }
        : {}),
    };
    await ingest(draft);
    signal?.throwIfAborted();
    return Object.freeze({ accepted: true as const, externalId });
  }

  async send(request: ChannelSendRequest): Promise<ChannelAdapterReceipt> {
    const existing = this.#outbound.get(request.idempotencyKey);
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

  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#configWatch?.dispose();
    this.#configWatch = undefined;
    await this.#sync();
  }

  #read(candidate: unknown): M365ChannelConfig {
    try {
      const config = parseM365ChannelConfig(candidate);
      this.#configError = undefined;
      return config;
    } catch (error) {
      this.#configError = describeM365ConfigError(error);
      this.#context.logger.warn("Microsoft 365 settings are invalid", {
        reason: this.#configError,
      });
      return parseM365ChannelConfig({});
    }
  }

  async #onConfigChanged(candidate: unknown): Promise<void> {
    this.#config = this.#read(candidate);
    await this.#sync();
  }

  #sync(): Promise<void> {
    const run = this.#queue.then(() => this.#syncNow());
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #syncNow(): Promise<void> {
    await this.#teardown();
    this.#error = undefined;
    if (this.#disposed) {
      return;
    }
    if (!this.#config.enabled || this.#config.clientId.trim().length === 0) {
      return;
    }
    const destinations = buildDestinations(
      this.#config.mailbox,
      this.#config.allowedRecipients,
    );
    this.#registration = this.#context.channels.register({
      id: M365_ADAPTER_ID,
      capacity: "private",
      destinations,
      start: ({ ingest, signal }) => this.#start(ingest, signal),
      send: (request) => this.send(request),
    });
  }

  #start(
    ingest: (draft: ChannelInboundDraft) => void | Promise<void>,
    signal: AbortSignal,
  ): Disposable {
    this.#ingest = ingest;
    const onAbort = (): void => {
      if (this.#ingest === ingest) {
        this.#ingest = undefined;
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void this.#maybePoll(signal);
    return {
      dispose: () => {
        signal.removeEventListener("abort", onAbort);
        onAbort();
        this.#task?.dispose();
        this.#task = undefined;
      },
    };
  }

  async #maybePoll(signal: AbortSignal): Promise<void> {
    const snapshot = await this.#context.oauth.snapshot();
    if (!snapshot.connected || signal.aborted) {
      return;
    }
    try {
      this.#task = this.#context.runtime.spawn((taskSignal) =>
        this.#pollLoop(AbortSignal.any([taskSignal, signal])),
      );
    } catch {
      void this.#pollLoop(signal).catch((error: unknown) => {
        this.#context.logger.error("Microsoft 365 poll failed", {
          reason: describeError(error),
        });
      });
    }
  }

  async #pollLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.#pollOnce(signal);
      } catch (error) {
        if (!signal.aborted) {
          this.#error = describeError(error);
          this.#context.logger.warn("Microsoft 365 inbox poll failed", {
            reason: this.#error,
          });
        }
      }
      await sleep(POLL_INTERVAL_MS, signal);
    }
  }

  async #pollOnce(signal: AbortSignal): Promise<void> {
    const ingest = this.#ingest;
    if (!ingest) {
      return;
    }
    const messages = await this.#graph.listInbox(signal);
    const seen = await this.#loadSeen();
    const nextSeen = [...seen];
    for (const message of [...messages].reverse()) {
      if (seen.has(message.id)) {
        continue;
      }
      nextSeen.push(message.id);
      await ingest({
        text: message.text,
        destinationId: this.#mailboxOrFallback(),
        externalId: message.id,
        receivedAt: message.receivedAt ?? new Date().toISOString(),
        ...(message.sender ? { sender: message.sender } : {}),
      });
    }
    await this.#saveSeen(nextSeen);
  }

  async #dispatchSend(request: ChannelSendRequest): Promise<ChannelAdapterReceipt> {
    if (request.attachments !== undefined && request.attachments.length > 0) {
      throw new Error("Microsoft 365 attachment sending is not supported");
    }
    const snapshot = await this.#context.oauth.snapshot();
    if (!snapshot.connected) {
      throw new Error("Microsoft 365 is not connected");
    }
    if (!this.#isAllowedOutbound(request.destinationId)) {
      throw new Error("Microsoft 365 destination is not allow-listed");
    }
    await this.#graph.sendMail({
      to: request.destinationId,
      text: request.text,
      ...(request.signal ? { signal: request.signal } : {}),
    });
    const receipt = Object.freeze({
      externalId: `m365:${request.idempotencyKey}`,
      sentAt: new Date().toISOString(),
    });
    this.#outbound.set(request.idempotencyKey, receipt);
    return receipt;
  }

  #isAllowedOutbound(destinationId: string): boolean {
    const key = emailKey(destinationId);
    if (emailKey(this.#config.mailbox) === key && this.#config.mailbox.trim().length > 0) {
      return true;
    }
    return this.#config.allowedRecipients.some(
      (recipient) => emailKey(recipient) === key,
    );
  }

  #mailboxOrFallback(): string {
    const mailbox = this.#config.mailbox.trim();
    return mailbox.length > 0 ? mailbox : FALLBACK_DESTINATION;
  }

  async #loadSeen(): Promise<Set<string>> {
    const value = await this.#context.store.get(SEEN_STORE_KEY);
    if (!Array.isArray(value)) {
      return new Set();
    }
    return new Set(
      value.filter((item): item is string => typeof item === "string"),
    );
  }

  async #saveSeen(ids: readonly string[]): Promise<void> {
    const trimmed: JsonValue = ids.slice(-MAX_SEEN_IDS);
    await this.#context.store.set(SEEN_STORE_KEY, trimmed);
  }

  async #teardown(): Promise<void> {
    const registration = this.#registration;
    this.#registration = undefined;
    this.#task?.dispose();
    this.#task = undefined;
    this.#ingest = undefined;
    if (registration) {
      try {
        await registration.dispose();
      } catch (error) {
        this.#context.logger.warn("Microsoft 365 channel adapter teardown failed", {
          reason: describeError(error),
        });
      }
    }
  }
}

function describeError(error: unknown): string {
  if (error instanceof GraphError) {
    return boundDiagnostic(error.message);
  }
  return error instanceof Error && error.message.length > 0
    ? boundDiagnostic(error.message)
    : "Microsoft 365 request failed";
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = (): void => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      finish();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
  });
}
