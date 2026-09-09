import { describe, expect, it } from "vitest";
import {
  assignmentRows,
  configFromAssignmentRows,
} from "../src/assignments";
import { builtInKinds, defaultConfig } from "../src/kind-registry";

const legacyDefaults: Record<string, unknown> = {
  manual: {},
  schedule: { everyMs: 60_000 },
  incoming_message: {},
  call_tool: { input: { text: "Hello from a graph" }, toolId: "tools.echo" },
  invoke_agent: {
    personaId: "system/general",
    prompt: "Complete this graph step.",
  },
  delay: { ms: 1_000 },
  set_variable: { name: "value", value: "" },
  invoke_prompt: { prompt: "Summarize the graph input." },
  feedback_gate: { form: "confirm", prompt: "Continue this graph?" },
  branch: { condition: "$vars.value" },
  for_each: {
    itemVariable: "item",
    items: "$input.items",
    collect: "$vars.item",
    resultVariable: "items",
  },
  end: { output: "$vars.result" },
};

describe("kind registry", () => {
  it("keeps defaultConfig equal to the previous designer seeds", () => {
    for (const kind of builtInKinds) {
      expect(defaultConfig(kind.kind)).toEqual(legacyDefaults[kind.kind]);
    }
  });

  it("writes one assignment as name/value and many as a values map", () => {
    expect(
      configFromAssignmentRows([{ name: "result", value: "Ready" }]),
    ).toEqual({ name: "result", value: "Ready" });
    expect(
      configFromAssignmentRows([
        { name: "a", value: "1" },
        { name: "b", value: "two" },
      ]),
    ).toEqual({ values: { a: 1, b: "two" } });
    expect(
      assignmentRows({ values: { a: 1, b: "two" } }),
    ).toEqual([
      { name: "a", value: "1" },
      { name: "b", value: "two" },
    ]);
  });
});
