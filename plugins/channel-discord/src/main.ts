import {
  DEFAULT_CONNECTOR_ACCOUNT_ID,
  connectorAdapterId,
  connectorSecretKey,
  connectorStoreKey,
  discordChannelDisconnect,
  discordChannelGetStatus,
  discordChannelVerify,
  type DiscordChannelStatus,
} from "@borg/contracts";
import {
  definePlugin,
  type ChannelAdapterReceipt,
  type ChannelInboundDraft,
  type ChannelSendRequest,
  type Disposable,
  type PluginContext,
} from "@borg/plugin-sdk";
import {
  defaultDiscordChannelConfig,
  parseDiscordChannelConfig,
  sameDiscordAccountRuntime,
  sameDiscordChannelConfig,
  discordChannelConfigSchema,
  type DiscordChannelAccount,
  type DiscordChannelConfig,
} from "./config";
import {
  DISCORD_ADAPTER_ID,
  DISCORD_TOKEN_SECRET_KEY,
  boundDiagnostic,
} from "./protocol";
import { DiscordRestClient } from "./rest";
import { DiscordGatewayRuntime, type GatewayClock } from "./runtime";
import {
  GATEWAY_SESSION_KEY,
  createGatewaySessionStore,
  type GatewaySessionStore,
} from "./session-store";

const READY_TIMEOUT_MS = 20_000;

export interface DiscordControllerOptions {
  readonly clock?: GatewayClock | undefined;
  readonly random?: (() => number) | undefined;
}

interface DiscordAccountSession {
  account: DiscordChannelAccount;
  rest: DiscordRestClient;
  store: GatewaySessionStore;
  registration: Disposable | undefined;
  runtime: DiscordGatewayRuntime | undefined;
  task: Disposable | undefined;
}

export class DiscordChannelController {
  readonly #context: PluginContext;
  readonly #options: DiscordControllerOptions;
  readonly #sessions = new Map<string, DiscordAccountSession>();
  readonly #paused = new Set<string>();
  readonly #errors = new Map<string, string>();
  #config: DiscordChannelConfig = defaultDiscordChannelConfig();
  #configWatch: Disposable | undefined;
  #queue: Promise<void> = Promise.resolve();
  #configError: string | undefined;
  #disposed = false;

  constructor(context: PluginContext, options: DiscordControllerOptions = {}) {
    this.#context = context;
    this.#options = options;
  }

  get config(): DiscordChannelConfig {
    return this.#config;
  }

