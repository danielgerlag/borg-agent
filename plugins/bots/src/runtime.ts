import {
  botCompleted,
  botFailed,
  botLogSchema,
  botSchema,
  botStarted,
  botStopped,
  botUpdated,
  type Bot,
  type BotLog,
  type LoopEvent,
} from "@borg/contracts";
import type {
  Disposable,
  JsonValue,
  PluginContext,
} from "@borg/plugin-sdk";
import { z } from "@borg/plugin-sdk";

const BOT_PREFIX = "bots/current/";
const LOG_PREFIX = "bots/logs/";
const MAX_LOGS = 200;
const LIVE_STATUSES = new Set(["running", "waiting"]);

const persistedBotSchema = z
  .object({
    version: z.literal(1),
    bot: botSchema,
  })
  .strict();

const persistedLogsSchema = z
  .object({
    version: z.literal(1),
    logs: z.array(botLogSchema),
  })
  .strict();

function asJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function cloneBot(bot: Bot): Bot {
  return botSchema.parse(structuredClone(bot));
}

export class BotRuntime {
  readonly #bots = new Map<string, Bot>();
  readonly #logs = new Map<string, BotLog[]>();
  readonly #subscriptions = new Map<string, Disposable>();
  readonly #operations = new Map<string, Promise<unknown>>();
  #disposed = false;

  constructor(readonly context: PluginContext) {}

