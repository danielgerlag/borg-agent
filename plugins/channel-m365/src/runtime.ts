import {
  DEFAULT_CONNECTOR_ACCOUNT_ID,
  connectorAdapterId,
  connectorStoreKey,
  type M365ChannelStatus,
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
  defaultM365ChannelConfig,
  describeM365ConfigError,
  parseM365ChannelConfig,
  sameM365AccountRuntime,
  sameM365ChannelConfig,
  type M365ChannelAccount,
  type M365ChannelConfig,
} from "./config";
import { GraphCalendarClient } from "./calendar";
import { GraphContactsClient } from "./contacts";
import { GraphDriveClient } from "./drive";
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
import { registerM365Tools } from "./tools";

export interface M365ChannelInjectInput {
  readonly accountId?: string | undefined;
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

interface M365ApiClients {
  readonly graph: GraphClient;
  readonly calendar: GraphCalendarClient;
  readonly drive: GraphDriveClient;
  readonly contacts: GraphContactsClient;
}

interface M365AccountSession {
  account: M365ChannelAccount;
  registration: Disposable | undefined;
  task: Disposable | undefined;
  ingest: ((draft: ChannelInboundDraft) => void | Promise<void>) | undefined;
  signal: AbortSignal | undefined;
  inboundSequence: number;
  readonly outbound: Map<string, ChannelAdapterReceipt>;
  readonly pending: Map<string, Promise<ChannelAdapterReceipt>>;
}

export class M365ChannelNotStartedError extends Error {
  constructor(message = "Microsoft 365 channel has no active ingest") {
    super(message);
    this.name = "M365ChannelNotStartedError";
  }
}

export class M365ChannelController {
  readonly #context: PluginContext;
  readonly #sessions = new Map<string, M365AccountSession>();
  readonly #errors = new Map<string, string>();
  #config: M365ChannelConfig;
  #tools: Disposable | undefined;
  #configWatch: Disposable | undefined;
  #queue: Promise<void> = Promise.resolve();
  #configError: string | undefined;
  #disposed = false;

  constructor(context: PluginContext) {
    this.#context = context;
    this.#config = defaultM365ChannelConfig();
  }

  async initialize(): Promise<void> {
    this.#config = this.#read(await this.#context.config.get());
    this.#configWatch = this.#context.config.watch((next) =>
      this.#onConfigChanged(next),
    );
    await this.#sync();
  }

  async status(accountId?: string): Promise<M365ChannelStatus> {
    const account = this.#resolve(accountId);
    const snapshot = await this.#context.oauth.snapshot(account.id);
    const mailbox = account.mailbox.trim();
    const error = this.#configError ?? this.#errors.get(account.id);
    return {
      accountId: account.id,
      name: account.name,
      adapterId: connectorAdapterId(M365_ADAPTER_ID, account.id),
      connected: snapshot.connected,
      hasClientId: account.clientId.trim().length > 0,
      ...(mailbox.length > 0 ? { mailbox } : {}),
      ...(error !== undefined ? { error } : {}),
    };
  }

