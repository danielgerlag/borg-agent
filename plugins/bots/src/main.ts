import {
  botCompleted,
  botFailed,
  botLogSchema,
  botSchema,
  botStarted,
  botStopped,
  botUpdated,
  botsCreate,
  botsDelete,
  botsGet,
  botsList,
  botsListLogs,
  botsStart,
  botsStop,
} from "@borg/contracts";
import { definePlugin, defineTool, z } from "@borg/plugin-sdk";
import { BotRuntime } from "./runtime";

export default definePlugin({
  id: "borg.bots",
  version: "0.1.0",
  engines: {
    borg: "^0.1.0",
  },
  permissions: [
    "executions.manage",
    "loops.start",
    "personas.read",
    "tools.invoke",
    "tools.register",
    "ui.flightDeck",
    "ui.workspace",
    "workspace.manage",
  ],
  contributes: {
    commands: [
      botsCreate.id,
      botsDelete.id,
      botsGet.id,
      botsList.id,
      botsListLogs.id,
      botsStart.id,
      botsStop.id,
    ],
    events: [
      botCompleted.id,
      botFailed.id,
      botStarted.id,
      botStopped.id,
      botUpdated.id,
    ],
    kinds: ["flightDeckWidget", "tool", "workspaceView"],
  },
  async activate(context) {
    const runtime = new BotRuntime(context);

    context.bus.handle(botsCreate, async (input, _signal, envelope) => ({
      bot: await runtime.create({
        ...input,
        ...(envelope.parentExecutionGrant
          ? { parentExecutionGrant: envelope.parentExecutionGrant }
          : {}),
      }),
    }));
    context.bus.handle(botsList, async () => ({
      bots: runtime.list(),
    }));
    context.bus.handle(botsGet, ({ botId }) => ({
      bot: runtime.get(botId) ?? null,
    }));
    context.bus.handle(botsStart, async ({ botId }) => ({
      bot: await runtime.start(botId),
    }));
    context.bus.handle(botsStop, async ({ botId }) => ({
      bot: await runtime.stop(botId),
    }));
    context.bus.handle(botsDelete, async ({ botId }) => ({
      deleted: await runtime.delete(botId),
    }));
    context.bus.handle(botsListLogs, ({ botId }) => ({
      logs: runtime.listLogs(botId),
    }));

    context.tools.register(
      defineTool({
        id: "bots.create",
        description: "Create a background bot from a persona and launch prompt",
        input: z
          .object({
            name: z.string().min(1).optional(),
            personaId: z.string().min(1).optional(),
            launchPrompt: z.string().min(1),
          })
          .strict(),
        output: z.object({ bot: botSchema }).strict(),
        approval: "auto",
        sideEffect: true,
        security: {
          outputClassification: "restricted",
          outputProvenance: "external",
        },
        execute: (input) =>
          context.bus.invoke(botsCreate, input).then(({ bot }) => ({ bot })),
      }),
    );
    context.tools.register(
      defineTool({
        id: "bots.list",
        description: "List saved background bots",
        input: z.object({}).strict(),
        output: z.object({ bots: z.array(botSchema) }).strict(),
        approval: "auto",
        sideEffect: false,
        security: {
          outputClassification: "restricted",
          outputProvenance: "external",
        },
        execute: () => ({ bots: runtime.list() }),
      }),
    );
    context.tools.register(
      defineTool({
        id: "bots.start",
        description: "Start a saved background bot",
        input: z.object({ botId: z.string().uuid() }).strict(),
        output: z.object({ bot: botSchema }).strict(),
        approval: "auto",
        sideEffect: true,
        security: {
          outputClassification: "restricted",
          outputProvenance: "external",
        },
        execute: ({ botId }, execution) =>
          context.bus.invoke(botsStart, { botId }, { signal: execution.signal }),
      }),
    );
    context.tools.register(
      defineTool({
        id: "bots.stop",
        description: "Stop a running background bot",
        input: z.object({ botId: z.string().uuid() }).strict(),
        output: z.object({ bot: botSchema }).strict(),
        approval: "auto",
        sideEffect: true,
        security: {
          outputClassification: "restricted",
          outputProvenance: "external",
        },
        execute: ({ botId }, execution) =>
          context.bus.invoke(botsStop, { botId }, { signal: execution.signal }),
      }),
    );
    context.tools.register(
      defineTool({
        id: "bots.inspect",
        description: "Inspect a bot and its recent logs",
        input: z.object({ botId: z.string().uuid() }).strict(),
        output: z
          .object({
            bot: botSchema.nullable(),
            logs: z.array(botLogSchema),
          })
          .strict(),
        approval: "auto",
        sideEffect: false,
        security: {
          outputClassification: "restricted",
          outputProvenance: "external",
        },
        execute: ({ botId }) => ({
          bot: runtime.get(botId) ?? null,
          logs: runtime.listLogs(botId),
        }),
      }),
    );

    await runtime.initialize();
    return {
      dispose: () => runtime.dispose(),
    };
  },
});
