import {
  DEFAULT_CONNECTOR_ACCOUNT_ID,
  MAX_CONNECTOR_ACCOUNTS,
  connectorAccountIdSchema,
  connectorAccountNameSchema,
} from "@borg/contracts";
import { z } from "@borg/plugin-sdk";
import { KEY_NAME_PATTERN, MAX_KEY_NAME_LENGTH, isKeyName } from "./protocol";

const keyNameSchema = z
  .string()
  .max(MAX_KEY_NAME_LENGTH)
  .refine(
    (value) => value.length === 0 || KEY_NAME_PATTERN.test(value),
    "CDP API key name must look like organizations/{org}/apiKeys/{key}",
  );

const COINBASE_SINGLETON_KEYS = new Set(["enabled", "sandbox", "keyName"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function liftCoinbaseConfig(value: unknown): unknown {
  if (!isPlainObject(value)) {
    return value;
  }
  if (Array.isArray(value.accounts)) {
    return { accounts: value.accounts };
  }
  const keys = Object.keys(value);
  if (keys.length === 0) {
    return { accounts: [] };
  }
  if (keys.every((key) => COINBASE_SINGLETON_KEYS.has(key))) {
    return {
      accounts: [
        {
          ...value,
          id: DEFAULT_CONNECTOR_ACCOUNT_ID,
          name: "Coinbase",
        },
      ],
    };
  }
  return value;
}

export const coinbaseConnectorAccountSchema = z
  .object({
    id: connectorAccountIdSchema,
    name: connectorAccountNameSchema,
    enabled: z.boolean().default(false),
    sandbox: z.boolean().default(false),
    keyName: keyNameSchema.default(""),
  })
  .strict()
  .refine(
    (account) => !account.enabled || isKeyName(account.keyName),
    "Enable Coinbase only after saving a CDP API key name",
  );

export const coinbaseConfigSchema = z.preprocess(
  liftCoinbaseConfig,
  z
    .object({
      accounts: z
        .array(coinbaseConnectorAccountSchema)
        .max(MAX_CONNECTOR_ACCOUNTS)
        .default([]),
    })
    .strict()
    .refine(
      (config) =>
        new Set(config.accounts.map((account) => account.id)).size ===
        config.accounts.length,
      "Connector account ids must be unique",
    ),
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

export type CoinbaseConnectorAccount = z.infer<
  typeof coinbaseConnectorAccountSchema
>;
export type CoinbaseConfig = z.infer<typeof coinbaseConfigSchema>;

export function defaultCoinbaseConfig(): CoinbaseConfig {
  return coinbaseConfigSchema.parse({});
}

export function parseCoinbaseConfig(candidate: unknown): CoinbaseConfig {
  return coinbaseConfigSchema.parse(candidate);
}

export function sameCoinbaseAccount(
  left: CoinbaseConnectorAccount,
  right: CoinbaseConnectorAccount,
): boolean {
  return (
    left.id === right.id &&
    left.name === right.name &&
    left.enabled === right.enabled &&
    left.sandbox === right.sandbox &&
    left.keyName === right.keyName
  );
}

export function sameCoinbaseConfig(
  left: CoinbaseConfig,
  right: CoinbaseConfig,
): boolean {
  return (
    left.accounts.length === right.accounts.length &&
    left.accounts.every((account, index) => {
      const other = right.accounts[index];
      return other !== undefined && sameCoinbaseAccount(account, other);
    })
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