  async initialize(): Promise<void> {
    for (const entry of await this.context.store.list(BOT_PREFIX)) {
      const persisted = persistedBotSchema.parse(entry.value);
      this.#bots.set(persisted.bot.id, persisted.bot);
      this.context.workspace.allocate(persisted.bot.id);
    }
    for (const entry of await this.context.store.list(LOG_PREFIX)) {
      const persisted = persistedLogsSchema.parse(entry.value);
      const botId = entry.key.slice(LOG_PREFIX.length);
      this.#logs.set(botId, persisted.logs);
    }
    for (const bot of [...this.#bots.values()]) {
      if (!LIVE_STATUSES.has(bot.status) || !bot.runId) {
        continue;
      }
      const live = this.context.loops.get(bot.runId);
      if (live && LIVE_STATUSES.has(live.status)) {
        this.#watch(bot.id, bot.runId);
        continue;
      }
      await this.start(bot.id);
    }
  }

  dispose(): void {
    this.#disposed = true;
    for (const subscription of this.#subscriptions.values()) {
      void subscription.dispose();
    }
    this.#subscriptions.clear();
  }

  list(): Bot[] {
    return [...this.#bots.values()]
      .map(cloneBot)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  get(botId: string): Bot | undefined {
    const bot = this.#bots.get(botId);
    return bot ? cloneBot(bot) : undefined;
  }

  listLogs(botId: string): BotLog[] {
    return [...(this.#logs.get(botId) ?? [])];
  }

  async create(input: {
    readonly name?: string | undefined;
    readonly personaId?: string | undefined;
    readonly launchPrompt: string;
  }): Promise<Bot> {
    const persona = input.personaId
      ? this.context.personas.get(input.personaId)
      : this.context.personas.getDefault();
    if (!persona || persona.archived) {
      throw new Error(`Persona ${input.personaId} is unavailable`);
    }
    const now = new Date().toISOString();
    const name = input.name?.trim() || "Untitled bot";
    const bot = botSchema.parse({
      id: crypto.randomUUID(),
      name,
      personaId: persona.id,
      launchPrompt: input.launchPrompt.trim(),
      status: "stopped",
      createdAt: now,
      updatedAt: now,
    });
    this.context.workspace.allocate(bot.id);
    this.#bots.set(bot.id, bot);
    this.#logs.set(bot.id, []);
    await this.#persist(bot.id);
    await this.context.bus.emit(botUpdated, { bot: cloneBot(bot) });
    return cloneBot(bot);
  }

  async start(botId: string): Promise<Bot> {
    return this.#serialize(botId, async () => {
      const current = this.#require(botId);
      if (LIVE_STATUSES.has(current.status) && current.runId) {
        const live = this.context.loops.get(current.runId);
        if (live && LIVE_STATUSES.has(live.status)) {
          return cloneBot(current);
        }
      }
      this.context.workspace.allocate(botId);
      let run;
      try {
        run = await this.context.loops.start({
          prompt: current.launchPrompt,
          personaId: current.personaId,
          sessionId: botId,
        });
      } catch (error) {
        const failed = await this.#write(botId, {
          status: "failed",
          runId: undefined,
          error: String(error),
          completedAt: new Date().toISOString(),
        });
        await this.#appendLog(botId, "error", `The bot could not start: ${String(error)}`);
        await this.context.bus.emit(botFailed, { bot: failed });
        throw error;
      }
      const started = await this.#write(botId, {
        status: run.status === "waiting" ? "waiting" : "running",
        runId: run.id,
        startedAt: new Date().toISOString(),
      });
      this.#watch(botId, run.id);
      await this.#appendLog(botId, "info", "Bot started.", "started");
      await this.context.bus.emit(botStarted, { bot: started });
      return started;
    });
  }

  async stop(botId: string): Promise<Bot> {
    return this.#serialize(botId, async () => {
      const current = this.#require(botId);
      if (current.runId) {
        this.context.loops.cancel(current.runId);
        await this.#subscriptions.get(botId)?.dispose();
        this.#subscriptions.delete(botId);
      }
      if (!LIVE_STATUSES.has(current.status) && current.status !== "running") {
        const stopped = await this.#write(botId, {
          status: "stopped",
          runId: undefined,
        });
        return stopped;
      }
      const stopped = await this.#write(botId, {
        status: "stopped",
        runId: undefined,
        completedAt: new Date().toISOString(),
      });
      await this.#appendLog(botId, "info", "Bot stopped.", "stopped");
      await this.context.bus.emit(botStopped, { bot: stopped });
      return stopped;
    });
  }

  async delete(botId: string): Promise<boolean> {
    return this.#serialize(botId, async () => {
      if (!this.#bots.has(botId)) {
        return false;
      }
      if (this.#bots.get(botId)?.runId) {
        this.context.loops.cancel(this.#bots.get(botId)!.runId!);
      }
      await this.#subscriptions.get(botId)?.dispose();
      this.#subscriptions.delete(botId);
      this.#bots.delete(botId);
      this.#logs.delete(botId);
      await this.context.store.transaction([
        { type: "delete", key: `${BOT_PREFIX}${botId}` },
        { type: "delete", key: `${LOG_PREFIX}${botId}` },
      ]);
      await this.context.workspace.release(botId);
      return true;
    });
  }

  #require(botId: string): Bot {
    const bot = this.#bots.get(botId);
    if (!bot) {
      throw new Error(`Bot ${botId} is unavailable`);
    }
    return bot;
  }

  #watch(botId: string, runId: string): void {
    void this.#subscriptions.get(botId)?.dispose();
    const subscription = this.context.loops.subscribe(runId, (event) =>
      this.#onLoopEvent(botId, event),
    );
    this.#subscriptions.set(botId, subscription);
  }

  async #onLoopEvent(botId: string, event: LoopEvent): Promise<void> {
    if (this.#disposed || !this.#bots.has(botId)) {
      return;
    }
    await this.#serialize(botId, async () => {
      const current = this.#bots.get(botId);
      if (!current || current.runId !== event.runId) {
        return;
      }
      const message = describeLoopEvent(event);
      if (message) {
        await this.#appendLog(
          botId,
          event.type === "failed" ? "error" : "info",
          message,
          event.type,
        );
      }
      if (event.type === "state" && event.status === "waiting") {
        await this.#write(botId, { status: "waiting" });
        return;
      }
      if (event.type === "state" && event.status === "running") {
        await this.#write(botId, { status: "running" });
        return;
      }
      if (event.type === "state" && event.status === "completed") {
        const completed = await this.#write(botId, {
          status: "completed",
          completedAt: new Date().toISOString(),
        });
        await this.context.bus.emit(botCompleted, { bot: completed });
        return;
      }
      if (event.type === "final") {
        await this.#subscriptions.get(botId)?.dispose();
        this.#subscriptions.delete(botId);
        return;
      }
      if (event.type === "state" && event.status === "cancelled") {
        await this.#subscriptions.get(botId)?.dispose();
        this.#subscriptions.delete(botId);
        const cancelled = await this.#write(botId, {
          status: "cancelled",
          completedAt: new Date().toISOString(),
        });
        await this.context.bus.emit(botStopped, { bot: cancelled });
        return;
      }
      if (event.type === "failed" || (event.type === "state" && event.status === "failed")) {
        await this.#subscriptions.get(botId)?.dispose();
        this.#subscriptions.delete(botId);
        const failed = await this.#write(botId, {
          status: "failed",
          ...(event.type === "failed" ? { error: event.error } : {}),
          completedAt: new Date().toISOString(),
        });
        await this.context.bus.emit(botFailed, { bot: failed });
      }
    });
  }

  async #write(botId: string, patch: Partial<Bot>): Promise<Bot> {
    const current = this.#require(botId);
    const merged: Record<string, unknown> = {
      ...current,
      ...patch,
      id: current.id,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString(),
    };
    if (patch.status === "running" || patch.status === "waiting") {
      delete merged.error;
      delete merged.completedAt;
    }
    const next = botSchema.parse(merged);
    this.#bots.set(botId, next);
    await this.#persist(botId);
    await this.context.bus.emit(botUpdated, { bot: cloneBot(next) });
    return cloneBot(next);
  }

  async #appendLog(
    botId: string,
    level: BotLog["level"],
    message: string,
    eventType?: string,
  ): Promise<void> {
    const logs = [...(this.#logs.get(botId) ?? [])];
    logs.push(
      botLogSchema.parse({
        at: new Date().toISOString(),
        level,
        message,
        ...(eventType ? { eventType } : {}),
      }),
    );
    const trimmed = logs.slice(-MAX_LOGS);
    this.#logs.set(botId, trimmed);
    await this.context.store.set(
      `${LOG_PREFIX}${botId}`,
      asJsonValue({ version: 1, logs: trimmed }),
    );
  }

  async #persist(botId: string): Promise<void> {
    const bot = this.#require(botId);
    await this.context.store.set(
      `${BOT_PREFIX}${botId}`,
      asJsonValue({ version: 1, bot }),
    );
  }

  async #serialize<T>(botId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#operations.get(botId) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(operation);
    const marker = pending.then(
      () => undefined,
      () => undefined,
    );
    this.#operations.set(botId, marker);
    try {
      return await pending;
    } finally {
      if (this.#operations.get(botId) === marker) {
        this.#operations.delete(botId);
      }
    }
  }
}

function describeLoopEvent(event: LoopEvent): string | undefined {
  switch (event.type) {
    case "state":
      return `Status: ${event.status}`;
    case "final":
      return event.output;
    case "failed":
      return event.error;
    case "tool_start":
      return `Used ${event.toolId}`;
    case "interaction_wait":
      return "Waiting for input";
    default:
      return undefined;
  }
}
