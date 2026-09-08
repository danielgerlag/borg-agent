import { z } from "@borg/plugin-sdk";

export const openrouterConfigSchema = z
  .object({
    models: z.array(z.string().min(1)).default([]),
  })
  .strict();

export type OpenRouterConfig = z.infer<typeof openrouterConfigSchema>;

export function parseOpenRouterConfig(candidate: unknown): OpenRouterConfig {
  return openrouterConfigSchema.parse(candidate);
}
