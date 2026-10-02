import { defineCommand } from "@borg-agent/contracts";
import { z } from "@borg-agent/plugin-sdk";

export const auctionSnapshot = defineCommand({
  id: "example.auction.snapshot",
  input: z.object({}).strict(),
  output: z
    .object({
      lot: z.literal(7),
      status: z.enum(["open", "hammered"]),
      standing: z.number().nullable(),
      paddle: z.number().nullable(),
    })
    .strict(),
});

export const auctionBid = defineCommand({
  id: "example.auction.bid",
  input: z
    .object({
      lot: z.number().int(),
      paddle: z.number().int(),
      amount: z.number().int(),
    })
    .strict(),
  output: z.discriminatedUnion("accepted", [
    z
      .object({
        accepted: z.literal(true),
        lot: z.number(),
        standing: z.number(),
        paddle: z.number(),
      })
      .strict(),
    z
      .object({
        accepted: z.literal(false),
        lot: z.number(),
        standing: z.number(),
        reason: z.string(),
      })
      .strict(),
  ]),
});

export const auctionHammer = defineCommand({
  id: "example.auction.hammer",
  input: z.object({}).strict(),
  output: z
    .object({
      lot: z.literal(7),
      standing: z.number(),
      paddle: z.number(),
    })
    .strict(),
});
