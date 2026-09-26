import {
  connectorAccountIdSchema,
  connectorAccountNameSchema,
  connectorCommandInputSchema,
  dataClassificationSchema,
  defineCommand,
} from "@borg/contracts";
import { z } from "zod";

export const m365ChannelStatusSchema = z
  .object({
    accountId: connectorAccountIdSchema,
    name: connectorAccountNameSchema,
    adapterId: z.string().min(1).max(200),
    connected: z.boolean(),
    hasClientId: z.boolean(),
    mailbox: z.string().min(1).max(320).optional(),
    error: z.string().max(1_000).optional(),
  })
  .strict();

export type M365ChannelStatus = z.infer<typeof m365ChannelStatusSchema>;

export const m365ChannelGetStatus = defineCommand({
  id: "borg.channel.m365.getStatus",
  input: connectorCommandInputSchema,
  output: m365ChannelStatusSchema,
});

export const m365ChannelConnect = defineCommand({
  id: "borg.channel.m365.connect",
  input: connectorCommandInputSchema,
  output: m365ChannelStatusSchema,
  timeoutMs: 180_000,
});

export const m365ChannelDisconnect = defineCommand({
  id: "borg.channel.m365.disconnect",
  input: connectorCommandInputSchema,
  output: m365ChannelStatusSchema,
});

export const m365ChannelInject = defineCommand({
  id: "borg.channel.m365.inject",
  input: z
    .object({
      accountId: connectorAccountIdSchema.optional(),
      destinationId: z.string().min(1).max(256).optional(),
      externalId: z.string().min(1).max(256).optional(),
      text: z.string().max(65_536),
      sender: z.string().min(1).max(256).optional(),
      classification: dataClassificationSchema.optional(),
    })
    .strict(),
  output: z
    .object({ accepted: z.literal(true), externalId: z.string() })
    .strict(),
});
