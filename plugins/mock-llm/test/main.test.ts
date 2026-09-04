import { describe, expect, it } from "vitest";
import mockLlm from "../src/main";
import { mockTranscriptFixtures } from "../src/transcripts";

describe("mock-llm MCP fixture gating", () => {
  it("emits a fixture tool call only when that tool is advertised", async () => {
    const fixture = mockTranscriptFixtures.find((entry) => entry.id === "mcp-echo");
    expect(fixture?.prompt).toBe("scenario:mcp");
    const provider = {
      complete: undefined as
        | ((
            request: {
              modelId: string;
              messages: { role: "user" | "tool"; content: string }[];
              tools: { id: string; description: string; inputSchema: unknown }[];
            },
            signal: AbortSignal,
          ) => Promise<{ toolCalls?: { name: string }[]; content?: string }>)
        | undefined,
    };
    mockLlm.activate({
      models: {
        registerProvider: (registered: {
          complete: typeof provider.complete;
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
    const missing = await complete(
      {
        modelId: "mock:scripted",
        messages: [{ role: "user", content: "scenario:mcp" }],
        tools: [],
      },
      new AbortController().signal,
    );
    expect(missing.toolCalls).toBeUndefined();
    expect(missing.content).toContain("scenario:mcp");

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
      new AbortController().signal,
    );
    expect(present.toolCalls?.[0]?.name).toBe("mcp.mock.echo");
  });
});
