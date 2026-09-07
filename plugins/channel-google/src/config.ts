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

export const googleChannelConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    clientId: z.string().max(256).default(""),
    allowedRecipients: recipientsSchema.default([]),
    mailbox: z.string().max(MAX_EMAIL_LENGTH).default(""),
  })
  .strict();

export type GoogleChannelConfig = z.infer<typeof googleChannelConfigSchema>;

export function parseGoogleChannelConfig(
  candidate: unknown,
): GoogleChannelConfig {
  return googleChannelConfigSchema.parse(candidate);
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
