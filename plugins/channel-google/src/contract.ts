import {
  connectorAccountIdSchema,
  dataClassificationSchema,
  defineCommand,
} from "@borg/contracts";
import {
  connectorAccountNameSchema,
  connectorCommandInputSchema,
} from "@borg/contracts/connector-accounts";
import { z } from "zod";

export const googleChannelStatusSchema = z
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

export type GoogleChannelStatus = z.infer<typeof googleChannelStatusSchema>;

export const googleChannelGetStatus = defineCommand({
  id: "borg.channel.google.getStatus",
  input: connectorCommandInputSchema,
  output: googleChannelStatusSchema,
});

export const googleChannelConnect = defineCommand({
  id: "borg.channel.google.connect",
  input: connectorCommandInputSchema,
  output: googleChannelStatusSchema,
  timeoutMs: 180_000,
});

export const googleChannelDisconnect = defineCommand({
  id: "borg.channel.google.disconnect",
  input: connectorCommandInputSchema,
  output: googleChannelStatusSchema,
});

export const googleChannelInject = defineCommand({
  id: "borg.channel.google.inject",
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
