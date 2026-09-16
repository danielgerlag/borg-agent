import { describe, expect, it } from "vitest";
import {
  AssistAskGate,
  applyAnswer,
  buildAssistMessages,
  extractJsonValue,
  extractSummary,
  generateAssistedTurn,
  slugGraphId,
} from "../src/assist";
import { GRAPH_ENGINE_ID } from "../src/engine-id";
import { linearDefinition } from "./harness";

const emptyCatalog: {
  readonly kinds: readonly [];
  readonly tools: readonly [];
  readonly personas: readonly [];
} = {
  kinds: [],
  tools: [],
  personas: [],
};

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
    const { turn: result } = await generateAssistedTurn({
      messages: buildAssistMessages({
        prompt: "Echo hello then stop",
        kinds: [
          { kind: "manual", label: "Manual", type: "trigger" },
          { kind: "set_variable", label: "Set variable", type: "task" },
          { kind: "end", label: "End", type: "control" },
        ],
        tools: [{ id: "tools.echo", description: "Echo text" }],
        personas: [{ id: "system/general", name: "General" }],
      }),
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
    expect(result.kind).toBe("graph");
    if (result.kind !== "graph") {
      return;
    }
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

  it("returns a question turn from ask_user JSON", async () => {
    const { turn: result } = await generateAssistedTurn({
      messages: buildAssistMessages({
        prompt: "Build something",
        ...emptyCatalog,
      }),
      ...emptyCatalog,
      complete: async () =>
        `Need a bit more detail.\n\`\`\`json\n${JSON.stringify({
          ask_user: {
            question: "What shape should the graph have?",
            choices: ["Linear", "Branching"],
            allow_freeform: true,
            multi_select: false,
          },
          id: "ignored-graph",
          nodes: [],
        })}\n\`\`\``,
    });
    expect(result.kind).toBe("question");
    if (result.kind !== "question") {
      return;
    }
    expect(result.summary).toContain("Need a bit more detail.");
    expect(result.question.text).toBe("What shape should the graph have?");
    expect(result.question.allowFreeform).toBe(true);
    expect(result.question.multiSelect).toBe(false);
    expect(result.question.choices.map((choice) => choice.label)).toEqual([
      "Linear",
      "Branching",
    ]);
    expect(result.question.choices.map((choice) => choice.id)).toEqual([
      "linear",
      "branching",
    ]);
  });

  it("applies an answer then returns a graph on the next complete", async () => {
    const sample = linearDefinition({ id: "after-question" });
    const messages = buildAssistMessages({
      prompt: "Build a watcher",
      ...emptyCatalog,
    });
    const { turn: questionTurn } = await generateAssistedTurn({
      messages,
      ...emptyCatalog,
      complete: async () =>
        `\`\`\`json\n${JSON.stringify({
          ask_user: {
            question: "Linear or branching?",
            choices: ["Linear"],
          },
        })}\n\`\`\``,
    });
    expect(questionTurn.kind).toBe("question");
    if (questionTurn.kind !== "question") {
      return;
    }
    const firstChoice = questionTurn.question.choices[0];
    expect(firstChoice).toBeDefined();
    if (firstChoice === undefined) {
      return;
    }
    const sessionId = crypto.randomUUID();
    const answered = applyAnswer(
      {
        id: sessionId,
        messages,
        pendingQuestion: questionTurn.question,
      },
      { questionId: questionTurn.question.id, choiceIds: [firstChoice.id] },
    );
    expect(answered.id).toBe(sessionId);
    expect(answered.pendingQuestion).toBeUndefined();
    const { turn: graphTurn } = await generateAssistedTurn({
      messages: answered.messages,
      ...emptyCatalog,
      complete: async () =>
        `Ready.\n\`\`\`json\n${JSON.stringify(sample)}\n\`\`\``,
    });
    expect(graphTurn.kind).toBe("graph");
    if (graphTurn.kind !== "graph") {
      return;
    }
    expect(graphTurn.definition.id).toBe("after-question");
  });

  it("repairs invalid JSON after one validation failure", async () => {
    const sample = linearDefinition({ id: "repaired-graph" });
    let calls = 0;
    const { turn: result } = await generateAssistedTurn({
      messages: buildAssistMessages({
        prompt: "Fix it",
        ...emptyCatalog,
      }),
      ...emptyCatalog,
      complete: async () => {
        calls += 1;
        if (calls === 1) {
          return "```json\n{\"name\":\"broken\"}\n```";
        }
        return `\`\`\`json\n${JSON.stringify(sample)}\n\`\`\``;
      },
    });
    expect(calls).toBe(2);
    expect(result.kind).toBe("graph");
    if (result.kind !== "graph") {
      return;
    }
    expect(result.definition.id).toBe("repaired-graph");
  });

  it("keeps the current graph id when modifying", async () => {
    const current = linearDefinition({ id: "keep-me" });
    const next = { ...current, name: "Keep me updated" };
    const { turn: result } = await generateAssistedTurn({
      messages: buildAssistMessages({
        prompt: "Rename it",
        current,
        ...emptyCatalog,
      }),
      current,
      ...emptyCatalog,
      complete: async (messages) => {
        const user = messages.find((message) => message.role === "user");
        expect(user?.content).toContain("keep-me");
        return `\`\`\`json\n${JSON.stringify({ ...next, id: "ignored-new-id" })}\n\`\`\``;
      },
    });
    expect(result.kind).toBe("graph");
    if (result.kind !== "graph") {
      return;
    }
    expect(result.definition.id).toBe("keep-me");
    expect(result.definition.name).toBe("Keep me updated");
  });

  it("strips unknown keys from model JSON", async () => {
    const sample = linearDefinition({ id: "echo-hello" });
    const { turn: result } = await generateAssistedTurn({
      messages: buildAssistMessages({
        prompt: "Echo hello then stop",
        ...emptyCatalog,
      }),
      ...emptyCatalog,
      complete: async () =>
        `\`\`\`json\n${JSON.stringify({ ...sample, notes: "llm chatter" })}\n\`\`\``,
    });
    expect(result.kind).toBe("graph");
    if (result.kind !== "graph") {
      return;
    }
    expect(result.definition.id).toBe("echo-hello");
    expect(result.definition).not.toHaveProperty("notes");
  });

  it("parks ask_user until answer, then completes", async () => {
    const gate = new AssistAskGate();
    const question = {
      id: crypto.randomUUID(),
      text: "What shape?",
      choices: [{ id: "linear", label: "Linear" }],
      allowFreeform: true,
      multiSelect: false,
    };
    const asked = gate.ask(question);
    const waiting = await gate.wait();
    expect(waiting.kind).toBe("question");
    if (waiting.kind !== "question") {
      return;
    }
    expect(waiting.question.id).toBe(question.id);
    gate.answer(question.id, "Linear");
    await expect(asked).resolves.toBe("Linear");
    gate.complete('{"id":"done"}');
    const done = await gate.wait();
    expect(done).toEqual({ kind: "done", output: '{"id":"done"}' });
  });

  it("rejects applyAnswer for an unknown questionId", () => {
    const session = {
      id: crypto.randomUUID(),
      messages: buildAssistMessages({
        prompt: "Build a graph",
        ...emptyCatalog,
      }),
      pendingQuestion: {
        id: crypto.randomUUID(),
        text: "What shape?",
        choices: [{ id: "linear", label: "Linear" }],
        allowFreeform: true,
        multiSelect: false,
      },
    };
    expect(() =>
      applyAnswer(session, {
        questionId: crypto.randomUUID(),
        text: "nope",
      }),
    ).toThrow(Error);
  });
});
