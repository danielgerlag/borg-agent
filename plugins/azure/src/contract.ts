import { defineCommand } from "@borg/contracts";
import { z } from "zod";

export const azureAuthModeSchema = z.enum(["api-key", "azure-default"]);

export type AzureAuthMode = z.infer<typeof azureAuthModeSchema>;

export const azureStatusSchema = z
  .object({
    hasKey: z.boolean(),
    connected: z.boolean(),
    authMode: azureAuthModeSchema,
  })
  .strict();

export type AzureStatus = z.infer<typeof azureStatusSchema>;

export const azureGetStatus = defineCommand({
  id: "borg.azure.getStatus",
  input: z.object({}).strict(),
  output: azureStatusSchema,
});

export const azureConnect = defineCommand({
  id: "borg.azure.connect",
  input: z.object({}).strict(),
  output: azureStatusSchema,
});

export const azureDisconnect = defineCommand({
  id: "borg.azure.disconnect",
  input: z.object({}).strict(),
  output: azureStatusSchema,
});
