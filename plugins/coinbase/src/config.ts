import { z } from "@borg/plugin-sdk";
import {
  KEY_NAME_PATTERN,
  MAX_KEY_NAME_LENGTH,
  isKeyName,
} from "./protocol";

const keyNameSchema = z
  .string()
  .max(MAX_KEY_NAME_LENGTH)
  .refine(
    (value) => value.length === 0 || KEY_NAME_PATTERN.test(value),
    "CDP API key name must look like organizations/{org}/apiKeys/{key}",
  );

export const coinbaseConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    sandbox: z.boolean().default(false),
    keyName: keyNameSchema.default(""),
  })
  .strict()
  .refine(
    (config) => !config.enabled || isKeyName(config.keyName),
    "Enable Coinbase only after saving a CDP API key name",
  );

export const coinbaseSettingsSchema = z
  .object({
    enabled: z.boolean(),
    sandbox: z.boolean(),
    keyName: keyNameSchema,
  })
  .strict()
  .refine(
    (config) => !config.enabled || isKeyName(config.keyName),
    "Save a CDP API key name before enabling Coinbase",
  );

export type CoinbaseConfig = z.infer<typeof coinbaseConfigSchema>;

export function defaultCoinbaseConfig(): CoinbaseConfig {
  return coinbaseConfigSchema.parse({});
}

export function parseCoinbaseConfig(candidate: unknown): CoinbaseConfig {
  return coinbaseConfigSchema.parse(candidate);
}

export function sameCoinbaseConfig(
  left: CoinbaseConfig,
  right: CoinbaseConfig,
): boolean {
  return (
    left.enabled === right.enabled &&
    left.sandbox === right.sandbox &&
    left.keyName === right.keyName
  );
}

export function parseKeyName(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return "";
  }
  if (!isKeyName(trimmed)) {
    throw new Error(
      "CDP API key name must look like organizations/{org}/apiKeys/{key}",
    );
  }
  return trimmed;
}

export function describeConfigError(error: unknown): string {
  if (error instanceof z.ZodError) {
    const issue = error.issues[0];
    return issue ? issue.message : "Coinbase settings are invalid";
  }
  return error instanceof Error && error.message.length > 0
    ? error.message
    : "Coinbase settings are invalid";
}
