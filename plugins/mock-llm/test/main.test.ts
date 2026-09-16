import type {
  LlmProviderContribution,
  ProviderDispatchPermit,
} from "@borg/plugin-sdk";
import { describe, expect, it } from "vitest";
import mockLlm from "../src/main";
import {
  mockPromptMatchesFixture,
  mockTranscriptFixtures,
} from "../src/transcripts";

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
  it("matches graph assist User request lines without stealing scenario:graph", () => {
    expect(
      mockPromptMatchesFixture("scenario:graph", "scenario:graph"),
    ).toBe(true);
    expect(
      mockPromptMatchesFixture(
        "Authoring rules\n\nUser request:\nscenario:graph-assist-ask",
        "scenario:graph-assist-ask",
      ),
    ).toBe(true);
    expect(
      mockPromptMatchesFixture(
        "Authoring rules\n\nUser request:\nscenario:graph-assist-ask",
        "scenario:graph",
      ),
    ).toBe(false);
  });

  it("emits graphs.ask for a wrapped assist prompt when the tool is advertised", async () => {
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
    const first = await complete(
      {
        modelId: "mock:scripted",
        messages: [
          {
            role: "user",
            content:
              "You are Borg's graph authoring assistant.\n\nUser request:\nscenario:graph-assist-ask",
          },
        ],
        tools: [
          {
            id: "graphs.ask",
            description: "Ask the user",
            inputSchema: { type: "object" },
          },
        ],
      },
      createOneShotDispatchPermit([]),
      new AbortController().signal,
    );
    expect(first.toolCalls?.[0]?.name).toBe("graphs.ask");
    expect(first.toolCalls?.[0]?.input).toMatchObject({
      question: "Linear or branching?",
    });
    const after = await complete(
      {
        modelId: "mock:scripted",
        messages: [
          {
            role: "user",
            content:
              "You are Borg's graph authoring assistant.\n\nUser request:\nscenario:graph-assist-ask",
          },
          {
            role: "tool",
            content: JSON.stringify({ answer: "Linear" }),
            toolCallId: "mock-graph-ask-call",
          },
        ],
        tools: [
          {
            id: "graphs.ask",
            description: "Ask the user",
            inputSchema: { type: "object" },
          },
        ],
      },
      createOneShotDispatchPermit([]),
      new AbortController().signal,
    );
    expect(after.content).toContain("E2E assist echo");
    expect(after.content).toContain("```json");
  });


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
