import { definePlugin } from "@borg-agent/plugin-sdk";

const usage = { inputTokens: 1, outputTokens: 1 } as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readObservation(content: string): {
  inRange: boolean;
  species: string;
  place: string;
} {
  const parsed: unknown = JSON.parse(content);
  if (!isRecord(parsed)) {
    throw new Error("Tool result is not an object");
  }
  const { inRange, species, place } = parsed;
  if (
    typeof inRange !== "boolean" ||
    typeof species !== "string" ||
    typeof place !== "string"
  ) {
    throw new Error("Observation result is missing fields");
  }
  return { inRange, species, place };
}

export default definePlugin({
  id: "example.field.model",
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
      id: "example.field.model",
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
                id: "call-observe-1",
                name: "field.observe",
                input: {
                  species: "cicindela sexguttata",
                  place: "thunder bay",
                },
              },
            ],
            usage,
          };
        }
        const lastTool = results.at(-1);
        if (!lastTool) {
          throw new Error("Tool result is missing");
        }
        if (results.length === 1) {
          const seen = readObservation(lastTool.content);
          if (seen.inRange) {
            throw new Error("Thunder Bay sighting should be out of range");
          }
          await permit.commit();
          return {
            toolCalls: [
              {
                id: "call-observe-2",
                name: "field.observe",
                input: {
                  species: "cicindela sexguttata",
                  place: "point pelee",
                },
              },
            ],
            usage,
          };
        }
        if (results.length === 2) {
          const seen = readObservation(lastTool.content);
          if (!seen.inRange) {
            throw new Error("Last sighting is out of range");
          }
          await permit.commit();
          return {
            toolCalls: [
              {
                id: "call-voucher",
                name: "field.voucher",
                input: { species: seen.species, place: seen.place },
              },
            ],
            usage,
          };
        }
        if (results.length === 3) {
          const parsed: unknown = JSON.parse(lastTool.content);
          if (!isRecord(parsed)) {
            throw new Error("Tool result is not an object");
          }
          const voucher = parsed.voucher;
          if (parsed.filed === true && typeof voucher === "string") {
            await permit.commit();
            return {
              content: `Field catalog: voucher ${voucher} for cicindela sexguttata at point pelee`,
              usage,
            };
          }
          throw new Error("Voucher was not filed");
        }
        throw new Error(`Unexpected tool result count ${results.length}`);
      },
    });
  },
});
