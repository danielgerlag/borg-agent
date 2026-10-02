import { definePlugin, defineTool, z } from "@borg-agent/plugin-sdk";
import { auctionBid, auctionHammer, auctionSnapshot } from "./contract";

const bidInput = z
  .object({
    lot: z.number().int(),
    paddle: z.number().int(),
    amount: z.number().int(),
  })
  .strict();

const bidOutput = z.discriminatedUnion("accepted", [
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
]);

export default definePlugin({
  id: "example.auction.book",
  version: "0.1.0",
  engines: {
    borg: "^0.1.0",
  },
  permissions: ["tools.register"],
  contributes: {
    commands: [auctionSnapshot.id, auctionBid.id, auctionHammer.id],
    kinds: ["tool"],
  },
  activate(context) {
    let standing: number | undefined;
    let paddle: number | undefined;
    let hammered = false;
    const placeBid = (input: {
      lot: number;
      paddle: number;
      amount: number;
    }): z.infer<typeof bidOutput> => {
      if (input.lot !== 7) {
        throw new Error(`Unknown lot ${input.lot}`);
      }
      if (hammered) {
        return {
          accepted: false,
          lot: input.lot,
          standing: standing ?? 0,
          reason: "lot is closed",
        };
      }
      const current = standing;
      if (current === undefined) {
        if (input.amount <= 0) {
          return {
            accepted: false,
            lot: input.lot,
            standing: 0,
            reason: `bid ${input.amount} is not positive`,
          };
        }
        standing = input.amount;
        paddle = input.paddle;
        return {
          accepted: true,
          lot: input.lot,
          standing: input.amount,
          paddle: input.paddle,
        };
      }
      if (input.amount <= current) {
        return {
          accepted: false,
          lot: input.lot,
          standing: current,
          reason: `bid ${input.amount} does not beat ${current}`,
        };
      }
      standing = input.amount;
      paddle = input.paddle;
      return {
        accepted: true,
        lot: input.lot,
        standing: input.amount,
        paddle: input.paddle,
      };
    };
    context.bus.handle(auctionSnapshot, async () => ({
      lot: 7 as const,
      status: hammered ? ("hammered" as const) : ("open" as const),
      standing: standing ?? null,
      paddle: paddle ?? null,
    }));
    context.bus.handle(auctionBid, async (input) => placeBid(input));
    context.bus.handle(auctionHammer, async () => {
      if (hammered) {
        throw new Error("Lot 7 is already hammered");
      }
      if (standing === undefined || paddle === undefined) {
        throw new Error("There is no standing bid");
      }
      hammered = true;
      return { lot: 7 as const, standing, paddle };
    });
    context.tools.register(
      defineTool({
        id: "auction.bid",
        description: "Place a bid on a lot",
        input: bidInput,
        output: bidOutput,
        approval: "auto",
        sideEffect: true,
        execute: placeBid,
      }),
    );
  },
});
