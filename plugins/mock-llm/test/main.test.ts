import type {
  LlmProviderContribution,
  ProviderDispatchPermit,
} from "@borg/plugin-sdk";
import { describe, expect, it } from "vitest";
import mockLlm from "../src/main";
import { mockTranscriptFixtures } from "../src/transcripts";

function createOneShotDispatchPermit(events: string[]): ProviderDispatchPermit {
  let committed = false;
  return {
    async commit() {
      if (committed) {
        throw new Error("Dispatch permit already committed");
      }
      committed = true;
      events.push("commit");
    },
  };
}

describe("mock-llm MCP fixture gating", () => {
  it("emits a fixture tool call only when that tool is advertised", async () => {
    const fixture = mockTranscriptFixtures.find((entry) => entry.id === "mcp-echo");
    expect(fixture?.prompt).toBe("scenario:mcp");
    const provider = {
      complete: undefined as LlmProviderContribution["complete"] | undefined,
    };
    mockLlm.activate({
      models: {
        registerProvider: (registered: {
          complete: LlmProviderContribution["complete"];
        }) => {
          provider.complete = registered.complete;
          return { dispose: () => undefined };
        },
      },
    } as never);
    const complete = provider.complete;
    if (!complete) {
      throw new Error("mock provider was not registered");
    }
    const missingEvents: string[] = [];
    const missing = await complete(
      {
        modelId: "mock:scripted",
        messages: [{ role: "user", content: "scenario:mcp" }],
        tools: [],
      },
      createOneShotDispatchPermit(missingEvents),
      new AbortController().signal,
      () => {
        missingEvents.push("stream");
      },
    );
    missingEvents.push("return");
    expect(missingEvents[0]).toBe("commit");
    expect(missingEvents).toContain("stream");
    expect(missingEvents.at(-1)).toBe("return");
    expect(missing.toolCalls).toBeUndefined();
    expect(missing.content).toContain("scenario:mcp");

    const presentEvents: string[] = [];
    const present = await complete(
      {
        modelId: "mock:scripted",
        messages: [{ role: "user", content: "scenario:mcp" }],
        tools: [
          {
            id: "mcp.mock.echo",
            description: "echo",
            inputSchema: { type: "object" },
          },
        ],
      },
      createOneShotDispatchPermit(presentEvents),
      new AbortController().signal,
    );
    presentEvents.push("return");
    expect(presentEvents).toEqual(["commit", "return"]);
    expect(present.toolCalls?.[0]?.name).toBe("mcp.mock.echo");
  });
});
