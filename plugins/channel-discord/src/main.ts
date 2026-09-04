import {
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
  discordChannelConfigSchema,
  parseDiscordChannelConfig,
  sameDiscordChannelConfig,
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
  createGatewaySessionStore,
  type GatewaySessionStore,
} from "./session-store";

const READY_TIMEOUT_MS = 20_000;

export interface DiscordControllerOptions {
  readonly clock?: GatewayClock | undefined;
  readonly random?: (() => number) | undefined;
}

export class DiscordChannelController {
  readonly #context: PluginContext;
  readonly #rest: DiscordRestClient;
  readonly #sessions: GatewaySessionStore;
  readonly #options: DiscordControllerOptions;
  #config: DiscordChannelConfig = defaultDiscordChannelConfig();
  #registration: Disposable | undefined;
  #runtime: DiscordGatewayRuntime | undefined;
  #task: Disposable | undefined;
  #configWatch: Disposable | undefined;
  #queue: Promise<void> = Promise.resolve();
  #configError: string | undefined;
  #error: string | undefined;
  #paused = false;
  #disposed = false;

  constructor(context: PluginContext, options: DiscordControllerOptions = {}) {
    this.#context = context;
    this.#options = options;
    this.#rest = new DiscordRestClient({
      http: context.http,
      readToken: () => context.secrets.get(DISCORD_TOKEN_SECRET_KEY),
    });
    this.#sessions = createGatewaySessionStore(context.store, context.logger);
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

  async status(): Promise<DiscordChannelStatus> {
    const hasToken = await this.#context.secrets.has(DISCORD_TOKEN_SECRET_KEY);
    const snapshot = this.#runtime?.snapshot();
    const error = this.#configError ?? snapshot?.error ?? this.#error;
    const botUserId = snapshot?.botUserId;
    return {
      hasToken,
      connected: snapshot?.connected ?? false,
      gatewayState: snapshot?.phase ?? "idle",
      ...(botUserId !== undefined ? { botUserId } : {}),
      ...(error !== undefined ? { error } : {}),
    };
  }

  async verify(signal?: AbortSignal | undefined): Promise<DiscordChannelStatus> {
    const identity = await this.#rest.verifyBot(signal);
    await this.#rest.discoverGateway(signal);
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

  async disconnect(): Promise<DiscordChannelStatus> {
    this.#paused = true;
    await this.#sync();
    await this.#sessions.save(null).catch(() => {
      this.#context.logger.warn("Discord gateway session could not be cleared");
    });
    this.#error = undefined;
    return this.status();
  }

  async send(request: ChannelSendRequest): Promise<ChannelAdapterReceipt> {
    if (!this.#config.allowedChannelIds.includes(request.destinationId)) {
      throw new Error("Discord destination is not allow-listed");
    }
    if (request.attachments !== undefined && request.attachments.length > 0) {
      throw new Error("Discord attachment sending is not supported");
    }
    const { messageId } = await this.#rest.createMessage({
      channelId: request.destinationId,
      content: request.text,
      ...(request.signal ? { signal: request.signal } : {}),
    });
    return { externalId: messageId, sentAt: new Date().toISOString() };
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#configWatch?.dispose();
    this.#configWatch = undefined;
    await this.#sync();
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
    // A settings change is an explicit intent to run again.
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
    if (!(await this.#context.secrets.has(DISCORD_TOKEN_SECRET_KEY))) {
      this.#error = "Discord bot token is not saved";
      return;
    }
    const destinations = [...this.#config.allowedChannelIds];
    this.#registration = this.#context.channels.register({
      id: DISCORD_ADAPTER_ID,
      capacity: "private",
      destinations,
      start: ({ ingest, signal }) => this.#startGateway(ingest, signal),
      send: (request) => this.send(request),
    });
  }

  #startGateway(
    ingest: (draft: ChannelInboundDraft) => void | Promise<void>,
    signal: AbortSignal,
  ): Disposable {
    const runtime = new DiscordGatewayRuntime({
      webSockets: this.#context.webSockets,
      rest: this.#rest,
      readToken: () => this.#context.secrets.get(DISCORD_TOKEN_SECRET_KEY),
      ingest,
      policy: {
        allowedGuildIds: [...this.#config.allowedGuildIds],
        allowedChannelIds: [...this.#config.allowedChannelIds],
        ignoreBots: this.#config.ignoreBots,
      },
      session: this.#sessions,
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
        this.#context.logger.error("Discord gateway task failed", {
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
        await runtime.stop({ clearSession: false });
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
        this.#context.logger.warn("Discord channel adapter teardown failed", {
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
      context.bus.handle(discordChannelGetStatus, () => controller.status()),
      context.bus.handle(discordChannelVerify, (_input, signal) =>
        controller.verify(signal),
      ),
      context.bus.handle(discordChannelDisconnect, () =>
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
