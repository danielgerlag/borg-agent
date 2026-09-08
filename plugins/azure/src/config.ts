import { z } from "@borg/plugin-sdk";

export const AZURE_DEFAULT_API_VERSION = "2024-10-21";

export const azureAuthModeSchema = z.enum(["api-key", "azure-default"]);

export type AzureAuthMode = z.infer<typeof azureAuthModeSchema>;

export const azureConfigSchema = z
  .object({
    endpoint: z.string().default(""),
    apiVersion: z.string().default(AZURE_DEFAULT_API_VERSION),
    authMode: azureAuthModeSchema.default("api-key"),
    models: z.array(z.string().min(1)).default([]),
  })
  .strict();

export type AzureConfig = z.infer<typeof azureConfigSchema>;

export function parseAzureConfig(candidate: unknown): AzureConfig {
  return azureConfigSchema.parse(candidate);
}
