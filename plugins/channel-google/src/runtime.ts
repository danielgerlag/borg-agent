import {
  DEFAULT_CONNECTOR_ACCOUNT_ID,
  connectorAdapterId,
  connectorStoreKey,
  type GoogleChannelStatus,
} from "@borg/contracts";
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
  defaultGoogleChannelConfig,
  describeGoogleConfigError,
  parseGoogleChannelConfig,
  sameGoogleAccountRuntime,
  sameGoogleChannelConfig,
  type GoogleChannelAccount,
  type GoogleChannelConfig,
} from "./config";
import { GoogleCalendarClient } from "./calendar";
import { GoogleContactsClient } from "./contacts";
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
  readonly accountId?: string | undefined;
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

interface GoogleApiClients {
  readonly gmail: GmailClient;
  readonly calendar: GoogleCalendarClient;
  readonly drive: GoogleDriveClient;
  readonly contacts: GoogleContactsClient;
}

interface GoogleAccountSession {
  account: GoogleChannelAccount;
  registration: Disposable | undefined;
  task: Disposable | undefined;
  ingest: ((draft: ChannelInboundDraft) => void | Promise<void>) | undefined;
  signal: AbortSignal | undefined;
  inboundSequence: number;
  readonly outbound: Map<string, ChannelAdapterReceipt>;
  readonly pending: Map<string, Promise<ChannelAdapterReceipt>>;
}

export class GoogleChannelNotStartedError extends Error {
  constructor(message = "Google channel has no active ingest") {
    super(message);
    this.name = "GoogleChannelNotStartedError";
  }
}

export class GoogleChannelController {
  readonly #context: PluginContext;
  readonly #sessions = new Map<string, GoogleAccountSession>();
  readonly #errors = new Map<string, string>();
  #config: GoogleChannelConfig;
  #tools: Disposable | undefined;
  #configWatch: Disposable | undefined;
  #queue: Promise<void> = Promise.resolve();
  #configError: string | undefined;
  #disposed = false;

  constructor(context: PluginContext) {
    this.#context = context;
    this.#config = defaultGoogleChannelConfig();
  }

