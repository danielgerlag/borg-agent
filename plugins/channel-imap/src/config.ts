import {
  DEFAULT_CONNECTOR_ACCOUNT_ID,
  MAX_CONNECTOR_ACCOUNTS,
  connectorAccountIdSchema,
  connectorAccountNameSchema,
} from "@borg/contracts";
import { z } from "@borg/plugin-sdk";
import { IMAP_DEFAULT_MAILBOX } from "./runtime";

const IMAP_SINGLETON_KEYS = new Set([
  "enabled",
  "host",
  "port",
  "username",
  "mailbox",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function liftImapChannelConfig(value: unknown): unknown {
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
  if (keys.every((key) => IMAP_SINGLETON_KEYS.has(key))) {
    return {
      accounts: [
        {
          ...value,
          id: DEFAULT_CONNECTOR_ACCOUNT_ID,
          name: "IMAP",
        },
      ],
    };
  }
  return value;
}

export const imapChannelAccountSchema = z
  .object({
    id: connectorAccountIdSchema,
    name: connectorAccountNameSchema,
    enabled: z.boolean().default(false),
    host: z.string().max(253).default(""),
    port: z.number().int().min(1).max(65_535).default(993),
    username: z.string().max(320).default(""),
    mailbox: z.string().min(1).max(256).default(IMAP_DEFAULT_MAILBOX),
  })
  .strict();

export const imapChannelConfigSchema = z.preprocess(
  liftImapChannelConfig,
  z
    .object({
      accounts: z
        .array(imapChannelAccountSchema)
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

export const imapChannelSettingsSchema = z
  .object({
    enabled: z.boolean(),
    host: z.string().max(253),
    port: z.number().int().min(1).max(65_535),
    username: z.string().max(320),
    mailbox: z.string().min(1).max(256),
  })
  .strict();

export type ImapChannelAccount = z.infer<typeof imapChannelAccountSchema>;
export type ImapChannelConfig = z.infer<typeof imapChannelConfigSchema>;

export function defaultImapChannelConfig(): ImapChannelConfig {
  return imapChannelConfigSchema.parse({});
}

export function parseImapChannelConfig(candidate: unknown): ImapChannelConfig {
  return imapChannelConfigSchema.parse(candidate);
}

export function sameImapAccount(
  left: ImapChannelAccount,
  right: ImapChannelAccount,
): boolean {
  return (
    left.id === right.id &&
    left.name === right.name &&
    sameImapAccountRuntime(left, right)
  );
}

export function sameImapAccountRuntime(
  left: ImapChannelAccount,
  right: ImapChannelAccount,
): boolean {
  return (
    left.enabled === right.enabled &&
    left.host === right.host &&
    left.port === right.port &&
    left.username === right.username &&
    left.mailbox === right.mailbox
  );
}

export function sameImapChannelConfig(
  left: ImapChannelConfig,
  right: ImapChannelConfig,
): boolean {
  return (
    left.accounts.length === right.accounts.length &&
    left.accounts.every((account, index) => {
      const other = right.accounts[index];
      return other !== undefined && sameImapAccount(account, other);
    })
  );
}

export function describeImapConfigError(error: unknown): string {
  if (error instanceof z.ZodError) {
    const issue = error.issues[0];
    return issue ? issue.message : "IMAP settings are invalid";
  }
  return error instanceof Error && error.message.length > 0
    ? error.message
    : "IMAP settings are invalid";
}
