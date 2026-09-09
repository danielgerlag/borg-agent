import {
  DEFAULT_CONNECTOR_ACCOUNT_ID,
  MAX_CONNECTOR_ACCOUNTS,
  connectorAccountIdSchema,
  connectorAccountNameSchema,
} from "@borg/contracts";
import { z } from "@borg/plugin-sdk";
import {
  EMAIL_PATTERN,
  FALLBACK_DESTINATION,
  MAX_ALLOWED_RECIPIENTS,
  MAX_EMAIL_LENGTH,
  emailKey,
  isEmailAddress,
  normalizeEmail,
} from "./protocol";

function isDuplicateFree(values: readonly string[]): boolean {
  return new Set(values.map(emailKey)).size === values.length;
}

const recipientSchema = z
  .string()
  .min(1)
  .max(MAX_EMAIL_LENGTH)
  .regex(EMAIL_PATTERN, "Recipients must be email addresses");

const recipientsSchema = z
  .array(recipientSchema)
  .max(MAX_ALLOWED_RECIPIENTS)
  .refine(isDuplicateFree, "Recipients must be unique");

const GOOGLE_SINGLETON_KEYS = new Set([
  "enabled",
  "clientId",
  "allowedRecipients",
  "mailbox",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function liftGoogleChannelConfig(value: unknown): unknown {
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
  if (keys.every((key) => GOOGLE_SINGLETON_KEYS.has(key))) {
    return {
      accounts: [
        {
          ...value,
          id: DEFAULT_CONNECTOR_ACCOUNT_ID,
          name: "Google",
        },
      ],
    };
  }
  return value;
}

export const googleChannelAccountSchema = z
  .object({
    id: connectorAccountIdSchema,
    name: connectorAccountNameSchema,
    enabled: z.boolean().default(false),
    clientId: z.string().max(256).default(""),
    allowedRecipients: recipientsSchema.default([]),
    mailbox: z.string().max(MAX_EMAIL_LENGTH).default(""),
  })
  .strict();

export const googleChannelConfigSchema = z.preprocess(
  liftGoogleChannelConfig,
  z
    .object({
      accounts: z
        .array(googleChannelAccountSchema)
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

export const googleChannelSettingsSchema = z
  .object({
    enabled: z.boolean(),
    clientId: z.string().max(256),
    allowedRecipients: recipientsSchema,
  })
  .strict();

export type GoogleChannelAccount = z.infer<typeof googleChannelAccountSchema>;
export type GoogleChannelConfig = z.infer<typeof googleChannelConfigSchema>;

export function defaultGoogleChannelConfig(): GoogleChannelConfig {
  return googleChannelConfigSchema.parse({});
}

export function parseGoogleChannelConfig(
  candidate: unknown,
): GoogleChannelConfig {
  return googleChannelConfigSchema.parse(candidate);
}

export function sameGoogleAccount(
  left: GoogleChannelAccount,
  right: GoogleChannelAccount,
): boolean {
  return (
    left.id === right.id &&
    left.name === right.name &&
    left.enabled === right.enabled &&
    left.clientId === right.clientId &&
    left.mailbox === right.mailbox &&
    sameIdList(left.allowedRecipients, right.allowedRecipients)
  );
}

export function sameGoogleAccountRuntime(
  left: GoogleChannelAccount,
  right: GoogleChannelAccount,
): boolean {
  return (
    left.enabled === right.enabled &&
    left.clientId === right.clientId &&
    left.mailbox === right.mailbox &&
    sameIdList(left.allowedRecipients, right.allowedRecipients)
  );
}

export function sameGoogleChannelConfig(
  left: GoogleChannelConfig,
  right: GoogleChannelConfig,
): boolean {
  return (
    left.accounts.length === right.accounts.length &&
    left.accounts.every((account, index) => {
      const other = right.accounts[index];
      return other !== undefined && sameGoogleAccount(account, other);
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

export function parseRecipientList(text: string): string[] {
  const values: string[] = [];
  const seen = new Set<string>();
  for (const candidate of text.split(/[\s,]+/)) {
    const trimmed = normalizeEmail(candidate);
    if (trimmed.length === 0) {
      continue;
    }
    if (!isEmailAddress(trimmed)) {
      throw new Error("Allowed recipients must be email addresses");
    }
    const key = emailKey(trimmed);
    if (seen.has(key)) {
      throw new Error("Allowed recipients must be unique");
    }
    seen.add(key);
    values.push(trimmed);
    if (values.length > MAX_ALLOWED_RECIPIENTS) {
      throw new Error(
        `Allowed recipients cannot exceed ${MAX_ALLOWED_RECIPIENTS}`,
      );
    }
  }
  return values;
}

export function formatRecipientList(values: readonly string[]): string {
  return values.join("\n");
}

export function buildDestinations(
  mailbox: string | undefined,
  allowedRecipients: readonly string[],
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  const add = (value: string): void => {
    const trimmed = normalizeEmail(value);
    if (trimmed.length === 0) {
      return;
    }
    const key = emailKey(trimmed);
    if (seen.has(key) || result.length >= MAX_ALLOWED_RECIPIENTS) {
      return;
    }
    seen.add(key);
    result.push(trimmed);
  };
  if (mailbox) {
    add(mailbox);
  }
  for (const recipient of allowedRecipients) {
    add(recipient);
  }
  if (result.length === 0) {
    result.push(FALLBACK_DESTINATION);
  }
  return result;
}

export function describeGoogleConfigError(error: unknown): string {
  if (error instanceof z.ZodError) {
    const issue = error.issues[0];
    return issue ? issue.message : "Google settings are invalid";
  }
  return error instanceof Error && error.message.length > 0
    ? error.message
    : "Google settings are invalid";
}