  async initialize(): Promise<void> {
    this.#config = this.#read(await this.#context.config.get());
    this.#configWatch = this.#context.config.watch((next) =>
      this.#onConfigChanged(next),
    );
    await this.#sync();
  }

  async status(accountId?: string): Promise<GoogleChannelStatus> {
    const account = this.#resolve(accountId);
    const snapshot = await this.#context.oauth.snapshot(account.id);
    const mailbox = account.mailbox.trim();
    const error = this.#configError ?? this.#errors.get(account.id);
    return {
      accountId: account.id,
      name: account.name,
      adapterId: connectorAdapterId(GOOGLE_ADAPTER_ID, account.id),
      connected: snapshot.connected,
      hasClientId: account.clientId.trim().length > 0,
      ...(mailbox.length > 0 ? { mailbox } : {}),
      ...(error !== undefined ? { error } : {}),
    };
  }

  async connect(
    accountId?: string,
    signal?: AbortSignal,
  ): Promise<GoogleChannelStatus> {
    const account = this.#resolve(accountId);
    const clientId = account.clientId.trim();
    if (clientId.length === 0) {
      throw new Error("Paste a Google public desktop client id before connecting");
    }
    this.#errors.delete(account.id);
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
      account.id,
    );
    const me = await this.#clientsFor(account.id).gmail.getProfile(signal);
    await this.#writeAccounts(
      this.#config.accounts.map((item) =>
        item.id === account.id ? { ...item, mailbox: me.mailbox } : item,
      ),
    );
    await this.#sync();
    return this.status(account.id);
  }

  async disconnect(accountId?: string): Promise<GoogleChannelStatus> {
    const account = this.#resolve(accountId);
    await this.#context.oauth.disconnect(account.id);
    await this.#writeAccounts(
      this.#config.accounts.map((item) =>
        item.id === account.id ? { ...item, mailbox: "" } : item,
      ),
    );
    this.#errors.delete(account.id);
    await this.#sync();
    return this.status(account.id);
  }

  async inject(
    input: GoogleChannelInjectInput,
    signal?: AbortSignal,
  ): Promise<GoogleChannelInjectResult> {
    signal?.throwIfAborted();
    const account = this.#resolve(input.accountId);
    const session = this.#sessions.get(account.id);
    const ingest = session?.ingest;
    if (!session || !ingest) {
      throw new GoogleChannelNotStartedError();
    }
    const externalId =
      input.externalId ?? `google-in:${String((session.inboundSequence += 1))}`;
    const draft: ChannelInboundDraft = {
      text: input.text,
      destinationId: input.destinationId ?? this.#mailboxOrFallback(account),
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

  async #send(
    session: GoogleAccountSession,
    request: ChannelSendRequest,
  ): Promise<ChannelAdapterReceipt> {
    const existing = session.outbound.get(request.idempotencyKey);
    if (existing) {
      return existing;
    }
    const pending = session.pending.get(request.idempotencyKey);
    if (pending) {
      return pending;
    }
    const created = this.#dispatchSend(session, request);
    session.pending.set(request.idempotencyKey, created);
    try {
      return await created;
    } finally {
      if (session.pending.get(request.idempotencyKey) === created) {
        session.pending.delete(request.idempotencyKey);
      }
    }
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#configWatch?.dispose();
    this.#configWatch = undefined;
    await this.#sync();
  }

  #resolve(accountId?: string): GoogleChannelAccount {
    const accounts = this.#config.accounts;
    if (accountId !== undefined && accountId.length > 0) {
      const match = accounts.find((account) => account.id === accountId);
      if (!match) {
        throw new Error(`Unknown Google account ${accountId}`);
      }
      return match;
    }
    const fallback =
      accounts.find((account) => account.id === DEFAULT_CONNECTOR_ACCOUNT_ID) ??
      (accounts.length === 1 ? accounts[0] : undefined);
    if (fallback === undefined) {
      throw new Error(
        accounts.length === 0
          ? "No Google account is configured"
          : "Specify accountId when multiple Google accounts exist",
      );
    }
    return fallback;
  }

  async #resolveToolAccount(accountId?: string): Promise<string> {
    const connected: string[] = [];
    for (const account of this.#config.accounts) {
      if ((await this.#context.oauth.snapshot(account.id)).connected) {
        connected.push(account.id);
      }
    }
    if (accountId !== undefined && accountId.length > 0) {
      const match = this.#config.accounts.find(
        (account) => account.id === accountId,
      );
      if (!match) {
        throw new Error(`Unknown Google account ${accountId}`);
      }
      if (!connected.includes(accountId)) {
        throw new Error(`Google account ${accountId} is not connected`);
      }
      return accountId;
    }
    const [sole] = connected;
    if (connected.length === 1 && sole !== undefined) {
      return sole;
    }
    if (connected.length === 0) {
      throw new Error("No Google account is connected");
    }
    throw new Error("Pass accountId; more than one account is connected");
  }

  #clientsFor(accountId: string): GoogleApiClients {
    const tokenOptions = {
      http: this.#context.http,
      readToken: (signal?: AbortSignal) =>
        this.#context.oauth.accessToken(signal, accountId),
    };
    return {
      gmail: new GmailClient(tokenOptions),
      calendar: new GoogleCalendarClient(tokenOptions),
      drive: new GoogleDriveClient(tokenOptions),
      contacts: new GoogleContactsClient(tokenOptions),
    };
  }

  async #writeAccounts(
    accounts: readonly GoogleChannelAccount[],
  ): Promise<void> {
    this.#config = parseGoogleChannelConfig(
      await this.#context.config.update({ accounts: [...accounts] }),
    );
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
      return defaultGoogleChannelConfig();
    }
  }

  async #onConfigChanged(candidate: unknown): Promise<void> {
    const next = this.#read(candidate);
    if (sameGoogleChannelConfig(this.#config, next)) {
      return;
    }
    this.#config = next;
    await this.#sync();
  }

  #sync(): Promise<void> {
    const run = this.#queue.then(() => this.#syncNow());
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #syncNow(): Promise<void> {
    if (this.#disposed) {
      for (const accountId of [...this.#sessions.keys()]) {
        await this.#stopSession(accountId);
      }
      await this.#clearTools();
      return;
    }
    const wanted = new Set(this.#config.accounts.map((account) => account.id));
    for (const accountId of [...this.#sessions.keys()]) {
      if (!wanted.has(accountId)) {
        await this.#stopSession(accountId);
        this.#errors.delete(accountId);
      }
    }
    for (const account of this.#config.accounts) {
      await this.#syncAccount(account);
    }
    await this.#syncTools();
  }

  async #syncAccount(account: GoogleChannelAccount): Promise<void> {
    const shouldRun =
      account.enabled && account.clientId.trim().length > 0;
    if (!shouldRun) {
      await this.#stopSession(account.id);
      return;
    }
    const existing = this.#sessions.get(account.id);
    if (
      existing?.registration !== undefined &&
      sameGoogleAccountRuntime(existing.account, account)
    ) {
      existing.account = account;
      await this.#syncPoll(existing);
      return;
    }
    await this.#stopSession(account.id);
    this.#errors.delete(account.id);
    this.#startSession(account);
  }

  #startSession(account: GoogleChannelAccount): void {
    const session: GoogleAccountSession = {
      account,
      registration: undefined,
      task: undefined,
      ingest: undefined,
      signal: undefined,
      inboundSequence: 0,
      outbound: new Map(),
      pending: new Map(),
    };
    this.#sessions.set(account.id, session);
    session.registration = this.#context.channels.register({
      id: connectorAdapterId(GOOGLE_ADAPTER_ID, account.id),
      capacity: "private",
      destinations: buildDestinations(account.mailbox, account.allowedRecipients),
      start: ({ ingest, signal }) => this.#start(session, ingest, signal),
      send: (request) => this.#send(session, request),
    });
  }

  #start(
    session: GoogleAccountSession,
    ingest: (draft: ChannelInboundDraft) => void | Promise<void>,
    signal: AbortSignal,
  ): Disposable {
    session.ingest = ingest;
    session.signal = signal;
    const onAbort = (): void => {
      if (session.ingest === ingest) {
        session.ingest = undefined;
      }
      if (session.signal === signal) {
        session.signal = undefined;
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void this.#syncPoll(session);
    return {
      dispose: () => {
        signal.removeEventListener("abort", onAbort);
        onAbort();
        this.#stopPoll(session);
      },
    };
  }

  async #syncPoll(session: GoogleAccountSession): Promise<void> {
    const signal = session.signal;
    if (!signal || signal.aborted) {
      this.#stopPoll(session);
      return;
    }
    const snapshot = await this.#context.oauth.snapshot(session.account.id);
    if (!snapshot.connected) {
      this.#stopPoll(session);
      return;
    }
    if (session.task !== undefined) {
      return;
    }
    try {
      session.task = this.#context.runtime.spawn((taskSignal) =>
        this.#pollLoop(session, AbortSignal.any([taskSignal, signal])),
      );
    } catch {
      void this.#pollLoop(session, signal).catch((error: unknown) => {
        this.#context.logger.error("Gmail poll failed", {
          reason: describeError(error),
        });
      });
    }
  }

  #stopPoll(session: GoogleAccountSession): void {
    const task = session.task;
    session.task = undefined;
    task?.dispose();
  }

  async #pollLoop(
    session: GoogleAccountSession,
    signal: AbortSignal,
  ): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.#pollOnce(session, signal);
      } catch (error) {
        if (!signal.aborted) {
          this.#errors.set(session.account.id, describeError(error));
          this.#context.logger.warn("Gmail inbox poll failed", {
            reason: this.#errors.get(session.account.id),
          });
        }
      }
      await sleep(POLL_INTERVAL_MS, signal);
    }
  }

  async #pollOnce(
    session: GoogleAccountSession,
    signal: AbortSignal,
  ): Promise<void> {
    const ingest = session.ingest;
    if (!ingest) {
      return;
    }
    const messages = await this.#clientsFor(session.account.id).gmail.listInbox(
      signal,
    );
    const seen = await this.#loadSeen(session.account.id);
    const nextSeen = [...seen];
    for (const message of [...messages].reverse()) {
      if (seen.has(message.id)) {
        continue;
      }
      nextSeen.push(message.id);
      await ingest({
        text: message.text,
        destinationId: this.#mailboxOrFallback(session.account),
        externalId: message.id,
        receivedAt: message.receivedAt ?? new Date().toISOString(),
        ...(message.sender ? { sender: message.sender } : {}),
      });
    }
    await this.#saveSeen(session.account.id, nextSeen);
  }

  async #dispatchSend(
    session: GoogleAccountSession,
    request: ChannelSendRequest,
  ): Promise<ChannelAdapterReceipt> {
    if (request.attachments !== undefined && request.attachments.length > 0) {
      throw new Error("Gmail attachment sending is not supported");
    }
    const snapshot = await this.#context.oauth.snapshot(session.account.id);
    if (!snapshot.connected) {
      throw new Error("Google is not connected");
    }
    const mailbox = session.account.mailbox.trim();
    if (mailbox.length === 0) {
      throw new Error("Google mailbox is unavailable");
    }
    if (!this.#isAllowedOutbound(session.account, request.destinationId)) {
      throw new Error("Google destination is not allow-listed");
    }
    const { messageId } = await this.#clientsFor(session.account.id).gmail.sendMail(
      {
        from: mailbox,
        to: request.destinationId,
        text: request.text,
        ...(request.signal ? { signal: request.signal } : {}),
      },
    );
    const receipt = Object.freeze({
      externalId: messageId,
      sentAt: new Date().toISOString(),
    });
    session.outbound.set(request.idempotencyKey, receipt);
    return receipt;
  }

  #isAllowedOutbound(
    account: GoogleChannelAccount,
    destinationId: string,
  ): boolean {
    const key = emailKey(destinationId);
    if (
      emailKey(account.mailbox) === key &&
      account.mailbox.trim().length > 0
    ) {
      return true;
    }
    return account.allowedRecipients.some(
      (recipient) => emailKey(recipient) === key,
    );
  }

  #mailboxOrFallback(account: GoogleChannelAccount): string {
    const mailbox = account.mailbox.trim();
    return mailbox.length > 0 ? mailbox : FALLBACK_DESTINATION;
  }

  async #loadSeen(accountId: string): Promise<Set<string>> {
    const value = await this.#context.store.get(
      connectorStoreKey(accountId, SEEN_STORE_KEY),
    );
    if (!Array.isArray(value)) {
      return new Set();
    }
    return new Set(
      value.filter((item): item is string => typeof item === "string"),
    );
  }

  async #saveSeen(accountId: string, ids: readonly string[]): Promise<void> {
    const trimmed: JsonValue = ids.slice(-MAX_SEEN_IDS);
    await this.#context.store.set(
      connectorStoreKey(accountId, SEEN_STORE_KEY),
      trimmed,
    );
  }

  async #syncTools(): Promise<void> {
    let anyConnected = false;
    for (const account of this.#config.accounts) {
      if ((await this.#context.oauth.snapshot(account.id)).connected) {
        anyConnected = true;
        break;
      }
    }
    if (!anyConnected) {
      await this.#clearTools();
      return;
    }
    if (this.#tools) {
      return;
    }
    this.#tools = registerGoogleTools(this.#context, async (accountId) =>
      this.#clientsFor(await this.#resolveToolAccount(accountId)),
    );
  }

  async #clearTools(): Promise<void> {
    const tools = this.#tools;
    this.#tools = undefined;
    if (!tools) {
      return;
    }
    try {
      await tools.dispose();
    } catch (error) {
      this.#context.logger.warn("Google tool teardown failed", {
        reason: describeError(error),
      });
    }
  }

  async #stopSession(accountId: string): Promise<void> {
    const session = this.#sessions.get(accountId);
    if (!session) {
      return;
    }
    this.#sessions.delete(accountId);
    const registration = session.registration;
    session.registration = undefined;
    if (registration) {
      try {
        await registration.dispose();
      } catch (error) {
        this.#context.logger.warn("Google channel adapter teardown failed", {
          reason: describeError(error),
        });
      }
    }
    this.#stopPoll(session);
    session.ingest = undefined;
    session.signal = undefined;
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
