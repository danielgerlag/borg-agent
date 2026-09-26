import { defineCommand, defineEvent } from "@borg/contracts";
import { z } from "zod";

export const botStatusSchema = z.enum([
  "stopped",
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

export const botLogLevelSchema = z.enum(["debug", "info", "warn", "error"]);

export const botLogSchema = z
  .object({
    at: z.string().datetime(),
    level: botLogLevelSchema,
    message: z.string().min(1),
    eventType: z.string().min(1).optional(),
  })
  .strict();

export const botSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1),
    personaId: z.string().min(1),
    launchPrompt: z.string().min(1),
    status: botStatusSchema,
    runId: z.string().uuid().optional(),
    error: z.string().optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    startedAt: z.string().datetime().optional(),
    completedAt: z.string().datetime().optional(),
  })
  .strict();

export type Bot = z.infer<typeof botSchema>;
export type BotLog = z.infer<typeof botLogSchema>;
export type BotStatus = z.infer<typeof botStatusSchema>;

export const botsCreate = defineCommand({
  id: "borg.bots.create",
  input: z
    .object({
      name: z.string().min(1).optional(),
      personaId: z.string().min(1).optional(),
      launchPrompt: z.string().min(1),
    })
    .strict(),
  output: z.object({ bot: botSchema }).strict(),
});

export const botsList = defineCommand({
  id: "borg.bots.list",
  input: z.object({}).strict(),
  output: z.object({ bots: z.array(botSchema) }).strict(),
});

export const botsGet = defineCommand({
  id: "borg.bots.get",
  input: z.object({ botId: z.string().uuid() }).strict(),
  output: z.object({ bot: botSchema.nullable() }).strict(),
});

export const botsStart = defineCommand({
  id: "borg.bots.start",
  input: z.object({ botId: z.string().uuid() }).strict(),
  output: z.object({ bot: botSchema }).strict(),
});

export const botsStop = defineCommand({
  id: "borg.bots.stop",
  input: z.object({ botId: z.string().uuid() }).strict(),
  output: z.object({ bot: botSchema }).strict(),
});

export const botsDelete = defineCommand({
  id: "borg.bots.delete",
  input: z.object({ botId: z.string().uuid() }).strict(),
  output: z.object({ deleted: z.boolean() }).strict(),
});

export const botsListLogs = defineCommand({
  id: "borg.bots.listLogs",
  input: z.object({ botId: z.string().uuid() }).strict(),
  output: z.object({ logs: z.array(botLogSchema) }).strict(),
});

export const botUpdated = defineEvent({
  id: "borg.bots.updated",
  payload: z.object({ bot: botSchema }).strict(),
});

export const botStarted = defineEvent({
  id: "borg.bots.started",
  payload: z.object({ bot: botSchema }).strict(),
});

export const botStopped = defineEvent({
  id: "borg.bots.stopped",
  payload: z.object({ bot: botSchema }).strict(),
});

export const botCompleted = defineEvent({
  id: "borg.bots.completed",
  payload: z.object({ bot: botSchema }).strict(),
});

export const botFailed = defineEvent({
  id: "borg.bots.failed",
  payload: z.object({ bot: botSchema }).strict(),
});
