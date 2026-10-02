import { definePlugin } from "@borg-agent/plugin-sdk";

const usage = { inputTokens: 1, outputTokens: 1 } as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export default definePlugin({
  id: "example.night-desk.model",
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
      id: "example.night-desk.model",
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
                id: "call-page",
                name: "night-desk.page",
                input: { pageId: "p-19" },
              },
            ],
            usage,
          };
        }
        const lastTool = results.at(-1);
        if (!lastTool) {
          throw new Error("Tool result is missing");
        }
        const parsed: unknown = JSON.parse(lastTool.content);
        if (!isRecord(parsed)) {
          throw new Error("Tool result is not an object");
        }
        if (results.length === 1) {
          const host = parsed.host;
          const symptom = parsed.symptom;
          if (typeof host !== "string" || typeof symptom !== "string") {
            throw new Error("Page result host and symptom must be strings");
          }
          await permit.commit();
          return {
            toolCalls: [
              {
                id: "call-mitigate",
                name: "night-desk.mitigate",
                input: { host, symptom },
              },
            ],
            usage,
          };
        }
        if (results.length === 2) {
          const action = parsed.action;
          if (typeof action !== "string") {
            throw new Error("Mitigation result is missing action");
          }
          await permit.commit();
          return {
            content: `Night desk: pager-1 disk 98% full, mitigated by ${action}`,
            usage,
          };
        }
        throw new Error(`Unexpected tool result count ${results.length}`);
      },
    });
  },
});
