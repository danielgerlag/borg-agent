import {
  DEFAULT_CONNECTOR_ACCOUNT_ID,
  MAX_CONNECTOR_ACCOUNTS,
  connectorAccountIdSchema,
  connectorAccountNameSchema,
} from "@borg/contracts";
import { z } from "@borg/plugin-sdk";
import {
  MAX_ALLOWED_CHANNEL_IDS,
  MAX_ALLOWED_GUILD_IDS,
  MIN_ALLOWED_CHANNEL_IDS,
  SNOWFLAKE_PATTERN,
} from "./protocol";

const snowflakeSchema = z
  .string()
  .regex(SNOWFLAKE_PATTERN, "Discord ids must be 17 to 20 digits");

function isDuplicateFree(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

const guildIdsSchema = z
  .array(snowflakeSchema)
  .max(MAX_ALLOWED_GUILD_IDS)
  .refine(isDuplicateFree, "Guild ids must be unique");

const channelIdsSchema = z
  .array(snowflakeSchema)
  .max(MAX_ALLOWED_CHANNEL_IDS)
  .refine(isDuplicateFree, "Channel ids must be unique");

const DISCORD_SINGLETON_KEYS = new Set([
  "enabled",
  "ignoreBots",
  "allowedGuildIds",
  "allowedChannelIds",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function liftDiscordChannelConfig(value: unknown): unknown {
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
  if (keys.every((key) => DISCORD_SINGLETON_KEYS.has(key))) {
    return {
      accounts: [
        {
          ...value,
          id: DEFAULT_CONNECTOR_ACCOUNT_ID,
          name: "Discord",
        },
      ],
    };
  }
  return value;
}

export const discordChannelAccountSchema = z
  .object({
    id: connectorAccountIdSchema,
    name: connectorAccountNameSchema,
    enabled: z.boolean().default(false),
    ignoreBots: z.boolean().default(true),
    allowedGuildIds: guildIdsSchema.default([]),
    allowedChannelIds: channelIdsSchema.default([]),
  })
  .strict()
  .refine(
    (account) =>
      !account.enabled ||
      account.allowedChannelIds.length >= MIN_ALLOWED_CHANNEL_IDS,
    "Enable Discord only after allowing at least one channel id",
  );

export const discordChannelConfigSchema = z.preprocess(
  liftDiscordChannelConfig,
  z
    .object({
      accounts: z
        .array(discordChannelAccountSchema)
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

export const discordChannelSettingsSchema = z
  .object({
    enabled: z.boolean(),
    ignoreBots: z.boolean(),
    allowedGuildIds: guildIdsSchema,
    allowedChannelIds: channelIdsSchema,
  })
  .strict()
  .refine(
    (config) =>
      !config.enabled ||
      config.allowedChannelIds.length >= MIN_ALLOWED_CHANNEL_IDS,
    "Allow at least one channel id before enabling Discord",
  );

export type DiscordChannelAccount = z.infer<typeof discordChannelAccountSchema>;
export type DiscordChannelConfig = z.infer<typeof discordChannelConfigSchema>;

export function defaultDiscordChannelConfig(): DiscordChannelConfig {
  return discordChannelConfigSchema.parse({});
}

export function parseDiscordChannelConfig(
  candidate: unknown,
): DiscordChannelConfig {
  return discordChannelConfigSchema.parse(candidate);
}

export function sameDiscordAccount(
  left: DiscordChannelAccount,
  right: DiscordChannelAccount,
): boolean {
  return (
    left.id === right.id &&
    left.name === right.name &&
    left.enabled === right.enabled &&
    left.ignoreBots === right.ignoreBots &&
    sameIdList(left.allowedGuildIds, right.allowedGuildIds) &&
    sameIdList(left.allowedChannelIds, right.allowedChannelIds)
  );
}

export function sameDiscordAccountRuntime(
  left: DiscordChannelAccount,
  right: DiscordChannelAccount,
): boolean {
  return (
    left.enabled === right.enabled &&
    left.ignoreBots === right.ignoreBots &&
    sameIdList(left.allowedGuildIds, right.allowedGuildIds) &&
    sameIdList(left.allowedChannelIds, right.allowedChannelIds)
  );
}

export function sameDiscordChannelConfig(
  left: DiscordChannelConfig,
  right: DiscordChannelConfig,
): boolean {
  return (
    left.accounts.length === right.accounts.length &&
    left.accounts.every((account, index) => {
      const other = right.accounts[index];
      return other !== undefined && sameDiscordAccount(account, other);
    })
  );
}

function sameIdList(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

export function parseSnowflakeList(text: string, label: string): string[] {
  const values: string[] = [];
  for (const candidate of text.split(/[\s,]+/)) {
    const trimmed = candidate.trim();
    if (trimmed.length === 0) {
      continue;
    }
    if (!SNOWFLAKE_PATTERN.test(trimmed)) {
      throw new Error(`${label} must be 17 to 20 digit Discord ids`);
    }
    if (values.includes(trimmed)) {
      throw new Error(`${label} must be unique`);
    }
    values.push(trimmed);
  }
  return values;
}

export function formatSnowflakeList(values: readonly string[]): string {
  return values.join("\n");
}

export function describeConfigError(error: unknown): string {
  if (error instanceof z.ZodError) {
    const issue = error.issues[0];
    return issue ? issue.message : "Discord settings are invalid";
  }
  return error instanceof Error && error.message.length > 0
    ? error.message
    : "Discord settings are invalid";
}
