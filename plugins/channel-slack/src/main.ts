import {
  DEFAULT_CONNECTOR_ACCOUNT_ID,
  connectorAdapterId,
  connectorSecretKey,
  slackChannelDisconnect,
  slackChannelGetStatus,
  slackChannelVerify,
  type SlackChannelStatus,
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
  defaultSlackChannelConfig,
  parseSlackChannelConfig,
  sameSlackAccountRuntime,
  sameSlackChannelConfig,
  slackChannelConfigSchema,
  type SlackChannelAccount,
  type SlackChannelConfig,
} from "./config";
import {
  SLACK_ADAPTER_ID,
  SLACK_APP_TOKEN_SECRET_KEY,
  SLACK_BOT_TOKEN_SECRET_KEY,
  boundDiagnostic,
} from "./protocol";
import { SlackRestClient } from "./rest";
import { SlackSocketRuntime, type SocketClock } from "./runtime";

const READY_TIMEOUT_MS = 20_000;

export interface SlackControllerOptions {
  readonly clock?: SocketClock | undefined;
  readonly random?: (() => number) | undefined;
}

interface SlackAccountSession {
  account: SlackChannelAccount;
  rest: SlackRestClient;
  registration: Disposable | undefined;
  runtime: SlackSocketRuntime | undefined;
  task: Disposable | undefined;
}

export class SlackChannelController {
  readonly #context: PluginContext;
  readonly #options: SlackControllerOptions;
  readonly #sessions = new Map<string, SlackAccountSession>();
  readonly #paused = new Set<string>();
  readonly #errors = new Map<string, string>();
  readonly #botUserIds = new Map<string, string>();
  #config: SlackChannelConfig = defaultSlackChannelConfig();
  #configWatch: Disposable | undefined;
  #queue: Promise<void> = Promise.resolve();
  #configError: string | undefined;
  #disposed = false;

  constructor(context: PluginContext, options: SlackControllerOptions = {}) {
    this.#context = context;
    this.#options = options;
  }

  get config(): SlackChannelConfig {
    return this.#config;
  }

