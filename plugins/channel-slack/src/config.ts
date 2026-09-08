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

/**
 * Plugin configuration. The host parses `{}` during activation and persists the
 * parsed document on every update, so the stored shape has to survive a
 * defaults-only round trip. The "at least one channel" rule is therefore
 * expressed as a condition of being enabled rather than as an array minimum.
 */
export const slackChannelConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    ignoreBots: z.boolean().default(true),
    allowedChannelIds: channelIdsSchema.default([]),
    defaultSendChannelId: defaultSendChannelIdSchema.default(""),
  })
  .strict()
  .refine(
    (config) =>
      !config.enabled ||
      config.allowedChannelIds.length >= MIN_ALLOWED_CHANNEL_IDS,
    "Enable Slack only after allowing at least one channel id",
  )
  .refine(
    (config) =>
      config.defaultSendChannelId.length === 0 ||
      config.allowedChannelIds.includes(config.defaultSendChannelId),
    "Default send channel must be in the allow-list",
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

export type SlackChannelConfig = z.infer<typeof slackChannelConfigSchema>;

export function defaultSlackChannelConfig(): SlackChannelConfig {
  return slackChannelConfigSchema.parse({});
}

export function parseSlackChannelConfig(
  candidate: unknown,
): SlackChannelConfig {
  return slackChannelConfigSchema.parse(candidate);
}

export function sameSlackChannelConfig(
  left: SlackChannelConfig,
  right: SlackChannelConfig,
): boolean {
  return (
    left.enabled === right.enabled &&
    left.ignoreBots === right.ignoreBots &&
    left.defaultSendChannelId === right.defaultSendChannelId &&
    sameIdList(left.allowedChannelIds, right.allowedChannelIds)
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
