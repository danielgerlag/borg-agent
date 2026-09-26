import {
  connectorAccountIdSchema,
  dataClassificationSchema,
  defineCommand,
} from "@borg/contracts";
import { z } from "zod";

export const imapChannelInject = defineCommand({
  id: "borg.channel.imap.inject",
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
