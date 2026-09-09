import {
  DEFAULT_CONNECTOR_ACCOUNT_ID,
  MAX_CONNECTOR_ACCOUNTS,
  connectorAccountIdSchema,
  connectorAccountNameSchema,
} from "@borg/contracts";
import { z } from "@borg/plugin-sdk";
import {
  CHANNEL_ID_PATTERN,
  MAX_ALLOWED_CHANNEL_IDS,
  MAX_CHANNEL_ID_LENGTH,
  MIN_ALLOWED_CHANNEL_IDS,
} from "./protocol";

const channelIdSchema = z
  .string()
  .max(MAX_CHANNEL_ID_LENGTH)
  .regex(CHANNEL_ID_PATTERN, "Slack ids must be C, D, or G channel ids");

function isDuplicateFree(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

const channelIdsSchema = z
  .array(channelIdSchema)
  .max(MAX_ALLOWED_CHANNEL_IDS)
  .refine(isDuplicateFree, "Channel ids must be unique");

const defaultSendChannelIdSchema = z.union([z.literal(""), channelIdSchema]);

const SLACK_SINGLETON_KEYS = new Set([
  "enabled",
  "ignoreBots",
  "allowedChannelIds",
  "defaultSendChannelId",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function liftSlackChannelConfig(value: unknown): unknown {
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
  if (keys.every((key) => SLACK_SINGLETON_KEYS.has(key))) {
    return {
      accounts: [
        {
          ...value,
          id: DEFAULT_CONNECTOR_ACCOUNT_ID,
          name: "Slack",
        },
      ],
    };
  }
  return value;
}

export const slackChannelAccountSchema = z
  .object({
    id: connectorAccountIdSchema,
    name: connectorAccountNameSchema,
    enabled: z.boolean().default(false),
    ignoreBots: z.boolean().default(true),
    allowedChannelIds: channelIdsSchema.default([]),
    defaultSendChannelId: defaultSendChannelIdSchema.default(""),
  })
  .strict()
  .refine(
    (account) =>
      !account.enabled ||
      account.allowedChannelIds.length >= MIN_ALLOWED_CHANNEL_IDS,
    "Enable Slack only after allowing at least one channel id",
  )
  .refine(
    (account) =>
      account.defaultSendChannelId.length === 0 ||
      account.allowedChannelIds.includes(account.defaultSendChannelId),
    "Default send channel must be in the allow-list",
  );

export const slackChannelConfigSchema = z.preprocess(
  liftSlackChannelConfig,
  z
    .object({
      accounts: z
        .array(slackChannelAccountSchema)
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

export const slackChannelSettingsSchema = z
  .object({
    enabled: z.boolean(),
    ignoreBots: z.boolean(),
    allowedChannelIds: channelIdsSchema,
    defaultSendChannelId: defaultSendChannelIdSchema,
  })
  .strict()
  .refine(
    (config) =>
      !config.enabled ||
      config.allowedChannelIds.length >= MIN_ALLOWED_CHANNEL_IDS,
    "Allow at least one channel id before enabling Slack",
  )
  .refine(
    (config) =>
      config.defaultSendChannelId.length === 0 ||
      config.allowedChannelIds.includes(config.defaultSendChannelId),
    "Default send channel must be in the allow-list",
  );

export type SlackChannelAccount = z.infer<typeof slackChannelAccountSchema>;
export type SlackChannelConfig = z.infer<typeof slackChannelConfigSchema>;

export function defaultSlackChannelConfig(): SlackChannelConfig {
  return slackChannelConfigSchema.parse({});
}

export function parseSlackChannelConfig(
  candidate: unknown,
): SlackChannelConfig {
  return slackChannelConfigSchema.parse(candidate);
}

export function sameSlackAccount(
  left: SlackChannelAccount,
  right: SlackChannelAccount,
): boolean {
  return (
    left.id === right.id &&
    left.name === right.name &&
    left.enabled === right.enabled &&
    left.ignoreBots === right.ignoreBots &&
    left.defaultSendChannelId === right.defaultSendChannelId &&
    sameIdList(left.allowedChannelIds, right.allowedChannelIds)
  );
}

export function sameSlackAccountRuntime(
  left: SlackChannelAccount,
  right: SlackChannelAccount,
): boolean {
  return (
    left.enabled === right.enabled &&
    left.ignoreBots === right.ignoreBots &&
    left.defaultSendChannelId === right.defaultSendChannelId &&
    sameIdList(left.allowedChannelIds, right.allowedChannelIds)
  );
}

export function sameSlackChannelConfig(
  left: SlackChannelConfig,
  right: SlackChannelConfig,
): boolean {
  return (
    left.accounts.length === right.accounts.length &&
    left.accounts.every((account, index) => {
      const other = right.accounts[index];
      return other !== undefined && sameSlackAccount(account, other);
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

export function parseChannelList(text: string, label: string): string[] {
  const values: string[] = [];
  for (const candidate of text.split(/[\s,]+/)) {
    const trimmed = candidate.trim();
    if (trimmed.length === 0) {
      continue;
    }
    if (
      trimmed.length > MAX_CHANNEL_ID_LENGTH ||
      !CHANNEL_ID_PATTERN.test(trimmed)
    ) {
      throw new Error(`${label} must be C, D, or G Slack channel ids`);
    }
    if (values.includes(trimmed)) {
      throw new Error(`${label} must be unique`);
    }
    values.push(trimmed);
  }
  return values;
}

export function parseOptionalChannelId(text: string, label: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return "";
  }
  if (
    trimmed.length > MAX_CHANNEL_ID_LENGTH ||
    !CHANNEL_ID_PATTERN.test(trimmed)
  ) {
    throw new Error(`${label} must be a C, D, or G Slack channel id`);
  }
  return trimmed;
}

export function formatChannelList(values: readonly string[]): string {
  return values.join("\n");
}

export function describeConfigError(error: unknown): string {
  if (error instanceof z.ZodError) {
    const issue = error.issues[0];
    return issue ? issue.message : "Slack settings are invalid";
  }
  return error instanceof Error && error.message.length > 0
    ? error.message
    : "Slack settings are invalid";
}
