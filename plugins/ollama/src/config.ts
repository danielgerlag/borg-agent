import { z } from "@borg/plugin-sdk";

export const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434/v1";

export const ollamaConfigSchema = z
  .object({
    baseUrl: z.string().default(DEFAULT_OLLAMA_BASE_URL),
    models: z.array(z.string().min(1)).default([]),
  })
  .strict();

export type OllamaConfig = z.infer<typeof ollamaConfigSchema>;

export function parseOllamaConfig(candidate: unknown): OllamaConfig {
  return ollamaConfigSchema.parse(candidate);
}
