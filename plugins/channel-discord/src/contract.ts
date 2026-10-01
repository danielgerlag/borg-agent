import {
  connectorAccountIdSchema,
  defineCommand,
} from "@borg/contracts";
import {
  connectorAccountNameSchema,
  connectorCommandInputSchema,
} from "@borg/contracts/connector-accounts";
import { z } from "zod";

export const discordChannelStatusSchema = z
  .object({
    accountId: connectorAccountIdSchema,
    name: connectorAccountNameSchema,
    adapterId: z.string().min(1).max(200),
    hasToken: z.boolean(),
    connected: z.boolean(),
    botUserId: z.string().optional(),
    gatewayState: z.enum([
      "idle",
      "connecting",
      "identifying",
      "resuming",
      "ready",
      "backoff",
      "fatal",
    ]),
    error: z.string().max(1_000).optional(),
  })
  .strict();

export type DiscordChannelStatus = z.infer<typeof discordChannelStatusSchema>;

export const discordChannelGetStatus = defineCommand({
  id: "borg.channel.discord.getStatus",
  input: connectorCommandInputSchema,
  output: discordChannelStatusSchema,
});

export const discordChannelVerify = defineCommand({
  id: "borg.channel.discord.verify",
  input: connectorCommandInputSchema,
  output: discordChannelStatusSchema,
  timeoutMs: 30_000,
});

export const discordChannelDisconnect = defineCommand({
  id: "borg.channel.discord.disconnect",
  input: connectorCommandInputSchema,
  output: discordChannelStatusSchema,
});
