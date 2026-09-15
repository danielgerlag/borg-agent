import { describe, expect, it } from "vitest";
import {
  extractJsonValue,
  extractSummary,
  generateAssistedGraph,
  slugGraphId,
} from "../src/assist";
import { GRAPH_ENGINE_ID } from "../src/engine-id";
import { linearDefinition } from "./harness";

describe("graph AI assist", () => {
  it("slugs graph ids and extracts fenced JSON", () => {
    expect(slugGraphId("Invoice Watcher")).toBe("invoice-watcher");
    expect(extractJsonValue('Hello\n```json\n{"name":"A"}\n```')).toEqual({
      name: "A",
    });
    expect(extractSummary("Built a watcher.\n```json\n{}\n```")).toBe(
      "Built a watcher.",
    );
  });

  it("builds a valid graph from a model JSON reply", async () => {
    const sample = linearDefinition({ id: "echo-hello" });
    const result = await generateAssistedGraph({
      prompt: "Echo hello then stop",
      kinds: [
        { kind: "manual", label: "Manual", type: "trigger" },
        { kind: "set_variable", label: "Set variable", type: "task" },
        { kind: "end", label: "End", type: "control" },
      ],
      tools: [{ id: "tools.echo", description: "Echo text" }],
      personas: [{ id: "system/general", name: "General" }],
      complete: async () =>
        `Drafted an echo graph.\n\`\`\`json\n${JSON.stringify(sample)}\n\`\`\``,
    });
    expect(result.summary).toContain("Drafted an echo graph.");
    expect(result.definition).toMatchObject({
      id: "echo-hello",
      engineId: GRAPH_ENGINE_ID,
    });
    expect(result.definition.nodes[0]?.designer).toEqual({
      x: 120,
      y: 140,
    });
  });

  it("repairs invalid JSON after one validation failure", async () => {
    const sample = linearDefinition({ id: "repaired-graph" });
    let calls = 0;
    const result = await generateAssistedGraph({
      prompt: "Fix it",
      kinds: [],
      tools: [],
      personas: [],
      complete: async () => {
        calls += 1;
        if (calls === 1) {
          return "```json\n{\"name\":\"broken\"}\n```";
        }
        return `\`\`\`json\n${JSON.stringify(sample)}\n\`\`\``;
      },
    });
    expect(calls).toBe(2);
    expect(result.definition.id).toBe("repaired-graph");
  });

  it("keeps the current graph id when modifying", async () => {
    const current = linearDefinition({ id: "keep-me" });
    const next = { ...current, name: "Keep me updated" };
    const result = await generateAssistedGraph({
      prompt: "Rename it",
      current,
      kinds: [],
      tools: [],
      personas: [],
      complete: async (messages) => {
        const user = messages.find((message) => message.role === "user");
        expect(user?.content).toContain("keep-me");
        return `\`\`\`json\n${JSON.stringify({ ...next, id: "ignored-new-id" })}\n\`\`\``;
      },
    });
    expect(result.definition.id).toBe("keep-me");
    expect(result.definition.name).toBe("Keep me updated");
  });

  it("strips unknown keys from model JSON", async () => {
    const sample = linearDefinition({ id: "echo-hello" });
    const result = await generateAssistedGraph({
      prompt: "Echo hello then stop",
      kinds: [],
      tools: [],
      personas: [],
      complete: async () =>
        `\`\`\`json\n${JSON.stringify({ ...sample, notes: "llm chatter" })}\n\`\`\``,
    });
    expect(result.definition.id).toBe("echo-hello");
    expect(result.definition).not.toHaveProperty("notes");
  });
});
