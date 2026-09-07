import type { GoogleChannelStatus } from "@borg/contracts";
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
  describeGoogleConfigError,
  parseGoogleChannelConfig,
  type GoogleChannelConfig,
} from "./config";
import { GoogleCalendarClient } from "./calendar";
import { GoogleDriveClient } from "./drive";
import { GmailClient, GmailError } from "./gmail";
import { GoogleApisError } from "./googleapis";
import {
  FALLBACK_DESTINATION,
  GOOGLE_ADAPTER_ID,
  GOOGLE_AUTHORIZATION_ENDPOINT,
  GOOGLE_LOOPBACK_HOST,
  GOOGLE_REVOCATION_ENDPOINT,
  GOOGLE_SCOPES,
  GOOGLE_TOKEN_ENDPOINT,
  MAX_SEEN_IDS,
  POLL_INTERVAL_MS,
  SEEN_STORE_KEY,
  boundDiagnostic,
  emailKey,
} from "./protocol";
import { registerGoogleTools } from "./tools";

export interface GoogleChannelInjectInput {
  readonly text: string;
  readonly destinationId?: string | undefined;
  readonly externalId?: string | undefined;
  readonly sender?: string | undefined;
  readonly classification?: DataClassification | undefined;
}

export interface GoogleChannelInjectResult {
  readonly accepted: true;
  readonly externalId: string;
}

export class GoogleChannelNotStartedError extends Error {
  constructor(message = "Google channel has no active ingest") {
    super(message);
    this.name = "GoogleChannelNotStartedError";
  }
}

export class GoogleChannelController {
  readonly #context: PluginContext;
  readonly #gmail: GmailClient;
  readonly #calendar: GoogleCalendarClient;
  readonly #drive: GoogleDriveClient;
  #config: GoogleChannelConfig;
  #registration: Disposable | undefined;
  #tools: Disposable | undefined;
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
    this.#config = parseGoogleChannelConfig({});
    const tokenOptions = {
      http: context.http,
      readToken: (signal?: AbortSignal) => context.oauth.accessToken(signal),
    };
    this.#gmail = new GmailClient(tokenOptions);
    this.#calendar = new GoogleCalendarClient(tokenOptions);
    this.#drive = new GoogleDriveClient(tokenOptions);
  }

  async initialize(): Promise<void> {
    this.#config = this.#read(await this.#context.config.get());
    this.#configWatch = this.#context.config.watch((next) =>
      this.#onConfigChanged(next),
    );
    await this.#sync();
  }

  async status(): Promise<GoogleChannelStatus> {
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

  async connect(signal?: AbortSignal): Promise<GoogleChannelStatus> {
    const clientId = this.#config.clientId.trim();
    if (clientId.length === 0) {
      throw new Error("Paste a Google public desktop client id before connecting");
    }
    this.#error = undefined;
    await this.#context.oauth.connect(
      {
        clientId,
        authorizationEndpoint: GOOGLE_AUTHORIZATION_ENDPOINT,
        tokenEndpoint: GOOGLE_TOKEN_ENDPOINT,
        revocationEndpoint: GOOGLE_REVOCATION_ENDPOINT,
        scopes: GOOGLE_SCOPES,
        loopbackHost: GOOGLE_LOOPBACK_HOST,
        extraAuthorizationParams: {
          access_type: "offline",
          prompt: "consent",
        },
      },
      signal,
    );
    const me = await this.#gmail.getProfile(signal);
    await this.#context.config.update({ mailbox: me.mailbox });
    await this.#sync();
    return this.status();
  }

  async disconnect(): Promise<GoogleChannelStatus> {
    await this.#context.oauth.disconnect();
    await this.#context.config.update({ mailbox: "" });
    this.#error = undefined;
    await this.#sync();
    return this.status();
  }

  async inject(
    input: GoogleChannelInjectInput,
    signal?: AbortSignal,
  ): Promise<GoogleChannelInjectResult> {
    signal?.throwIfAborted();
    const ingest = this.#ingest;
    if (!ingest) {
      throw new GoogleChannelNotStartedError();
    }
    const externalId =
      input.externalId ?? `google-in:${String((this.#inboundSequence += 1))}`;
    const draft: ChannelInboundDraft = {
      text: input.text,
      destinationId: input.destinationId ?? this.#mailboxOrFallback(),
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

  #read(candidate: unknown): GoogleChannelConfig {
    try {
      const config = parseGoogleChannelConfig(candidate);
      this.#configError = undefined;
      return config;
    } catch (error) {
      this.#configError = describeGoogleConfigError(error);
      this.#context.logger.warn("Google settings are invalid", {
        reason: this.#configError,
      });
      return parseGoogleChannelConfig({});
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
      id: GOOGLE_ADAPTER_ID,
      capacity: "private",
      destinations,
      start: ({ ingest, signal }) => this.#start(ingest, signal),
      send: (request) => this.send(request),
    });
    const snapshot = await this.#context.oauth.snapshot();
    if (snapshot.connected) {
      this.#tools = registerGoogleTools(
        this.#context,
        this.#calendar,
        this.#drive,
      );
    }
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
        this.#context.logger.error("Gmail poll failed", {
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
          this.#context.logger.warn("Gmail inbox poll failed", {
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
    const messages = await this.#gmail.listInbox(signal);
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
      throw new Error("Gmail attachment sending is not supported");
    }
    const snapshot = await this.#context.oauth.snapshot();
    if (!snapshot.connected) {
      throw new Error("Google is not connected");
    }
    const mailbox = this.#config.mailbox.trim();
    if (mailbox.length === 0) {
      throw new Error("Google mailbox is unavailable");
    }
    if (!this.#isAllowedOutbound(request.destinationId)) {
      throw new Error("Google destination is not allow-listed");
    }
    const { messageId } = await this.#gmail.sendMail({
      from: mailbox,
      to: request.destinationId,
      text: request.text,
      ...(request.signal ? { signal: request.signal } : {}),
    });
    const receipt = Object.freeze({
      externalId: messageId,
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
    const tools = this.#tools;
    this.#tools = undefined;
    if (tools) {
      try {
        await tools.dispose();
      } catch (error) {
        this.#context.logger.warn("Google tool teardown failed", {
          reason: describeError(error),
        });
      }
    }
    const registration = this.#registration;
    this.#registration = undefined;
    this.#task?.dispose();
    this.#task = undefined;
    this.#ingest = undefined;
    if (registration) {
      try {
        await registration.dispose();
      } catch (error) {
        this.#context.logger.warn("Google channel adapter teardown failed", {
          reason: describeError(error),
        });
      }
    }
  }
}

function describeError(error: unknown): string {
  if (error instanceof GmailError || error instanceof GoogleApisError) {
    return boundDiagnostic(error.message);
  }
  return error instanceof Error && error.message.length > 0
    ? boundDiagnostic(error.message)
    : "Google request failed";
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
