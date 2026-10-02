import { defineCommand } from "@borg-agent/contracts";
import { z } from "zod";

export const openrouterStatusSchema = z
  .object({
    hasKey: z.boolean(),
    connected: z.boolean(),
  })
  .strict();

export type OpenRouterStatus = z.infer<typeof openrouterStatusSchema>;

export const openrouterGetStatus = defineCommand({
  id: "borg.openrouter.getStatus",
  input: z.object({}).strict(),
  output: openrouterStatusSchema,
});

export const openrouterConnect = defineCommand({
  id: "borg.openrouter.connect",
  input: z.object({}).strict(),
  output: openrouterStatusSchema,
});

export const openrouterDisconnect = defineCommand({
  id: "borg.openrouter.disconnect",
  input: z.object({}).strict(),
  output: openrouterStatusSchema,
});