  async initialize(): Promise<void> {
    this.#config = this.#read(await this.#context.config.get());
    this.#configWatch = this.#context.config.watch((next) => {
      void this.#onConfigChanged(next);
    });
    await this.#sync();
  }

  async status(accountId?: string): Promise<DiscordChannelStatus> {
    const account = this.#resolve(accountId);
    const hasToken = await this.#context.secrets.has(
      connectorSecretKey(account.id, DISCORD_TOKEN_SECRET_KEY),
    );
    const session = this.#sessions.get(account.id);
    const snapshot = session?.runtime?.snapshot();
    const error =
      this.#configError ?? snapshot?.error ?? this.#errors.get(account.id);
    const botUserId = snapshot?.botUserId;
    return {
      accountId: account.id,
      name: account.name,
      adapterId: connectorAdapterId(DISCORD_ADAPTER_ID, account.id),
      hasToken,
      connected: snapshot?.connected ?? false,
      gatewayState: snapshot?.phase ?? "idle",
      ...(botUserId !== undefined ? { botUserId } : {}),
      ...(error !== undefined ? { error } : {}),
    };
  }

  async verify(
    accountId?: string,
    signal?: AbortSignal | undefined,
  ): Promise<DiscordChannelStatus> {
    const account = this.#resolve(accountId);
    const rest = this.#restFor(account);
    const identity = await rest.verifyBot(signal);
    await rest.discoverGateway(signal);
    this.#errors.delete(account.id);
    this.#paused.delete(account.id);
    await this.#sync();
    const runtime = this.#sessions.get(account.id)?.runtime;
    if (runtime) {
      try {
        await runtime.whenReady(READY_TIMEOUT_MS);
      } catch (error) {
        this.#errors.set(account.id, describeError(error));
      }
    }
    const status = await this.status(account.id);
    return status.botUserId === undefined
      ? { ...status, botUserId: identity.botUserId }
      : status;
  }

  async disconnect(accountId?: string): Promise<DiscordChannelStatus> {
    const account = this.#resolve(accountId);
    this.#paused.add(account.id);
    await this.#sync();
    await this.#storeFor(account.id)
      .save(null)
      .catch(() => {
        this.#context.logger.warn(
          "Discord gateway session could not be cleared",
        );
      });
    this.#errors.delete(account.id);
    return this.status(account.id);
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#configWatch?.dispose();
    this.#configWatch = undefined;
    await this.#sync();
  }

  #resolve(accountId?: string): DiscordChannelAccount {
    const accounts = this.#config.accounts;
    if (accountId !== undefined && accountId.length > 0) {
      const match = accounts.find((account) => account.id === accountId);
      if (!match) {
        throw new Error(`Unknown Discord account ${accountId}`);
      }
      return match;
    }
    const fallback =
      accounts.find((account) => account.id === DEFAULT_CONNECTOR_ACCOUNT_ID) ??
      (accounts.length === 1 ? accounts[0] : undefined);
    if (fallback === undefined) {
      throw new Error(
        accounts.length === 0
          ? "No Discord account is configured"
          : "Specify accountId when multiple Discord accounts exist",
      );
    }
    return fallback;
  }

  #restFor(account: DiscordChannelAccount): DiscordRestClient {
    return new DiscordRestClient({
      http: this.#context.http,
      readToken: () =>
        this.#context.secrets.get(
          connectorSecretKey(account.id, DISCORD_TOKEN_SECRET_KEY),
        ),
    });
  }

  #storeFor(accountId: string): GatewaySessionStore {
    return createGatewaySessionStore(
      this.#context.store,
      this.#context.logger,
      connectorStoreKey(accountId, GATEWAY_SESSION_KEY),
    );
  }

  #read(candidate: unknown): DiscordChannelConfig {
    try {
      const config = parseDiscordChannelConfig(candidate);
      this.#configError = undefined;
      return config;
    } catch (error) {
      this.#configError = describeError(error);
      this.#context.logger.warn("Discord settings are invalid", {
        reason: this.#configError,
      });
      return defaultDiscordChannelConfig();
    }
  }

  async #onConfigChanged(candidate: unknown): Promise<void> {
    const next = this.#read(candidate);
    if (sameDiscordChannelConfig(this.#config, next)) {
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
      return;
    }
    const wanted = new Set(this.#config.accounts.map((account) => account.id));
    for (const accountId of [...this.#sessions.keys()]) {
      if (!wanted.has(accountId)) {
        await this.#stopSession(accountId);
        this.#paused.delete(accountId);
        this.#errors.delete(accountId);
      }
    }
    for (const account of this.#config.accounts) {
      await this.#syncAccount(account);
    }
  }

  async #syncAccount(account: DiscordChannelAccount): Promise<void> {
    const shouldRun =
      !this.#paused.has(account.id) &&
      account.enabled &&
      account.allowedChannelIds.length > 0;
    if (!shouldRun) {
      await this.#stopSession(account.id);
      return;
    }
    if (
      !(await this.#context.secrets.has(
        connectorSecretKey(account.id, DISCORD_TOKEN_SECRET_KEY),
      ))
    ) {
      this.#errors.set(account.id, "Discord bot token is not saved");
      await this.#stopSession(account.id);
      return;
    }
    const existing = this.#sessions.get(account.id);
    if (
      existing?.registration !== undefined &&
      sameDiscordAccountRuntime(existing.account, account)
    ) {
      existing.account = account;
      return;
    }
    await this.#stopSession(account.id);
    this.#errors.delete(account.id);
    this.#startSession(account);
  }

  #startSession(account: DiscordChannelAccount): void {
    const session: DiscordAccountSession = {
      account,
      rest: this.#restFor(account),
      store: this.#storeFor(account.id),
      registration: undefined,
      runtime: undefined,
      task: undefined,
    };
    this.#sessions.set(account.id, session);
    session.registration = this.#context.channels.register({
      id: connectorAdapterId(DISCORD_ADAPTER_ID, account.id),
      capacity: "private",
      destinations: [...account.allowedChannelIds],
      start: ({ ingest, signal }) => this.#startGateway(session, ingest, signal),
      send: (request) => this.#send(session, request),
    });
  }

  async #send(
    session: DiscordAccountSession,
    request: ChannelSendRequest,
  ): Promise<ChannelAdapterReceipt> {
    if (!session.account.allowedChannelIds.includes(request.destinationId)) {
      throw new Error("Discord destination is not allow-listed");
    }
    if (request.attachments !== undefined && request.attachments.length > 0) {
      throw new Error("Discord attachment sending is not supported");
    }
    const { messageId } = await session.rest.createMessage({
      channelId: request.destinationId,
      content: request.text,
      ...(request.signal ? { signal: request.signal } : {}),
    });
    return { externalId: messageId, sentAt: new Date().toISOString() };
  }

  #startGateway(
    session: DiscordAccountSession,
    ingest: (draft: ChannelInboundDraft) => void | Promise<void>,
    signal: AbortSignal,
  ): Disposable {
    const runtime = new DiscordGatewayRuntime({
      webSockets: this.#context.webSockets,
      rest: session.rest,
      readToken: () =>
        this.#context.secrets.get(
          connectorSecretKey(session.account.id, DISCORD_TOKEN_SECRET_KEY),
        ),
      ingest,
      policy: {
        allowedGuildIds: [...session.account.allowedGuildIds],
        allowedChannelIds: [...session.account.allowedChannelIds],
        ignoreBots: session.account.ignoreBots,
      },
      session: session.store,
      logger: this.#context.logger,
      ...(this.#options.clock ? { clock: this.#options.clock } : {}),
      ...(this.#options.random ? { random: this.#options.random } : {}),
    });
    session.runtime = runtime;
    let task: Disposable | undefined;
    try {
      task = this.#context.runtime.spawn((taskSignal) =>
        runtime.run(AbortSignal.any([taskSignal, signal])),
      );
    } catch {
      void runtime.run(signal).catch((error: unknown) => {
        this.#context.logger.error("Discord gateway task failed", {
          reason: describeError(error),
        });
      });
    }
    session.task = task;
    return {
      dispose: async () => {
        if (session.runtime === runtime) {
          session.runtime = undefined;
        }
        if (task !== undefined && session.task === task) {
          session.task = undefined;
        }
        task?.dispose();
        await runtime.stop({ clearSession: false });
      },
    };
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
        this.#context.logger.warn("Discord channel adapter teardown failed", {
          reason: describeError(error),
        });
      }
    }
    const runtime = session.runtime;
    session.runtime = undefined;
    const task = session.task;
    session.task = undefined;
    task?.dispose();
    if (runtime) {
      await runtime.stop({ clearSession: false });
    }
  }
}

