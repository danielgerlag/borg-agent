import {
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
  sameSlackChannelConfig,
  slackChannelConfigSchema,
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

export class SlackChannelController {
  readonly #context: PluginContext;
  readonly #rest: SlackRestClient;
  readonly #options: SlackControllerOptions;
  #config: SlackChannelConfig = defaultSlackChannelConfig();
  #registration: Disposable | undefined;
  #runtime: SlackSocketRuntime | undefined;
  #task: Disposable | undefined;
  #configWatch: Disposable | undefined;
  #queue: Promise<void> = Promise.resolve();
  #configError: string | undefined;
  #error: string | undefined;
  #botUserId: string | undefined;
  #paused = false;
  #disposed = false;

  constructor(context: PluginContext, options: SlackControllerOptions = {}) {
    this.#context = context;
    this.#options = options;
    this.#rest = new SlackRestClient({
      http: context.http,
      readBotToken: () => context.secrets.get(SLACK_BOT_TOKEN_SECRET_KEY),
      readAppToken: () => context.secrets.get(SLACK_APP_TOKEN_SECRET_KEY),
    });
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

  async status(): Promise<SlackChannelStatus> {
    const [hasBotToken, hasAppToken] = await Promise.all([
      this.#context.secrets.has(SLACK_BOT_TOKEN_SECRET_KEY),
      this.#context.secrets.has(SLACK_APP_TOKEN_SECRET_KEY),
    ]);
    const snapshot = this.#runtime?.snapshot();
    const error = this.#configError ?? snapshot?.error ?? this.#error;
    const botUserId = this.#botUserId;
    return {
      hasBotToken,
      hasAppToken,
      connected: snapshot?.connected ?? false,
      socketState: snapshot?.phase ?? "idle",
      ...(botUserId !== undefined ? { botUserId } : {}),
      ...(error !== undefined ? { error } : {}),
    };
  }

  async verify(signal?: AbortSignal | undefined): Promise<SlackChannelStatus> {
    const identity = await this.#rest.authTest(signal);
    await this.#rest.openConnection(signal);
    this.#botUserId = identity.botUserId;
    this.#error = undefined;
    this.#paused = false;
    await this.#sync();
    const runtime = this.#runtime;
    if (runtime) {
      try {
        await runtime.whenReady(READY_TIMEOUT_MS);
      } catch (error) {
        this.#error = describeError(error);
      }
    }
    const status = await this.status();
    return status.botUserId === undefined
      ? { ...status, botUserId: identity.botUserId }
      : status;
  }

  async disconnect(): Promise<SlackChannelStatus> {
    this.#paused = true;
    await this.#sync();
    this.#error = undefined;
    return this.status();
  }

  async send(request: ChannelSendRequest): Promise<ChannelAdapterReceipt> {
    if (request.attachments !== undefined && request.attachments.length > 0) {
      throw new Error("Slack attachment sending is not supported");
    }
    if (this.#runtime?.snapshot().connected !== true) {
      throw new Error("Slack is not connected");
    }
    const destination =
      request.destinationId.trim().length > 0
        ? request.destinationId.trim()
        : this.#config.defaultSendChannelId;
    if (destination.length === 0) {
      throw new Error("Slack destination is not configured");
    }
    if (!this.#config.allowedChannelIds.includes(destination)) {
      throw new Error("Slack destination is not allow-listed");
    }
    const { ts } = await this.#rest.postMessage({
      channel: destination,
      text: request.text,
      ...(request.signal ? { signal: request.signal } : {}),
    });
    return { externalId: ts, sentAt: new Date().toISOString() };
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#configWatch?.dispose();
    this.#configWatch = undefined;
    await this.#sync();
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
    this.#paused = false;
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
    if (this.#disposed || this.#paused) {
      return;
    }
    if (!this.#config.enabled || this.#config.allowedChannelIds.length === 0) {
      return;
    }
    if (!(await this.#context.secrets.has(SLACK_BOT_TOKEN_SECRET_KEY))) {
      this.#error = "Slack bot token is not saved";
      return;
    }
    if (!(await this.#context.secrets.has(SLACK_APP_TOKEN_SECRET_KEY))) {
      this.#error = "Slack app-level token is not saved";
      return;
    }
    const destinations = [...this.#config.allowedChannelIds];
    this.#registration = this.#context.channels.register({
      id: SLACK_ADAPTER_ID,
      capacity: "private",
      destinations,
      start: ({ ingest, signal }) => this.#startSocket(ingest, signal),
      send: (request) => this.send(request),
    });
  }

  #startSocket(
    ingest: (draft: ChannelInboundDraft) => void | Promise<void>,
    signal: AbortSignal,
  ): Disposable {
    const runtime = new SlackSocketRuntime({
      webSockets: this.#context.webSockets,
      rest: this.#rest,
      ingest,
      policy: {
        allowedChannelIds: [...this.#config.allowedChannelIds],
      },
      logger: this.#context.logger,
      ...(this.#options.clock ? { clock: this.#options.clock } : {}),
      ...(this.#options.random ? { random: this.#options.random } : {}),
    });
    this.#runtime = runtime;
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
    this.#task = task;
    return {
      dispose: async () => {
        if (this.#runtime === runtime) {
          this.#runtime = undefined;
        }
        if (task !== undefined && this.#task === task) {
          this.#task = undefined;
        }
        task?.dispose();
        await runtime.stop();
      },
    };
  }

  async #teardown(): Promise<void> {
    const registration = this.#registration;
    this.#registration = undefined;
    if (registration) {
      try {
        await registration.dispose();
      } catch (error) {
        this.#context.logger.warn("Slack channel adapter teardown failed", {
          reason: describeError(error),
        });
      }
    }
    const runtime = this.#runtime;
    this.#runtime = undefined;
    const task = this.#task;
    this.#task = undefined;
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
      context.bus.handle(slackChannelGetStatus, () => controller.status()),
      context.bus.handle(slackChannelVerify, (_input, signal) =>
        controller.verify(signal),
      ),
      context.bus.handle(slackChannelDisconnect, () =>
        controller.disconnect(),
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
