import {
  dataClassificationSchema,
  defineCommand,
} from "@borg/contracts";
import { z } from "zod";

export const mockChannelInject = defineCommand({
  id: "borg.channel.mock.inject",
  input: z
    .object({
      destinationId: z.string().min(1).max(256).default("default"),
      externalId: z.string().min(1).max(256).optional(),
      text: z.string().max(65_536),
      sender: z.string().min(1).max(256).optional(),
      classification: dataClassificationSchema.optional(),
    })
    .strict(),
  output: z.object({ accepted: z.literal(true), externalId: z.string() }).strict(),
});

export const mockChannelSend = defineCommand({
  id: "borg.channel.mock.send",
  input: z
    .object({
      destinationId: z.string().min(1).max(256).default("default"),
      text: z.string().max(65_536),
      classification: dataClassificationSchema.optional(),
      idempotencyKey: z.string().min(1).max(200),
    })
    .strict(),
  output: z.discriminatedUnion("status", [
    z
      .object({
        status: z.literal("sent"),
        messageId: z.string().uuid(),
        externalId: z.string().min(1),
        sentAt: z.string().datetime(),
      })
      .strict(),
    z
      .object({
        status: z.literal("duplicate"),
        messageId: z.string().uuid(),
        externalId: z.string().min(1).optional(),
      })
      .strict(),
    z
      .object({
        status: z.literal("denied"),
        reasons: z.array(z.string().min(1).max(1_000)).max(20),
      })
      .strict(),
  ]),
});