function describeError(error: unknown): string {
  return error instanceof Error && error.message.length > 0
    ? boundDiagnostic(error.message)
    : "Discord request failed";
}

export default definePlugin({
  id: "borg.channel.discord",
  version: "0.1.0",
  engines: {
    borg: "^0.1.0",
  },
  permissions: [
    "channels.register",
    "network:dynamic",
    "network:websocket",
    "runtime.background",
    "secrets:read",
    "secrets:write",
    "ui.settings",
  ],
  contributes: {
    commands: [
      discordChannelDisconnect.id,
      discordChannelGetStatus.id,
      discordChannelVerify.id,
    ],
    kinds: ["channel", "settingsPage"],
  },
  configSchema: discordChannelConfigSchema,
  async activate(context) {
    const controller = new DiscordChannelController(context);
    const handles = [
      context.bus.handle(discordChannelGetStatus, (input) =>
        controller.status(input.accountId),
      ),
      context.bus.handle(discordChannelVerify, (input, signal) =>
        controller.verify(input.accountId, signal),
      ),
      context.bus.handle(discordChannelDisconnect, (input) =>
        controller.disconnect(input.accountId),
      ),
    ];
    await controller.initialize();
    return {
      dispose: async () => {
        for (const handle of handles) {
          handle.dispose();
        }
        await controller.dispose();
      },
    };
  },
});
