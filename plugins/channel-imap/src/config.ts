import { z } from "@borg/plugin-sdk";
import { IMAP_DEFAULT_MAILBOX } from "./runtime";

export const imapChannelConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    host: z.string().max(253).default(""),
    port: z.number().int().min(1).max(65_535).default(993),
    username: z.string().max(320).default(""),
    mailbox: z.string().min(1).max(256).default(IMAP_DEFAULT_MAILBOX),
  })
  .strict();

export type ImapChannelConfig = z.infer<typeof imapChannelConfigSchema>;

export function parseImapChannelConfig(candidate: unknown): ImapChannelConfig {
  return imapChannelConfigSchema.parse(candidate);
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
