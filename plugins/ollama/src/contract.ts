import { defineCommand } from "@borg-agent/contracts";
import { z } from "zod";

export const ollamaStatusSchema = z
  .object({
    connected: z.boolean(),
    modelCount: z.number().int().nonnegative(),
  })
  .strict();

export type OllamaStatus = z.infer<typeof ollamaStatusSchema>;

export const ollamaGetStatus = defineCommand({
  id: "borg.ollama.getStatus",
  input: z.object({}).strict(),
  output: ollamaStatusSchema,
});

export const ollamaConnect = defineCommand({
  id: "borg.ollama.connect",
  input: z.object({}).strict(),
  output: ollamaStatusSchema,
});

export const ollamaDisconnect = defineCommand({
  id: "borg.ollama.disconnect",
  input: z.object({}).strict(),
  output: ollamaStatusSchema,
});