  async connect(
    accountId?: string,
    signal?: AbortSignal,
  ): Promise<M365ChannelStatus> {
    const account = this.#resolve(accountId);
    const clientId = account.clientId.trim();
    if (clientId.length === 0) {
      throw new Error(
        "Paste a Microsoft public native client id before connecting",
      );
    }
    this.#errors.delete(account.id);
    await this.#context.oauth.connect(
      {
        clientId,
        authorizationEndpoint: m365AuthorizationEndpoint(account.tenant),
        tokenEndpoint: m365TokenEndpoint(account.tenant),
        scopes: M365_SCOPES,
        loopbackHost: M365_LOOPBACK_HOST,
        extraAuthorizationParams: { prompt: "consent" },
      },
      signal,
      account.id,
    );
    const me = await this.#clientsFor(account.id).graph.getMe(signal);
    await this.#writeAccounts(
      this.#config.accounts.map((item) =>
        item.id === account.id ? { ...item, mailbox: me.mailbox } : item,
      ),
    );
    await this.#sync();
    return this.status(account.id);
  }

  async disconnect(accountId?: string): Promise<M365ChannelStatus> {
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
    input: M365ChannelInjectInput,
    signal?: AbortSignal,
  ): Promise<M365ChannelInjectResult> {
    signal?.throwIfAborted();
    const account = this.#resolve(input.accountId);
    const session = this.#sessions.get(account.id);
    const ingest = session?.ingest;
    if (!session || !ingest) {
      throw new M365ChannelNotStartedError();
    }
    const externalId =
      input.externalId ?? `m365-in:${String((session.inboundSequence += 1))}`;
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
    session: M365AccountSession,
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

  #resolve(accountId?: string): M365ChannelAccount {
    const accounts = this.#config.accounts;
    if (accountId !== undefined && accountId.length > 0) {
      const match = accounts.find((account) => account.id === accountId);
      if (!match) {
        throw new Error(`Unknown Microsoft 365 account ${accountId}`);
      }
      return match;
    }
    const fallback =
      accounts.find((account) => account.id === DEFAULT_CONNECTOR_ACCOUNT_ID) ??
      (accounts.length === 1 ? accounts[0] : undefined);
    if (fallback === undefined) {
      throw new Error(
        accounts.length === 0
          ? "No Microsoft 365 account is configured"
          : "Specify accountId when multiple Microsoft 365 accounts exist",
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
        throw new Error(`Unknown Microsoft 365 account ${accountId}`);
      }
      if (!connected.includes(accountId)) {
        throw new Error(`Microsoft 365 account ${accountId} is not connected`);
      }
      return accountId;
    }
    const [sole] = connected;
    if (connected.length === 1 && sole !== undefined) {
      return sole;
    }
    if (connected.length === 0) {
      throw new Error("No Microsoft 365 account is connected");
    }
    throw new Error("Pass accountId; more than one account is connected");
  }

  #clientsFor(accountId: string): M365ApiClients {
    const graphOptions = {
      http: this.#context.http,
      readToken: (signal?: AbortSignal) =>
        this.#context.oauth.accessToken(signal, accountId),
    };
    return {
      graph: new GraphClient(graphOptions),
      calendar: new GraphCalendarClient(graphOptions),
      drive: new GraphDriveClient(graphOptions),
      contacts: new GraphContactsClient(graphOptions),
    };
  }

  async #writeAccounts(
    accounts: readonly M365ChannelAccount[],
  ): Promise<void> {
    this.#config = parseM365ChannelConfig(
      await this.#context.config.update({ accounts: [...accounts] }),
    );
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
      return defaultM365ChannelConfig();
    }
  }

  async #onConfigChanged(candidate: unknown): Promise<void> {
    const next = this.#read(candidate);
    if (sameM365ChannelConfig(this.#config, next)) {
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

  async #syncAccount(account: M365ChannelAccount): Promise<void> {
    const shouldRun =
      account.enabled && account.clientId.trim().length > 0;
    if (!shouldRun) {
      await this.#stopSession(account.id);
      return;
    }
    const existing = this.#sessions.get(account.id);
    if (
      existing?.registration !== undefined &&
      sameM365AccountRuntime(existing.account, account)
    ) {
      existing.account = account;
      await this.#syncPoll(existing);
      return;
    }
    await this.#stopSession(account.id);
    this.#errors.delete(account.id);
    this.#startSession(account);
  }

  #startSession(account: M365ChannelAccount): void {
    const session: M365AccountSession = {
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
      id: connectorAdapterId(M365_ADAPTER_ID, account.id),
      capacity: "private",
      destinations: buildDestinations(account.mailbox, account.allowedRecipients),
      start: ({ ingest, signal }) => this.#start(session, ingest, signal),
      send: (request) => this.#send(session, request),
    });
  }

  #start(
    session: M365AccountSession,
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

  async #syncPoll(session: M365AccountSession): Promise<void> {
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
        this.#context.logger.error("Microsoft 365 poll failed", {
          reason: describeError(error),
        });
      });
    }
  }

  #stopPoll(session: M365AccountSession): void {
    const task = session.task;
    session.task = undefined;
    task?.dispose();
  }

  async #pollLoop(
    session: M365AccountSession,
    signal: AbortSignal,
  ): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.#pollOnce(session, signal);
      } catch (error) {
        if (!signal.aborted) {
          this.#errors.set(session.account.id, describeError(error));
          this.#context.logger.warn("Microsoft 365 inbox poll failed", {
            reason: this.#errors.get(session.account.id),
          });
        }
      }
      await sleep(POLL_INTERVAL_MS, signal);
    }
  }

  async #pollOnce(
    session: M365AccountSession,
    signal: AbortSignal,
  ): Promise<void> {
    const ingest = session.ingest;
    if (!ingest) {
      return;
    }
    const messages = await this.#clientsFor(session.account.id).graph.listInbox(
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
    session: M365AccountSession,
    request: ChannelSendRequest,
  ): Promise<ChannelAdapterReceipt> {
    if (request.attachments !== undefined && request.attachments.length > 0) {
      throw new Error("Microsoft 365 attachment sending is not supported");
    }
    const snapshot = await this.#context.oauth.snapshot(session.account.id);
    if (!snapshot.connected) {
      throw new Error("Microsoft 365 is not connected");
    }
    if (!this.#isAllowedOutbound(session.account, request.destinationId)) {
      throw new Error("Microsoft 365 destination is not allow-listed");
    }
    await this.#clientsFor(session.account.id).graph.sendMail({
      to: request.destinationId,
      text: request.text,
      ...(request.signal ? { signal: request.signal } : {}),
    });
    const receipt = Object.freeze({
      externalId: `m365:${request.idempotencyKey}`,
      sentAt: new Date().toISOString(),
    });
    session.outbound.set(request.idempotencyKey, receipt);
    return receipt;
  }

  #isAllowedOutbound(
    account: M365ChannelAccount,
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

  #mailboxOrFallback(account: M365ChannelAccount): string {
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
    this.#tools = registerM365Tools(this.#context, async (accountId) =>
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
      this.#context.logger.warn("Microsoft 365 tool teardown failed", {
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
        this.#context.logger.warn(
          "Microsoft 365 channel adapter teardown failed",
          {
            reason: describeError(error),
          },
        );
      }
    }
    this.#stopPoll(session);
    session.ingest = undefined;
    session.signal = undefined;
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
