import { randomUUID } from "node:crypto";
import type { PluginContext } from "@borg-agent/plugin-sdk";
import { parametersSchema, proposeToolId } from "./contract.js";

const usage = {
  inputTokens: 8,
  outputTokens: 8,
  amount: 0,
  currency: "USD",
};

export function registerScriptedModel(context: PluginContext): {
  dispose(): void;
} {
  return context.models.registerProvider({
    id: "example.print-bench",
    models: ["scripted"],
    egress: { kind: "local", capacity: "local-only" },
    async complete(request, permit, signal) {
      signal.throwIfAborted();
      await permit.commit();
      const last = request.messages.at(-1);
      if (last?.role === "tool") {
        return { content: "Revision proposed.", usage };
      }
      const advertised = request.tools.some((tool) => tool.id === proposeToolId);
      if (!advertised) {
        return { content: "The designer cannot propose from this seat.", usage };
      }
      const marked = request.messages
        .find((message) => message.role === "user")
        ?.content.match(/Current parameters: (\{.*\})/u);
      const parsed = parametersSchema.parse(JSON.parse(marked?.[1] ?? ""));
      return {
        toolCalls: [
          {
            id: randomUUID(),
            name: proposeToolId,
            input: {
              parameters: {
                wallMm: 1.6,
                holeMm: parsed.holeMm,
                footprint: {
                  widthMm: parsed.footprint.widthMm,
                  depthMm: parsed.footprint.depthMm,
                },
                chamferDeg: 30,
              },
            },
          },
        ],
        usage,
      };
    },
  });
}
