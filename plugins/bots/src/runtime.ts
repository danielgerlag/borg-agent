import {
  botCompleted,
  botFailed,
  botLogSchema,
  botSchema,
  botStarted,
  botStopped,
  botUpdated,
  executionIdSchema,
  modelOperationPrefixSchema,
  type Bot,
  type BotLog,
  type ExecutionId,
  type LoopEvent,
} from "@borg/contracts";
import type {
  Disposable,
  JsonValue,
  ParentExecutionGrant,
  PluginContext,
} from "@borg/plugin-sdk";
import { z } from "@borg/plugin-sdk";

const BOT_PREFIX = "bots/current/";
const LOG_PREFIX = "bots/logs/";
const MAX_LOGS = 200;
const LIVE_STATUSES = new Set(["running", "waiting"]);

const legacyPersistedBotSchema = z
  .object({
    version: z.literal(1),
    bot: botSchema,
  })
  .strict();

const botSecurityStateSchema = z
  .object({
    headExecutionId: executionIdSchema,
    active: z
      .object({
        attemptId: z.string().uuid(),
        executionId: executionIdSchema,
        operationPrefix: modelOperationPrefixSchema,
        runId: z.string().uuid().optional(),
      })
      .strict()
      .optional(),
    pendingClose: z
      .object({
        executionId: executionIdSchema,
        outcome: z.enum([
          "completed",
          "failed",
          "cancelled",
          "interrupted",
        ]),
        reason: z.string().min(1),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.active && value.pendingClose) {
      context.addIssue({
        code: "custom",
        message:
          "Bot security cannot be active and pending close together",
      });
    }
  });

type BotSecurityState = z.infer<typeof botSecurityStateSchema>;

const persistedBotSchema = z
  .object({
    version: z.literal(2),
    bot: botSchema,
    security: botSecurityStateSchema,
  })
  .strict();

interface BotRecord {
  readonly bot: Bot;
  readonly security: BotSecurityState;
}

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
  readonly #records = new Map<string, BotRecord>();
  readonly #logs = new Map<string, BotLog[]>();
  readonly #subscriptions = new Map<string, Disposable>();
  readonly #operations = new Map<string, Promise<unknown>>();
  #disposed = false;

  constructor(readonly context: PluginContext) {}

  async initialize(): Promise<void> {
    for (const entry of await this.context.store.list(BOT_PREFIX)) {
      const current = persistedBotSchema.safeParse(entry.value);
      const bot = current.success
        ? current.data.bot
        : legacyPersistedBotSchema.parse(entry.value).bot;
      const legacyExecution = current.success
        ? undefined
        : await this.context.executions.bind({
            mode: "root",
            subject: { kind: "bot", id: bot.id },
            classification: "restricted",
            provenance: {
              kind: "legacy",
              id: `bot:${bot.id}`,
            },
          });
      const security = current.success
        ? current.data.security
        : botSecurityStateSchema.parse({
            headExecutionId: legacyExecution?.id,
          });
      if (security.pendingClose) {
        await this.#closeAttempt(
          security.pendingClose.executionId,
          security.pendingClose.outcome,
          security.pendingClose.reason,
        );
      }
      const recoveredSecurity = security.pendingClose
        ? botSecurityStateSchema.parse({
            headExecutionId: security.pendingClose.executionId,
          })
        : security;
      this.#records.set(bot.id, {
        bot,
        security: recoveredSecurity,
      });
      this.context.workspace.allocate(bot.id);
      if (!current.success || security.pendingClose) {
        await this.#persist(bot.id);
      }
    }
    for (const entry of await this.context.store.list(LOG_PREFIX)) {
      const persisted = persistedLogsSchema.parse(entry.value);
      const botId = entry.key.slice(LOG_PREFIX.length);
      this.#logs.set(botId, persisted.logs);
    }
    for (const [botId, record] of [...this.#records]) {
      const { bot, security } = record;
      if (
        LIVE_STATUSES.has(bot.status) &&
        bot.runId &&
        security.active?.runId === bot.runId
      ) {
        const live = this.context.loops.get(bot.runId);
        if (live && LIVE_STATUSES.has(live.status)) {
          this.#watch(bot.id, bot.runId);
          continue;
        }
      }
      if (!LIVE_STATUSES.has(bot.status) && !security.active) {
        const head = await this.context.executions.bind({
          mode: "resume",
          executionId: security.headExecutionId,
        });
        if ((await head.summary()).lifecycle.state === "open") {
          await head.close({
            outcome:
              bot.status === "failed"
                ? "failed"
                : bot.status === "cancelled"
                  ? "cancelled"
                  : "completed",
            reason: `Bot ${bot.id} durable state was recovered`,
          });
        }
        continue;
      }
      const interruptedSecurity = botSecurityStateSchema.parse({
        headExecutionId:
          security.active?.executionId ?? security.headExecutionId,
      });
      const interruptedBot = botSchema.parse({
        ...bot,
        status: "interrupted",
        runId: undefined,
        error: "The previous attempt was interrupted when Borg stopped.",
        completedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      this.#records.set(botId, {
        bot: interruptedBot,
        security: interruptedSecurity,
      });
      await this.#persist(botId);
      const interruptedExecution = await this.context.executions.bind({
        mode: "resume",
        executionId: interruptedSecurity.headExecutionId,
      });
      if (
        (await interruptedExecution.summary()).lifecycle.state === "open"
      ) {
        await interruptedExecution.close({
          outcome: "interrupted",
          reason: `Bot ${botId} attempt was interrupted`,
        });
      }
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
    return [...this.#records.values()]
      .map(({ bot }) => cloneBot(bot))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  get(botId: string): Bot | undefined {
    const record = this.#records.get(botId);
    return record ? cloneBot(record.bot) : undefined;
  }

  listLogs(botId: string): BotLog[] {
    return [...(this.#logs.get(botId) ?? [])];
  }

  async create(input: {
    readonly name?: string | undefined;
    readonly personaId?: string | undefined;
    readonly launchPrompt: string;
    readonly parentExecutionGrant?: ParentExecutionGrant | undefined;
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
    const execution = input.parentExecutionGrant
      ? await this.context.executions.bind({
          mode: "child",
          subject: { kind: "bot", id: bot.id },
          parent: input.parentExecutionGrant,
        })
      : await this.context.executions.bind({
          mode: "root",
          subject: { kind: "bot", id: bot.id },
          classification: "internal",
          provenance: {
            kind: "user",
            id: `bot:${bot.id}`,
          },
        });
    const security = botSecurityStateSchema.parse({
      headExecutionId: execution.id,
    });
    this.context.workspace.allocate(bot.id);
    this.#records.set(bot.id, { bot, security });
    this.#logs.set(bot.id, []);
    await this.#persist(bot.id).then(
      () => undefined,
      async (error: unknown) => {
        this.#records.delete(bot.id);
        this.#logs.delete(bot.id);
        await execution.close({
          outcome: "deleted",
          reason: `Bot ${bot.id} could not be persisted`,
        });
        throw error;
      },
    );
    await execution.close({
      outcome: "completed",
      reason: `Bot ${bot.id} was persisted`,
    });
    await this.context.bus.emit(botUpdated, { bot: cloneBot(bot) });
    return cloneBot(bot);
  }

  async start(botId: string): Promise<Bot> {
    return this.#serialize(botId, async () => {
      const current = this.#requireRecord(botId);
      if (
        LIVE_STATUSES.has(current.bot.status) &&
        current.bot.runId &&
        current.security.active?.runId === current.bot.runId
      ) {
        const live = this.context.loops.get(current.bot.runId);
        if (live && LIVE_STATUSES.has(live.status)) {
          return cloneBot(current.bot);
        }
      }
      this.context.workspace.allocate(botId);
      const attemptId = crypto.randomUUID();
      const attempt = await this.context.executions.bind({
        mode: "child",
        subject: {
          kind: "bot-attempt",
          id: `${botId}/${attemptId}`,
        },
        parent: await this.context.executions.grant(
          current.security.headExecutionId,
        ),
      });
      await attempt.observe({
        classification: "internal",
        provenance: {
          kind: "plugin",
          id: `bot-prompt:${botId}`,
        },
        reason: `Bot ${botId} started attempt ${attemptId}`,
      });
      const operationPrefix = modelOperationPrefixSchema.parse(
        `bot/${botId}/attempt/${attemptId}`,
      );
      const preparedBot = botSchema.parse({
        ...current.bot,
        status: "running",
        runId: undefined,
        startedAt: new Date().toISOString(),
        completedAt: undefined,
        error: undefined,
        updatedAt: new Date().toISOString(),
      });
      const preparedSecurity = botSecurityStateSchema.parse({
        headExecutionId: current.security.headExecutionId,
        active: {
          attemptId,
          executionId: attempt.id,
          operationPrefix,
        },
      });
      this.#records.set(botId, {
        bot: preparedBot,
        security: preparedSecurity,
      });
      await this.#persist(botId);
      let run;
      try {
        run = await this.context.loops.start({
          prompt: current.bot.launchPrompt,
          personaId: current.bot.personaId,
          sessionId: botId,
          security: {
            kind: "bound",
            executionId: attempt.id,
            operationPrefix,
          },
        });
      } catch (error) {
        const failedBot = botSchema.parse({
          ...preparedBot,
          status: "failed",
          runId: undefined,
          error: String(error),
          completedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
        const failedSecurity = botSecurityStateSchema.parse({
          headExecutionId: attempt.id,
          pendingClose: {
            executionId: attempt.id,
            outcome: "failed",
            reason: `Bot ${botId} attempt ${attemptId} could not start`,
          },
        });
        this.#records.set(botId, {
          bot: failedBot,
          security: failedSecurity,
        });
        await this.#persist(botId);
        await attempt.close({
          outcome: "failed",
          reason: `Bot ${botId} attempt ${attemptId} could not start`,
        });
        this.#records.set(botId, {
          bot: failedBot,
          security: botSecurityStateSchema.parse({
            headExecutionId: attempt.id,
          }),
        });
        await this.#persist(botId);
        await this.#appendLog(botId, "error", `The bot could not start: ${String(error)}`);
        await this.context.bus.emit(botFailed, {
          bot: cloneBot(failedBot),
        });
        throw error;
      }
      const startedBot = botSchema.parse({
        ...preparedBot,
        status: run.status === "waiting" ? "waiting" : "running",
        runId: run.id,
        updatedAt: new Date().toISOString(),
      });
      const startedSecurity = botSecurityStateSchema.parse({
        ...preparedSecurity,
        active: {
          attemptId,
          executionId: attempt.id,
          operationPrefix,
          runId: run.id,
        },
      });
      this.#records.set(botId, {
        bot: startedBot,
        security: startedSecurity,
      });
      await this.#persist(botId);
      const started = cloneBot(startedBot);
      this.#watch(botId, run.id);
      await this.#appendLog(botId, "info", "Bot started.", "started");
      await this.context.bus.emit(botStarted, { bot: started });
      return started;
    });
  }

  async stop(botId: string): Promise<Bot> {
    return this.#serialize(botId, async () => {
      const current = this.#requireRecord(botId);
      if (current.bot.runId) {
        this.context.loops.cancel(current.bot.runId);
        await this.#subscriptions.get(botId)?.dispose();
        this.#subscriptions.delete(botId);
      }
      if (!LIVE_STATUSES.has(current.bot.status)) {
        const stopped = await this.#write(botId, {
          status: "stopped",
          runId: undefined,
        });
        return stopped;
      }
      const active = current.security.active;
      const stoppedSecurity = active
        ? botSecurityStateSchema.parse({
            headExecutionId: active.executionId,
            pendingClose: {
              executionId: active.executionId,
              outcome: "cancelled",
              reason: `Bot ${botId} was stopped`,
            },
          })
        : current.security;
      const stopped = await this.#write(botId, {
        status: "stopped",
        runId: undefined,
        completedAt: new Date().toISOString(),
      }, stoppedSecurity);
      if (active) {
        const execution = await this.context.executions.bind({
          mode: "resume",
          executionId: active.executionId,
        });
        await execution.close({
          outcome: "cancelled",
          reason: `Bot ${botId} was stopped`,
        });
        this.#records.set(botId, {
          bot: this.#requireRecord(botId).bot,
          security: botSecurityStateSchema.parse({
            headExecutionId: active.executionId,
          }),
        });
        await this.#persist(botId);
      }
      await this.#appendLog(botId, "info", "Bot stopped.", "stopped");
      await this.context.bus.emit(botStopped, { bot: stopped });
      return stopped;
    });
  }

  async delete(botId: string): Promise<boolean> {
    return this.#serialize(botId, async () => {
      const record = this.#records.get(botId);
      if (!record) {
        return false;
      }
      if (record.bot.runId) {
        this.context.loops.cancel(record.bot.runId);
      }
      await this.#subscriptions.get(botId)?.dispose();
      this.#subscriptions.delete(botId);
      this.#records.delete(botId);
      this.#logs.delete(botId);
      await this.context.store.transaction([
        { type: "delete", key: `${BOT_PREFIX}${botId}` },
        { type: "delete", key: `${LOG_PREFIX}${botId}` },
      ]);
      const executionIds = new Set<ExecutionId>([
        record.security.headExecutionId,
        ...(record.security.active
          ? [record.security.active.executionId]
          : []),
      ]);
      for (const executionId of executionIds) {
        const execution = await this.context.executions.bind({
          mode: "resume",
          executionId,
        });
        if ((await execution.summary()).lifecycle.state === "open") {
          await execution.close({
            outcome: "deleted",
            reason: `Bot ${botId} was deleted`,
          });
        }
      }
      await this.context.workspace.release(botId);
      return true;
    });
  }

  #requireRecord(botId: string): BotRecord {
    const record = this.#records.get(botId);
    if (!record) {
      throw new Error(`Bot ${botId} is unavailable`);
    }
    return record;
  }

  #watch(botId: string, runId: string): void {
    void this.#subscriptions.get(botId)?.dispose();
    const subscription = this.context.loops.subscribe(runId, (event) =>
      this.#onLoopEvent(botId, event),
    );
    this.#subscriptions.set(botId, subscription);
  }

  async #onLoopEvent(botId: string, event: LoopEvent): Promise<void> {
    if (this.#disposed || !this.#records.has(botId)) {
      return;
    }
    await this.#serialize(botId, async () => {
      const current = this.#records.get(botId);
      if (!current || current.bot.runId !== event.runId) {
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
        const active = current.security.active;
        const completedSecurity = active
          ? botSecurityStateSchema.parse({
              headExecutionId: active.executionId,
              pendingClose: {
                executionId: active.executionId,
                outcome: "completed",
                reason: `Bot ${botId} completed`,
              },
            })
          : current.security;
        const completed = await this.#write(botId, {
          status: "completed",
          completedAt: new Date().toISOString(),
        }, completedSecurity);
        if (active) {
          await this.#closeAttempt(
            active.executionId,
            "completed",
            `Bot ${botId} completed`,
          );
          await this.#clearPendingClose(botId, active.executionId);
        }
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
        const active = current.security.active;
        const cancelledSecurity = active
          ? botSecurityStateSchema.parse({
              headExecutionId: active.executionId,
              pendingClose: {
                executionId: active.executionId,
                outcome: "cancelled",
                reason: `Bot ${botId} was cancelled`,
              },
            })
          : current.security;
        const cancelled = await this.#write(botId, {
          status: "cancelled",
          runId: undefined,
          completedAt: new Date().toISOString(),
        }, cancelledSecurity);
        if (active) {
          await this.#closeAttempt(
            active.executionId,
            "cancelled",
            `Bot ${botId} was cancelled`,
          );
          await this.#clearPendingClose(botId, active.executionId);
        }
        await this.context.bus.emit(botStopped, { bot: cancelled });
        return;
      }
      if (event.type === "failed" || (event.type === "state" && event.status === "failed")) {
        await this.#subscriptions.get(botId)?.dispose();
        this.#subscriptions.delete(botId);
        const active = current.security.active;
        const failedSecurity = active
          ? botSecurityStateSchema.parse({
              headExecutionId: active.executionId,
              pendingClose: {
                executionId: active.executionId,
                outcome: "failed",
                reason: `Bot ${botId} failed`,
              },
            })
          : current.security;
        const failed = await this.#write(botId, {
          status: "failed",
          runId: undefined,
          ...(event.type === "failed" ? { error: event.error } : {}),
          completedAt: new Date().toISOString(),
        }, failedSecurity);
        if (active) {
          await this.#closeAttempt(
            active.executionId,
            "failed",
            `Bot ${botId} failed`,
          );
          await this.#clearPendingClose(botId, active.executionId);
        }
        await this.context.bus.emit(botFailed, { bot: failed });
      }
    });
  }

  async #write(
    botId: string,
    patch: Partial<Bot>,
    security?: BotSecurityState,
  ): Promise<Bot> {
    const current = this.#requireRecord(botId);
    const merged: Record<string, unknown> = {
      ...current.bot,
      ...patch,
      id: current.bot.id,
      createdAt: current.bot.createdAt,
      updatedAt: new Date().toISOString(),
    };
    if (patch.status === "running" || patch.status === "waiting") {
      delete merged.error;
      delete merged.completedAt;
    }
    const next = botSchema.parse(merged);
    this.#records.set(botId, {
      bot: next,
      security: security ?? current.security,
    });
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
    const record = this.#requireRecord(botId);
    await this.context.store.set(
      `${BOT_PREFIX}${botId}`,
      asJsonValue({
        version: 2,
        bot: record.bot,
        security: record.security,
      }),
    );
  }

  async #closeAttempt(
    executionId: ExecutionId,
    outcome: "completed" | "failed" | "cancelled" | "interrupted",
    reason: string,
  ): Promise<void> {
    const execution = await this.context.executions.bind({
      mode: "resume",
      executionId,
    });
    await execution.close({ outcome, reason });
  }

  async #clearPendingClose(
    botId: string,
    executionId: ExecutionId,
  ): Promise<void> {
    const current = this.#requireRecord(botId);
    this.#records.set(botId, {
      bot: current.bot,
      security: botSecurityStateSchema.parse({
        headExecutionId: executionId,
      }),
    });
    await this.#persist(botId);
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
