import { defineCommand } from "@borg/contracts";
import { z } from "zod";

export const openaiStatusSchema = z
  .object({
    hasKey: z.boolean(),
    connected: z.boolean(),
  })
  .strict();

export type OpenAIStatus = z.infer<typeof openaiStatusSchema>;

export const openaiGetStatus = defineCommand({
  id: "borg.openai.getStatus",
  input: z.object({}).strict(),
  output: openaiStatusSchema,
});

export const openaiConnect = defineCommand({
  id: "borg.openai.connect",
  input: z.object({}).strict(),
  output: openaiStatusSchema,
});

export const openaiDisconnect = defineCommand({
  id: "borg.openai.disconnect",
  input: z.object({}).strict(),
  output: openaiStatusSchema,
});