  async initialize(): Promise<void> {
    this.#config = this.#read(await this.#context.config.get());
    this.#configWatch = this.#context.config.watch((next) => {
      void this.#onConfigChanged(next);
    });
    await this.#sync();
  }

  async status(accountId?: string): Promise<SlackChannelStatus> {
    const account = this.#resolve(accountId);
    const [hasBotToken, hasAppToken] = await Promise.all([
      this.#context.secrets.has(
        connectorSecretKey(account.id, SLACK_BOT_TOKEN_SECRET_KEY),
      ),
      this.#context.secrets.has(
        connectorSecretKey(account.id, SLACK_APP_TOKEN_SECRET_KEY),
      ),
    ]);
    const session = this.#sessions.get(account.id);
    const snapshot = session?.runtime?.snapshot();
    const error =
      this.#configError ?? snapshot?.error ?? this.#errors.get(account.id);
    const botUserId = this.#botUserIds.get(account.id);
    return {
      accountId: account.id,
      name: account.name,
      adapterId: connectorAdapterId(SLACK_ADAPTER_ID, account.id),
      hasBotToken,
      hasAppToken,
      connected: snapshot?.connected ?? false,
      socketState: snapshot?.phase ?? "idle",
      ...(botUserId !== undefined ? { botUserId } : {}),
      ...(error !== undefined ? { error } : {}),
    };
  }

  async verify(
    accountId?: string,
    signal?: AbortSignal | undefined,
  ): Promise<SlackChannelStatus> {
    const account = this.#resolve(accountId);
    const rest = this.#restFor(account);
    const identity = await rest.authTest(signal);
    await rest.openConnection(signal);
    this.#botUserIds.set(account.id, identity.botUserId);
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

  async disconnect(accountId?: string): Promise<SlackChannelStatus> {
    const account = this.#resolve(accountId);
    this.#paused.add(account.id);
    await this.#sync();
    this.#errors.delete(account.id);
    return this.status(account.id);
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#configWatch?.dispose();
    this.#configWatch = undefined;
    await this.#sync();
  }

  #resolve(accountId?: string): SlackChannelAccount {
    const accounts = this.#config.accounts;
    if (accountId !== undefined && accountId.length > 0) {
      const match = accounts.find((account) => account.id === accountId);
      if (!match) {
        throw new Error(`Unknown Slack account ${accountId}`);
      }
      return match;
    }
    const fallback =
      accounts.find((account) => account.id === DEFAULT_CONNECTOR_ACCOUNT_ID) ??
      (accounts.length === 1 ? accounts[0] : undefined);
    if (fallback === undefined) {
      throw new Error(
        accounts.length === 0
          ? "No Slack account is configured"
          : "Specify accountId when multiple Slack accounts exist",
      );
    }
    return fallback;
  }

  #restFor(account: SlackChannelAccount): SlackRestClient {
    return new SlackRestClient({
      http: this.#context.http,
      readBotToken: () =>
        this.#context.secrets.get(
          connectorSecretKey(account.id, SLACK_BOT_TOKEN_SECRET_KEY),
        ),
      readAppToken: () =>
        this.#context.secrets.get(
          connectorSecretKey(account.id, SLACK_APP_TOKEN_SECRET_KEY),
        ),
    });
  }

  #read(candidate: unknown): SlackChannelConfig {
    try {
      const config = parseSlackChannelConfig(candidate);
      this.#configError = undefined;
      return config;
    } catch (error) {
      this.#configError = describeError(error);
      this.#context.logger.warn("Slack settings are invalid", {
        reason: this.#configError,
      });
      return defaultSlackChannelConfig();
    }
  }

  async #onConfigChanged(candidate: unknown): Promise<void> {
    const next = this.#read(candidate);
    if (sameSlackChannelConfig(this.#config, next)) {
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
        this.#botUserIds.delete(accountId);
      }
    }
    for (const account of this.#config.accounts) {
      await this.#syncAccount(account);
    }
  }

  async #syncAccount(account: SlackChannelAccount): Promise<void> {
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
        connectorSecretKey(account.id, SLACK_BOT_TOKEN_SECRET_KEY),
      ))
    ) {
      this.#errors.set(account.id, "Slack bot token is not saved");
      await this.#stopSession(account.id);
      return;
    }
    if (
      !(await this.#context.secrets.has(
        connectorSecretKey(account.id, SLACK_APP_TOKEN_SECRET_KEY),
      ))
    ) {
      this.#errors.set(account.id, "Slack app-level token is not saved");
      await this.#stopSession(account.id);
      return;
    }
    const existing = this.#sessions.get(account.id);
    if (
      existing?.registration !== undefined &&
      sameSlackAccountRuntime(existing.account, account)
    ) {
      existing.account = account;
      return;
    }
    await this.#stopSession(account.id);
    this.#errors.delete(account.id);
    this.#startSession(account);
  }

  #startSession(account: SlackChannelAccount): void {
    const session: SlackAccountSession = {
      account,
      rest: this.#restFor(account),
      registration: undefined,
      runtime: undefined,
      task: undefined,
    };
    this.#sessions.set(account.id, session);
    session.registration = this.#context.channels.register({
      id: connectorAdapterId(SLACK_ADAPTER_ID, account.id),
      capacity: "private",
      destinations: [...account.allowedChannelIds],
      start: ({ ingest, signal }) => this.#startSocket(session, ingest, signal),
      send: (request) => this.#send(session, request),
    });
  }

  async #send(
    session: SlackAccountSession,
    request: ChannelSendRequest,
  ): Promise<ChannelAdapterReceipt> {
    if (request.attachments !== undefined && request.attachments.length > 0) {
      throw new Error("Slack attachment sending is not supported");
    }
    if (session.runtime?.snapshot().connected !== true) {
      throw new Error("Slack is not connected");
    }
    const destination =
      request.destinationId.trim().length > 0
        ? request.destinationId.trim()
        : session.account.defaultSendChannelId;
    if (destination.length === 0) {
      throw new Error("Slack destination is not configured");
    }
    if (!session.account.allowedChannelIds.includes(destination)) {
      throw new Error("Slack destination is not allow-listed");
    }
    const { ts } = await session.rest.postMessage({
      channel: destination,
      text: request.text,
      ...(request.signal ? { signal: request.signal } : {}),
    });
    return { externalId: ts, sentAt: new Date().toISOString() };
  }

  #startSocket(
    session: SlackAccountSession,
    ingest: (draft: ChannelInboundDraft) => void | Promise<void>,
    signal: AbortSignal,
  ): Disposable {
    const runtime = new SlackSocketRuntime({
      webSockets: this.#context.webSockets,
      rest: session.rest,
      ingest,
      policy: {
        allowedChannelIds: [...session.account.allowedChannelIds],
      },
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
        this.#context.logger.error("Slack Socket Mode task failed", {
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
        await runtime.stop();
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
        this.#context.logger.warn("Slack channel adapter teardown failed", {
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
      await runtime.stop();
    }
  }
}

function describeError(error: unknown): string {
  return error instanceof Error && error.message.length > 0
    ? boundDiagnostic(error.message)
    : "Slack request failed";
}

export default definePlugin({
  id: "borg.channel.slack",
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
      slackChannelDisconnect.id,
      slackChannelGetStatus.id,
      slackChannelVerify.id,
    ],
    kinds: ["channel", "settingsPage"],
  },
  configSchema: slackChannelConfigSchema,
  async activate(context) {
    const controller = new SlackChannelController(context);
    const handles = [
      context.bus.handle(slackChannelGetStatus, (input) =>
        controller.status(input.accountId),
      ),
      context.bus.handle(slackChannelVerify, (input, signal) =>
        controller.verify(input.accountId, signal),
      ),
      context.bus.handle(slackChannelDisconnect, (input) =>
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
