/**
 * Commands, tool ids, and schemas the plugin and the chat screen share.
 */

import { defineCommand } from "@borg-agent/contracts";
import { z } from "@borg-agent/plugin-sdk";

export const listToolId = "example.hello-world.list";
export const readToolId = "example.hello-world.read";
export const writeToolId = "example.hello-world.write";
export const promptToolId = "example.hello-world.prompt";
export const feedbackAskToolId = "feedback.ask";
export const preferModelToolId = "example.hello-world.prefer-model";
export const newChatToolId = "example.hello-world.new-chat";
export const openChatToolId = "example.hello-world.open-chat";
export const deleteChatToolId = "example.hello-world.delete-chat";

export const helloWorldAssistantId = "hello-world/assistant";

/** Largest UTF-8 file the folder tools will read or write. */
export const workspaceFileLimit = 1_048_576;

/** Persona preference until Settings chooses a connected model. */
export const unconfiguredModelPreference = "example.hello-world:unconfigured";

export const connectModelMessage =
  "Connect a model in Settings, then choose it for this chat.";

const pathSchema = z.string().min(1).max(1024);

export const listToolInput = z.object({}).strict();

export const readToolInput = z.object({ path: pathSchema }).strict();

export const writeToolInput = z
  .object({
    path: pathSchema,
    content: z.string().max(workspaceFileLimit),
  })
  .strict();

export const fileEntrySchema = z
  .object({
    path: z.string().min(1),
    size: z.number().int().nonnegative(),
  })
  .strict();

export const listToolOutput = z
  .object({
    files: z.array(fileEntrySchema),
    error: z.string().min(1).optional(),
  })
  .strict();

export const readToolOutput = z
  .object({
    path: z.string(),
    content: z.string(),
    error: z.string().min(1).optional(),
  })
  .strict();

export const writeToolOutput = z
  .object({
    path: z.string(),
    bytesWritten: z.number().int().nonnegative(),
    error: z.string().min(1).optional(),
  })
  .strict();

export const turnSchema = z
  .object({
    role: z.enum(["user", "assistant"]),
    text: z.string().min(1),
  })
  .strict();

export const chatSummarySchema = z
  .object({
    id: z.string().uuid(),
    title: z.string().min(1).max(48),
    updatedAt: z.string().min(1),
  })
  .strict();

const personaSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    allowedTools: z.array(z.string().min(1)),
  })
  .strict();

export const snapshotSchema = z
  .object({
    chat: z
      .object({
        id: z.string().uuid(),
        title: z.string().min(1).max(48),
      })
      .strict(),
    chats: z.array(chatSummarySchema),
    persona: personaSchema,
    turns: z.array(turnSchema),
    files: z.array(fileEntrySchema),
    model: z.string().min(1).nullable(),
  })
  .strict();

export const effectSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("asked") }).strict(),
  z.object({ type: z.literal("model") }).strict(),
  z.object({ type: z.literal("chat") }).strict(),
]);

export const actInputSchema = z.discriminatedUnion("tool", [
  z.object({ tool: z.literal(promptToolId), text: z.string().min(1) }).strict(),
  z
    .object({
      tool: z.literal(preferModelToolId),
      preferenceId: z.string().regex(/^[a-z0-9]+(?:[.-][a-z0-9-]+)+:\S+$/),
    })
    .strict(),
  z.object({ tool: z.literal(newChatToolId) }).strict(),
  z.object({ tool: z.literal(openChatToolId), chatId: z.string().uuid() }).strict(),
  z.object({ tool: z.literal(deleteChatToolId), chatId: z.string().uuid() }).strict(),
]);

export const helloWorldSnapshot = defineCommand({
  id: "example.hello-world.snapshot",
  input: z.object({}).strict(),
  output: snapshotSchema,
});

export const helloWorldAct = defineCommand({
  id: "example.hello-world.act",
  input: actInputSchema,
  output: z
    .object({
      snapshot: snapshotSchema,
      effect: effectSchema,
    })
    .strict(),
  // A question waits on a person. The bus default is 30s.
  timeoutMs: 300_000,
});

export type HelloWorldSnapshot = z.output<typeof snapshotSchema>;
export type ActInput = z.output<typeof actInputSchema>;
