import { z } from "@borg/plugin-sdk";

export const copilotConfigSchema = z
  .object({
    models: z.array(z.string().min(1)).default([]),
  })
  .strict();

export type CopilotConfig = z.infer<typeof copilotConfigSchema>;

export function parseCopilotConfig(candidate: unknown): CopilotConfig {
  return copilotConfigSchema.parse(candidate);
}
