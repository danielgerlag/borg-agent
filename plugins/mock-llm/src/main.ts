import { definePlugin } from "@borg/plugin-sdk";
import {
  mockTranscriptFixtures,
  type MockTranscriptFixture,
} from "./transcripts";

function readFixtureResult(
  fixture: MockTranscriptFixture,
  candidate: unknown,
): string {
  let value = candidate;
  for (const segment of fixture.resultPath) {
    if (!value || typeof value !== "object") {
      throw new Error(`Mock fixture ${fixture.id} received an invalid tool result`);
    }
    value = (value as Record<string, unknown>)[segment];
  }
  return typeof value === "string" ? value : String(value ?? "");
}

export default definePlugin({
  id: "borg.mock-llm",
  version: "0.1.0",
  engines: {
    borg: "^0.1.0",
  },
  permissions: ["models.register", "loops.start", "tools.invoke", "ui.workspace"],
  contributes: {
    kinds: ["llmProvider", "workspaceView"],
  },
  activate(context) {
    context.models.registerProvider({
      id: "borg.mock-llm",
      models: ["mock:scripted"],
      async complete(request, signal) {
        signal.throwIfAborted();
        const first = request.messages[0]?.content ?? "";
        const last = request.messages.at(-1);
        const fixture =
          mockTranscriptFixtures.find(({ prompt }) => prompt === first) ??
          mockTranscriptFixtures[0]!;
        const usage = {
          inputTokens: Math.max(1, Math.ceil(first.length / 4)),
          outputTokens: 8,
          amount: 0.001,
          currency: "USD",
        };

        if (last?.role === "tool") {
          return {
            content: `${fixture.finalPrefix}${readFixtureResult(
              fixture,
              JSON.parse(last.content),
            )}`,
            usage,
          };
        }

        return {
          toolCalls: [fixture.toolCall],
          usage,
        };
      },
    });
  },
});
