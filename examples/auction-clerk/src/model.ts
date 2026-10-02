import { definePlugin } from "@borg-agent/plugin-sdk";

const usage = { inputTokens: 1, outputTokens: 1 } as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export default definePlugin({
  id: "example.auction.model",
  version: "0.1.0",
  engines: {
    borg: "^0.1.0",
  },
  permissions: ["models.register"],
  contributes: {
    kinds: ["llmProvider"],
  },
  activate(context) {
    context.models.registerProvider({
      id: "example.auction.model",
      models: ["scripted"],
      egress: { kind: "local", capacity: "local-only" },
      async complete(request, permit) {
        const results = request.messages.filter(
          (message) => message.role === "tool",
        );
        if (results.length === 0) {
          await permit.commit();
          return {
            toolCalls: [
              {
                id: "call-bid-1",
                name: "auction.bid",
                input: { lot: 7, paddle: 2, amount: 10 },
              },
            ],
            usage,
          };
        }
        if (results.length === 1) {
          await permit.commit();
          return {
            toolCalls: [
              {
                id: "call-bid-2",
                name: "auction.bid",
                input: { lot: 7, paddle: 9, amount: 8 },
              },
            ],
            usage,
          };
        }
        if (results.length === 2) {
          await permit.commit();
          return {
            toolCalls: [
              {
                id: "call-bid-3",
                name: "auction.bid",
                input: { lot: 7, paddle: 4, amount: 15 },
              },
            ],
            usage,
          };
        }
        const lastTool = results.at(-1);
        if (results.length !== 3 || !lastTool) {
          throw new Error(`Unexpected tool result count ${results.length}`);
        }
        const parsed: unknown = JSON.parse(lastTool.content);
        if (
          !isRecord(parsed) ||
          parsed.accepted !== true ||
          parsed.standing !== 15 ||
          parsed.paddle !== 4
        ) {
          throw new Error("Lot 7 was not hammered at 15 to paddle 4");
        }
        await permit.commit();
        return {
          content: "Auction clerk: lot 7 hammered at 15 to paddle 4",
          usage,
        };
      },
    });
  },
});
