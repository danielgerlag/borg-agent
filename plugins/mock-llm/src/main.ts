import { definePlugin, z } from "@borg/plugin-sdk";
import {
  mockTranscriptFixtures,
  type MockTranscriptFixture,
} from "./transcripts";

function readFixtureResult(
  fixture: MockTranscriptFixture,
  candidate: unknown,
): string {
  let value = candidate;
  for (const segment of fixture.resultPath ?? []) {
    if (!value || typeof value !== "object") {
      throw new Error(`Mock fixture ${fixture.id} received an invalid tool result`);
    }
    value = (value as Record<string, unknown>)[segment];
  }
  return typeof value === "string" ? value : String(value ?? "");
}

async function waitForFixture(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (milliseconds <= 0) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function streamContent(
  content: string,
  signal: AbortSignal,
  onToken?: (token: string) => void | Promise<void>,
): Promise<void> {
  if (!onToken) {
    return;
  }
  for (const token of content.match(/\S+\s*/g) ?? [content]) {
    signal.throwIfAborted();
    await onToken(token);
    await waitForFixture(20, signal);
  }
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
      egress: {
        kind: "local",
        capacity: "local-only",
      },
      async complete(request, permit, signal, onToken) {
        signal.throwIfAborted();
        const last = request.messages.at(-1);
        const userPrompt =
          [...request.messages]
            .reverse()
            .find(({ role }) => role === "user")?.content ?? "";
        const fixture = mockTranscriptFixtures.find(
          ({ prompt }) => prompt === userPrompt,
        );
        const usage = {
          inputTokens: Math.max(1, Math.ceil(userPrompt.length / 4)),
          outputTokens: 8,
          amount: 0.001,
          currency: "USD",
        };

        if (last?.role === "tool") {
          if (!fixture?.finalPrefix) {
            throw new Error("Mock tool result has no matching transcript fixture");
          }
          const content = `${fixture.finalPrefix}${readFixtureResult(
              fixture,
              JSON.parse(last.content),
            )}`;
          await permit.commit();
          await streamContent(content, signal, onToken);
          return {
            content,
            usage,
          };
        }

        if (!fixture) {
          const content = `Mock reply: ${userPrompt}`;
          await permit.commit();
          await streamContent(content, signal, onToken);
          return {
            content,
            usage,
          };
        }
        await waitForFixture(fixture.delayMs ?? 0, signal);
        signal.throwIfAborted();
        if (fixture.content !== undefined) {
          await permit.commit();
          await streamContent(fixture.content, signal, onToken);
          return {
            content: fixture.content,
            usage,
          };
        }
        if (!fixture.toolCall) {
          throw new Error(`Mock fixture ${fixture.id} has no response`);
        }
        if (
          fixture.requiresAdvertisedTool &&
          !request.tools.some((tool) => tool.id === fixture.toolCall?.name)
        ) {
          const content = `Mock reply: ${userPrompt}`;
          await permit.commit();
          await streamContent(content, signal, onToken);
          return {
            content,
            usage,
          };
        }
        await permit.commit();
        return {
          toolCalls: [
            {
              ...fixture.toolCall,
              input: z.json().parse(fixture.toolCall.input),
            },
          ],
          usage,
        };
      },
    });
  },
});
