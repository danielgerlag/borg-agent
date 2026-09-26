import { defineCommand } from "@borg/contracts";
import { z } from "zod";

export const anthropicStatusSchema = z
  .object({
    hasKey: z.boolean(),
    connected: z.boolean(),
  })
  .strict();

export type AnthropicStatus = z.infer<typeof anthropicStatusSchema>;

export const anthropicGetStatus = defineCommand({
  id: "borg.anthropic.getStatus",
  input: z.object({}).strict(),
  output: anthropicStatusSchema,
});

export const anthropicConnect = defineCommand({
  id: "borg.anthropic.connect",
  input: z.object({}).strict(),
  output: anthropicStatusSchema,
});

export const anthropicDisconnect = defineCommand({
  id: "borg.anthropic.disconnect",
  input: z.object({}).strict(),
  output: anthropicStatusSchema,
});
