import { definePlugin, defineTool, z } from "@borg-agent/plugin-sdk";

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
    kinds: ["tool"],
  },
  activate(context) {
    let standing: number | undefined;
    context.tools.register(
      defineTool({
        id: "auction.bid",
        description: "Place a bid on a lot",
        input: bidInput,
        output: bidOutput,
        approval: "auto",
        sideEffect: true,
        execute(input): z.infer<typeof bidOutput> {
          if (input.lot !== 7) {
            throw new Error(`Unknown lot ${input.lot}`);
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
          return {
            accepted: true,
            lot: input.lot,
            standing: input.amount,
            paddle: input.paddle,
          };
        },
      }),
    );
  },
});
