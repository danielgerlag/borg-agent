import {
  connectorAccountIdSchema,
  defineCommand,
} from "@borg-agent/contracts";
import {
  connectorAccountNameSchema,
  connectorCommandInputSchema,
} from "@borg-agent/contracts/connector-accounts";
import { z } from "zod";

export const slackSocketStateSchema = z.enum([
  "idle",
  "connecting",
  "ready",
  "backoff",
  "fatal",
]);

export const slackChannelStatusSchema = z
  .object({
    accountId: connectorAccountIdSchema,
    name: connectorAccountNameSchema,
    adapterId: z.string().min(1).max(200),
    hasBotToken: z.boolean(),
    hasAppToken: z.boolean(),
    connected: z.boolean(),
    botUserId: z.string().optional(),
    socketState: slackSocketStateSchema,
    error: z.string().max(1_000).optional(),
  })
  .strict();

export type SlackSocketState = z.infer<typeof slackSocketStateSchema>;
export type SlackChannelStatus = z.infer<typeof slackChannelStatusSchema>;

export const slackChannelGetStatus = defineCommand({
  id: "borg.channel.slack.getStatus",
  input: connectorCommandInputSchema,
  output: slackChannelStatusSchema,
});

export const slackChannelVerify = defineCommand({
  id: "borg.channel.slack.verify",
  input: connectorCommandInputSchema,
  output: slackChannelStatusSchema,
  timeoutMs: 30_000,
});

export const slackChannelDisconnect = defineCommand({
  id: "borg.channel.slack.disconnect",
  input: connectorCommandInputSchema,
  output: slackChannelStatusSchema,
});
