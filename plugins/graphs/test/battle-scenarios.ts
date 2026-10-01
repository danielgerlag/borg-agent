import type { GraphDefinition, GraphNode } from "../src/contract";
import { GRAPH_ENGINE_ID } from "../src/executor";

export type BattleComplexity = "simple" | "medium" | "complex";

export type BattleHook = "none" | "delay" | "feedback-confirm" | "agent";

export interface BattleRunExpect {
  readonly reject?: boolean;
  readonly rejectPattern?: string;
  readonly status?: "completed" | "failed" | "waiting";
  readonly variables?: Record<string, unknown>;
  readonly output?: unknown;
  readonly errorIncludes?: string;
}

export type BattleScenario = {
  readonly id: string;
  readonly family: string;
  readonly complexity: BattleComplexity;
  readonly definition: unknown;
} & (
  | {
      readonly mode: "validate";
      readonly expect: {
        readonly reject: true;
        readonly rejectPattern: string;
      };
    }
  | {
      readonly mode: "run";
      readonly input?: Record<string, unknown>;
      readonly hook?: BattleHook;
      readonly flakyFails?: number;
      readonly expect: BattleRunExpect;
    }
);

type NodeConfig = GraphNode["config"];

function node(
  id: string,
  type: GraphNode["type"],
  kind: string,
  config: NodeConfig = {},
  extra: Partial<GraphNode> = {},
): GraphNode {
  return {
    id,
    type,
    kind,
    config,
    onError: extra.onError ?? { action: "fail" },
    ...(extra.timeoutMs !== undefined ? { timeoutMs: extra.timeoutMs } : {}),
    ...(extra.outputs ? { outputs: extra.outputs } : {}),
    ...(extra.designer ? { designer: extra.designer } : {}),
  };
}

function graph(
  id: string,
  nodes: GraphNode[],
  edges: GraphDefinition["edges"],
  extra: Partial<GraphDefinition> = {},
): GraphDefinition {
  return {
    id,
    name: extra.name ?? id,
    version: extra.version ?? "1.0.0",
    engineId: extra.engineId ?? GRAPH_ENGINE_ID,
    mode: extra.mode ?? "background",
    inputSchema: extra.inputSchema ?? {},
    variablesSchema: extra.variablesSchema ?? {},
    nodes,
    edges,
    ...(extra.output ? { output: extra.output } : {}),
    ...(extra.permissions ? { permissions: extra.permissions } : {}),
    ...(extra.description ? { description: extra.description } : {}),
  };
}

function linear(
  id: string,
  taskKind: string,
  taskConfig: NodeConfig,
  extra: Partial<GraphDefinition> & {
    readonly triggerKind?: string;
    readonly triggerConfig?: NodeConfig;
    readonly endConfig?: NodeConfig;
    readonly onError?: GraphNode["onError"];
    readonly taskType?: GraphNode["type"];
    readonly timeoutMs?: number;
    readonly outputs?: GraphNode["outputs"];
  } = {},
): GraphDefinition {
  return graph(
    id,
    [
      node(
        "start",
        "trigger",
        extra.triggerKind ?? "manual",
        extra.triggerConfig ?? {},
      ),
      node("work", extra.taskType ?? "task", taskKind, taskConfig, {
        ...(extra.onError ? { onError: extra.onError } : {}),
        ...(extra.timeoutMs !== undefined ? { timeoutMs: extra.timeoutMs } : {}),
        ...(extra.outputs ? { outputs: extra.outputs } : {}),
      }),
      node("end", "control", "end", extra.endConfig ?? { output: "$vars.result" }),
    ],
    [
      { id: "e1", source: "start", target: "work" },
      { id: "e2", source: "work", target: "end" },
    ],
    extra,
  );
}

function sequential(
  id: string,
  steps: number,
  startValue: number,
): GraphDefinition {
  const nodes: GraphNode[] = [node("start", "trigger", "manual")];
  const edges: GraphDefinition["edges"] = [];
  let previous = "start";
  for (let index = 0; index < steps; index += 1) {
    const stepId = `s${index}`;
    nodes.push(
      node(stepId, "task", "set_variable", {
        name: "result",
        value: startValue + index,
      }),
    );
    edges.push({
      id: `e${previous}${stepId}`,
      source: previous,
      target: stepId,
    });
    previous = stepId;
  }
  nodes.push(node("end", "control", "end", { output: "$vars.result" }));
  edges.push({ id: `e${previous}end`, source: previous, target: "end" });
  return graph(id, nodes, edges);
}

function fan(id: string, width: number): GraphDefinition {
  const nodes: GraphNode[] = [node("start", "trigger", "manual")];
  const edges: GraphDefinition["edges"] = [];
  for (let index = 0; index < width; index += 1) {
    const arm = `a${index}`;
    nodes.push(
      node(arm, "task", "set_variable", { name: `v${index}`, value: index }),
    );
    edges.push({ id: `es${arm}`, source: "start", target: arm });
    edges.push({ id: `e${arm}end`, source: arm, target: "end" });
  }
  nodes.push(
    node("end", "control", "end", { output: `$vars.v${width - 1}` }),
  );
  return graph(id, nodes, edges);
}

function branchGraph(
  id: string,
  condition: unknown,
  extra: Partial<GraphDefinition> = {},
): GraphDefinition {
  return graph(
    id,
    [
      node("start", "trigger", "manual"),
      node("set", "task", "set_variable", {
        name: "flag",
        value: condition as never,
      }),
      node("gate", "control", "branch", { condition: "$vars.flag" }),
      node("yes", "task", "set_variable", { name: "path", value: "yes" }),
      node("no", "task", "set_variable", { name: "path", value: "no" }),
      node("end", "control", "end", { output: "$vars.path" }),
    ],
    [
      { id: "e1", source: "start", target: "set" },
      { id: "e2", source: "set", target: "gate" },
      { id: "e3", source: "gate", target: "yes", sourceHandle: "true" },
      { id: "e4", source: "gate", target: "no", sourceHandle: "false" },
      { id: "e5", source: "yes", target: "end" },
      { id: "e6", source: "no", target: "end" },
    ],
    extra,
  );
}

function stringifyTemplate(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

const samples: ReadonlyArray<{ key: string; value: unknown }> = [
  { key: "empty", value: "" },
  { key: "hello", value: "hello" },
  { key: "unicode", value: "café 日本語" },
  { key: "newline", value: "a\nb" },
  { key: "zero", value: 0 },
  { key: "neg", value: -7 },
  { key: "float", value: 3.5 },
  { key: "true", value: true },
  { key: "false", value: false },
  { key: "null", value: null },
  { key: "list", value: [1, 2, 3] },
  { key: "obj", value: { a: 1, b: "x" } },
  { key: "nested", value: { a: { b: [true] } } },
  { key: "long", value: "x".repeat(200) },
  { key: "spaces", value: "  trimmed?  " },
  { key: "quote", value: 'say "hi"' },
  { key: "slash", value: "a/b\\c" },
  { key: "tab", value: "a\tb" },
  { key: "big", value: 1_000_000_000_000 },
  { key: "tiny", value: 0.0001 },
];

export function generateBattleScenarios(): readonly BattleScenario[] {
  const scenarios: BattleScenario[] = [];
  const seen = new Set<string>();
  const add = (scenario: BattleScenario): void => {
    if (seen.has(scenario.id)) {
      throw new Error(`Duplicate battle scenario ${scenario.id}`);
    }
    seen.add(scenario.id);
    scenarios.push(scenario);
  };

  for (const sample of samples) {
    add({
      id: `lin-set-${sample.key}`,
      family: "linear-set",
      complexity: "simple",
      mode: "run",
      definition: linear(`lin-set-${sample.key}`, "set_variable", {
        name: "result",
        value: sample.value as never,
      }),
      expect: {
        status: "completed",
        variables: { result: sample.value },
        output: sample.value,
      },
    });
    add({
      id: `lin-input-${sample.key}`,
      family: "input-expr",
      complexity: "simple",
      mode: "run",
      definition: linear(`lin-input-${sample.key}`, "set_variable", {
        name: "result",
        value: "$input.value",
      }),
      input: { value: sample.value },
      expect: {
        status: "completed",
        variables: { result: sample.value },
        output: sample.value,
      },
    });
  }

  for (let index = 0; index < 16; index += 1) {
    const extra = index * 3;
    add({
      id: `lin-map-${index}`,
      family: "values-map",
      complexity: "simple",
      mode: "run",
      definition: linear(
        `lin-map-${index}`,
        "set_variable",
        { values: { result: index, extra } },
        { endConfig: { output: "$vars.extra" } },
      ),
      expect: {
        status: "completed",
        variables: { result: index, extra },
        output: extra,
      },
    });
  }

  for (const sample of samples) {
    add({
      id: `lin-tpl-${sample.key}`,
      family: "template",
      complexity: "medium",
      mode: "run",
      definition: linear(`lin-tpl-${sample.key}`, "set_variable", {
        name: "result",
        value: "pre-{{ $input.value }}-post",
      }),
      input: { value: sample.value },
      expect: {
        status: "completed",
        output: `pre-${stringifyTemplate(sample.value)}-post`,
      },
    });
  }

  add({
    id: "lin-nested-input",
    family: "input-expr",
    complexity: "medium",
    mode: "run",
    definition: linear("lin-nested-input", "set_variable", {
      name: "result",
      value: "$input.user.name",
    }),
    input: { user: { name: "Ada" } },
    expect: { status: "completed", output: "Ada" },
  });
  add({
    id: "lin-array-index",
    family: "input-expr",
    complexity: "medium",
    mode: "run",
    definition: linear("lin-array-index", "set_variable", {
      name: "result",
      value: "$input.items.1",
    }),
    input: { items: ["a", "b", "c"] },
    expect: { status: "completed", output: "b" },
  });
  add({
    id: "lin-array-zero",
    family: "input-expr",
    complexity: "medium",
    mode: "run",
    definition: linear("lin-array-zero", "set_variable", {
      name: "result",
      value: "$input.items.0",
    }),
    input: { items: ["first"] },
    expect: { status: "completed", output: "first" },
  });
  add({
    id: "lin-missing-input",
    family: "input-expr",
    complexity: "medium",
    mode: "run",
    definition: linear("lin-missing-input", "set_variable", {
      name: "result",
      value: "$input.missing",
    }),
    input: {},
    expect: { status: "failed", errorIncludes: "unresolved" },
  });
  add({
    id: "lin-missing-nested",
    family: "input-expr",
    complexity: "medium",
    mode: "run",
    definition: linear("lin-missing-nested", "set_variable", {
      name: "result",
      value: "$input.user.name",
    }),
    input: { user: {} },
    expect: { status: "failed", errorIncludes: "unresolved" },
  });
  add({
    id: "lin-array-oob",
    family: "input-expr",
    complexity: "medium",
    mode: "run",
    definition: linear("lin-array-oob", "set_variable", {
      name: "result",
      value: "$input.items.5",
    }),
    input: { items: ["a"] },
    expect: { status: "failed", errorIncludes: "unresolved" },
  });
  add({
    id: "lin-array-neg",
    family: "input-expr",
    complexity: "medium",
    mode: "run",
    definition: linear("lin-array-neg", "set_variable", {
      name: "result",
      value: "$input.items.-1",
    }),
    input: { items: ["a", "b"] },
    expect: { status: "failed", errorIncludes: "unresolved" },
  });
  add({
    id: "lin-whole-input",
    family: "input-expr",
    complexity: "simple",
    mode: "run",
    definition: linear("lin-whole-input", "set_variable", {
      name: "result",
      value: "$input",
    }),
    input: { keep: true },
    expect: { status: "completed", output: { keep: true } },
  });
  add({
    id: "lin-deep-path",
    family: "input-expr",
    complexity: "medium",
    mode: "run",
    definition: linear("lin-deep-path", "set_variable", {
      name: "result",
      value: "$input.a.b.c.d",
    }),
    input: { a: { b: { c: { d: 9 } } } },
    expect: { status: "completed", output: 9 },
  });
  add({
    id: "lin-null-field",
    family: "input-expr",
    complexity: "medium",
    mode: "run",
    definition: linear("lin-null-field", "set_variable", {
      name: "result",
      value: "$input.value",
    }),
    input: { value: null },
    expect: { status: "completed", output: null },
  });
  add({
    id: "lin-object-expr",
    family: "input-expr",
    complexity: "medium",
    mode: "run",
    definition: linear("lin-object-expr", "set_variable", {
      name: "result",
      value: { left: "$input.a", right: "$input.b" },
    }),
    input: { a: 1, b: "z" },
    expect: { status: "completed", output: { left: 1, right: "z" } },
  });
  add({
    id: "lin-array-expr",
    family: "input-expr",
    complexity: "medium",
    mode: "run",
    definition: linear("lin-array-expr", "set_variable", {
      name: "result",
      value: ["$input.a", "$input.b"],
    }),
    input: { a: "x", b: "y" },
    expect: { status: "completed", output: ["x", "y"] },
  });
  add({
    id: "tpl-two",
    family: "template",
    complexity: "medium",
    mode: "run",
    definition: linear("tpl-two", "set_variable", {
      name: "result",
      value: "{{ $input.a }}-{{ $input.b }}",
    }),
    input: { a: "left", b: 2 },
    expect: { status: "completed", output: "left-2" },
  });
  add({
    id: "tpl-whole-input",
    family: "template",
    complexity: "medium",
    mode: "run",
    definition: linear("tpl-whole-input", "set_variable", {
      name: "result",
      value: "in={{ $input }}",
    }),
    input: { n: 1 },
    expect: { status: "completed", output: 'in={"n":1}' },
  });
  add({
    id: "tpl-unresolved",
    family: "template",
    complexity: "medium",
    mode: "run",
    definition: linear("tpl-unresolved", "set_variable", {
      name: "result",
      value: "x={{ $input.missing }}",
    }),
    input: {},
    expect: { status: "failed", errorIncludes: "unresolved" },
  });
  add({
    id: "lin-steps-ref",
    family: "steps-expr",
    complexity: "medium",
    mode: "run",
    definition: linear(
      "lin-steps-ref",
      "set_variable",
      { name: "result", value: "from-step" },
      { endConfig: { output: "$steps.work.value" } },
    ),
    expect: { status: "completed", output: "from-step" },
  });
  add({
    id: "lin-steps-name",
    family: "steps-expr",
    complexity: "medium",
    mode: "run",
    definition: linear(
      "lin-steps-name",
      "set_variable",
      { name: "result", value: 3 },
      { endConfig: { output: "$steps.work.name" } },
    ),
    expect: { status: "completed", output: "result" },
  });
  add({
    id: "lin-steps-missing",
    family: "steps-expr",
    complexity: "medium",
    mode: "run",
    definition: linear(
      "lin-steps-missing",
      "set_variable",
      { name: "result", value: 1 },
      { endConfig: { output: "$steps.ghost" } },
    ),
    expect: { status: "failed", errorIncludes: "unresolved" },
  });
  add({
    id: "lin-vars-missing",
    family: "steps-expr",
    complexity: "medium",
    mode: "run",
    definition: linear(
      "lin-vars-missing",
      "set_variable",
      { name: "other", value: 1 },
      { endConfig: { output: "$vars.result" } },
    ),
    expect: { status: "failed", errorIncludes: "unresolved" },
  });
  add({
    id: "pass-direct",
    family: "pass-through",
    complexity: "simple",
    mode: "run",
    definition: graph(
      "pass-direct",
      [
        node("start", "trigger", "manual"),
        node("end", "control", "end", { output: "ok" }),
      ],
      [{ id: "e1", source: "start", target: "end" }],
    ),
    expect: { status: "completed", output: "ok" },
  });
  add({
    id: "pass-input",
    family: "pass-through",
    complexity: "simple",
    mode: "run",
    definition: graph(
      "pass-input",
      [
        node("start", "trigger", "manual"),
        node("end", "control", "end", { output: "$input.n" }),
      ],
      [{ id: "e1", source: "start", target: "end" }],
    ),
    input: { n: 42 },
    expect: { status: "completed", output: 42 },
  });
  add({
    id: "out-node-map",
    family: "output-map",
    complexity: "medium",
    mode: "run",
    definition: linear(
      "out-node-map",
      "set_variable",
      { name: "result", value: "raw" },
      {
        outputs: { alias: "$steps.work.value" },
        endConfig: { output: "$steps.work.alias" },
      },
    ),
    expect: { status: "completed", output: "raw" },
  });
  add({
    id: "out-graph-map",
    family: "output-map",
    complexity: "medium",
    mode: "run",
    definition: linear(
      "out-graph-map",
      "set_variable",
      { name: "result", value: 8 },
      {
        endConfig: {},
        output: { wrapped: "$vars.result" },
      },
    ),
    expect: { status: "completed", output: { wrapped: 8 } },
  });
  add({
    id: "out-end-wins",
    family: "output-map",
    complexity: "medium",
    mode: "run",
    definition: linear(
      "out-end-wins",
      "set_variable",
      { name: "result", value: 1 },
      {
        endConfig: { output: "from-end" },
        output: { wrapped: "$vars.result" },
      },
    ),
    expect: { status: "completed", output: "from-end" },
  });
  add({
    id: "alias-variable",
    family: "aliases",
    complexity: "simple",
    mode: "run",
    definition: linear("alias-variable", "set_variable", {
      variable: "result",
      value: "via-variable",
    }),
    expect: { status: "completed", output: "via-variable" },
  });
  add({
    id: "alias-variables-map",
    family: "aliases",
    complexity: "simple",
    mode: "run",
    definition: linear("alias-variables-map", "set_variable", {
      variables: { result: "via-variables" },
    }),
    expect: { status: "completed", output: "via-variables" },
  });
  add({
    id: "alias-tool-arguments",
    family: "aliases",
    complexity: "medium",
    mode: "run",
    definition: linear(
      "alias-tool-arguments",
      "call_tool",
      { toolId: "tools.echo", arguments: { text: "args" } },
      { endConfig: { output: "$steps.work.echoed" }, permissions: ["*"] },
    ),
    expect: { status: "completed", output: "args" },
  });

  const reject = (
    id: string,
    definition: unknown,
    pattern: string,
    complexity: BattleComplexity = "simple",
  ): void => {
    add({
      id,
      family: "validate",
      complexity,
      mode: "validate",
      definition,
      expect: { reject: true, rejectPattern: pattern },
    });
  };

  reject(
    "val-no-trigger",
    graph(
      "val-no-trigger",
      [
        node("work", "task", "set_variable", { name: "result", value: 1 }),
        node("end", "control", "end", {}),
      ],
      [{ id: "e1", source: "work", target: "end" }],
    ),
    "exactly one trigger",
  );
  reject(
    "val-no-end",
    graph(
      "val-no-end",
      [
        node("start", "trigger", "manual"),
        node("work", "task", "set_variable", { name: "result", value: 1 }),
      ],
      [{ id: "e1", source: "start", target: "work" }],
    ),
    "exactly one end",
  );
  reject(
    "val-two-end",
    graph(
      "val-two-end",
      [
        node("start", "trigger", "manual"),
        node("end1", "control", "end"),
        node("end2", "control", "end"),
      ],
      [
        { id: "e1", source: "start", target: "end1" },
        { id: "e2", source: "start", target: "end2" },
      ],
    ),
    "exactly one end",
  );
  reject(
    "val-two-triggers",
    graph(
      "val-two-triggers",
      [
        node("start", "trigger", "manual"),
        node("also", "trigger", "manual"),
        node("end", "control", "end"),
      ],
      [
        { id: "e1", source: "start", target: "end" },
        { id: "e2", source: "also", target: "end" },
      ],
    ),
    "exactly one trigger",
  );
  reject(
    "val-bad-engine",
    linear("val-bad-engine", "set_variable", { name: "result", value: 1 }, {
      engineId: "other-engine",
    }),
    "unavailable engine",
  );
  reject(
    "val-bad-kind",
    linear("val-bad-kind", "langgraph_node", {}),
    "invalid task kind",
  );
  reject(
    "val-branch-as-task",
    linear("val-branch-as-task", "branch", { condition: true }),
    "invalid task kind",
  );
  reject(
    "val-set-as-control",
    linear(
      "val-set-as-control",
      "set_variable",
      { name: "result", value: 1 },
      { taskType: "control" },
    ),
    "invalid control kind",
  );
  reject(
    "val-incoming-empty",
    linear("val-incoming-empty", "set_variable", { name: "result", value: 1 }, {
      triggerKind: "incoming_message",
      triggerConfig: {},
    }),
    "channel binding",
  );
  reject(
    "val-incoming-blank",
    linear("val-incoming-blank", "set_variable", { name: "result", value: 1 }, {
      triggerKind: "incoming_message",
      triggerConfig: { channelId: "   " },
    }),
    "invalid channelId",
  );
  reject(
    "val-schedule-low",
    linear("val-schedule-low", "set_variable", { name: "result", value: 1 }, {
      triggerKind: "schedule",
      triggerConfig: { everyMs: 10 },
    }),
    "everyMs",
  );
  reject(
    "val-tool-missing",
    linear("val-tool-missing", "call_tool", { input: {} }),
    "Tool ID",
  );
  reject(
    "val-delay-neg",
    linear("val-delay-neg", "delay", { ms: -1 }),
    "durationMs",
  );
  reject(
    "val-delay-float",
    linear("val-delay-float", "delay", { ms: 1.5 }),
    "durationMs",
  );
  reject(
    "val-delay-numeric-string",
    linear("val-delay-numeric-string", "delay", { ms: "1000" }),
    "durationMs",
  );
  reject(
    "val-branch-no-cond",
    graph(
      "val-branch-no-cond",
      [
        node("start", "trigger", "manual"),
        node("gate", "control", "branch", {}),
        node("end", "control", "end"),
      ],
      [
        { id: "e1", source: "start", target: "gate" },
        { id: "e2", source: "gate", target: "end", sourceHandle: "true" },
      ],
    ),
    "condition",
  );
  reject(
    "val-foreach-no-items",
    linear("val-foreach-no-items", "for_each", { itemVariable: "item" }, {
      taskType: "control",
    }),
    "items",
  );
  reject(
    "val-foreach-no-itemvar",
    linear("val-foreach-no-itemvar", "for_each", { items: [] }, {
      taskType: "control",
    }),
    "Item variable",
  );
  reject(
    "val-foreach-as-task",
    linear("val-foreach-as-task", "for_each", {
      items: [],
      itemVariable: "item",
    }),
    "invalid task kind",
  );
  reject(
    "val-end-outgoing",
    graph(
      "val-end-outgoing",
      [
        node("start", "trigger", "manual"),
        node("end", "control", "end"),
        node("after", "task", "set_variable", { name: "result", value: 1 }),
      ],
      [
        { id: "e1", source: "start", target: "end" },
        { id: "e2", source: "end", target: "after" },
      ],
    ),
    "cannot have outgoing",
  );
  reject(
    "val-trigger-incoming",
    graph(
      "val-trigger-incoming",
      [
        node("start", "trigger", "manual"),
        node("work", "task", "set_variable", { name: "result", value: 1 }),
        node("end", "control", "end"),
      ],
      [
        { id: "e1", source: "work", target: "start" },
        { id: "e2", source: "start", target: "end" },
      ],
    ),
    "incoming",
  );
  reject(
    "val-no-outgoing-work",
    graph(
      "val-no-outgoing-work",
      [
        node("start", "trigger", "manual"),
        node("work", "task", "set_variable", { name: "result", value: 1 }),
        node("end", "control", "end"),
      ],
      [{ id: "e1", source: "start", target: "end" }],
    ),
    "no incoming edge",
  );
  const unreachableBase = linear("val-orphan", "set_variable", {
    name: "result",
    value: 1,
  });
  reject(
    "val-orphan",
    {
      ...unreachableBase,
      nodes: [
        ...unreachableBase.nodes,
        node("orphan", "task", "set_variable", { name: "x", value: 1 }),
      ],
      edges: [
        ...unreachableBase.edges,
        { id: "loop", source: "orphan", target: "orphan" },
      ],
    },
    "unreachable",
  );
  const cyclicBase = linear("val-cycle", "set_variable", {
    name: "result",
    value: 1,
  });
  reject(
    "val-cycle",
    {
      ...cyclicBase,
      nodes: [
        cyclicBase.nodes[0]!,
        cyclicBase.nodes[1]!,
        node("loop", "task", "set_variable", { name: "looped", value: true }),
        cyclicBase.nodes[2]!,
      ],
      edges: [
        { id: "e1", source: "start", target: "work" },
        { id: "e2", source: "work", target: "loop" },
        { id: "e3", source: "loop", target: "work" },
        { id: "e4", source: "loop", target: "end" },
      ],
    },
    "cycle",
  );
  reject(
    "val-dead-end",
    graph(
      "val-dead-end",
      [
        node("start", "trigger", "manual"),
        node("work", "task", "set_variable", { name: "result", value: 1 }),
        node("dead", "task", "set_variable", { name: "lost", value: 1 }),
        node("sink", "task", "set_variable", { name: "sink", value: 1 }),
        node("end", "control", "end"),
      ],
      [
        { id: "e1", source: "start", target: "work" },
        { id: "e2", source: "work", target: "end" },
        { id: "e3", source: "start", target: "dead" },
        { id: "e4", source: "dead", target: "sink" },
        { id: "e5", source: "sink", target: "dead" },
      ],
    ),
    "cannot reach end",
  );
  reject(
    "val-bad-handle",
    graph(
      "val-bad-handle",
      [
        node("start", "trigger", "manual"),
        node("gate", "control", "branch", { condition: true }),
        node("end", "control", "end"),
      ],
      [
        { id: "e1", source: "start", target: "gate" },
        { id: "e2", source: "gate", target: "end", sourceHandle: "maybe" },
      ],
    ),
    "sourceHandle",
  );
  reject(
    "val-goto-unknown",
    linear("val-goto-unknown", "set_variable", { name: "result", value: 1 }, {
      onError: { action: "goto", nodeId: "nowhere" },
    }),
    "unknown goto",
  );
  reject(
    "val-choice-no-choices",
    linear("val-choice-no-choices", "feedback_gate", {
      prompt: "Pick",
      form: "choice",
    }),
    "choices",
  );
  reject(
    "val-agent-no-prompt",
    linear("val-agent-no-prompt", "invoke_agent", {
      personaId: "system/general",
    }),
    "Agent prompt",
  );
  reject(
    "val-prompt-empty",
    linear("val-prompt-empty", "invoke_prompt", { prompt: "   " }),
    "Prompt",
  );
  reject(
    "val-feedback-no-prompt",
    linear("val-feedback-no-prompt", "feedback_gate", { form: "confirm" }),
    "Feedback prompt",
  );
  reject(
    "val-feedback-bad-form",
    linear("val-feedback-bad-form", "feedback_gate", {
      prompt: "Go?",
      form: "slider",
    }),
    "Feedback form",
  );
  reject(
    "val-set-no-value",
    linear("val-set-no-value", "set_variable", { name: "result" }),
    "Variable value",
  );
  reject(
    "val-set-no-name",
    linear("val-set-no-name", "set_variable", { value: 1 }),
    "Variable name",
  );
  reject(
    "val-set-bad-map",
    linear("val-set-bad-map", "set_variable", { values: 1 as never }),
    "must be an object",
  );
  reject(
    "val-dup-node",
    {
      ...linear("val-dup-node", "set_variable", { name: "result", value: 1 }),
      nodes: [
        node("start", "trigger", "manual"),
        node("work", "task", "set_variable", { name: "result", value: 1 }),
        node("work", "task", "set_variable", { name: "other", value: 2 }),
        node("end", "control", "end"),
      ],
    },
    "Duplicate graph node",
  );
  reject(
    "val-dup-edge",
    {
      ...linear("val-dup-edge", "set_variable", { name: "result", value: 1 }),
      edges: [
        { id: "e1", source: "start", target: "work" },
        { id: "e1", source: "work", target: "end" },
      ],
    },
    "Duplicate graph edge",
  );
  reject(
    "val-unknown-edge",
    {
      ...linear("val-unknown-edge", "set_variable", { name: "result", value: 1 }),
      edges: [
        { id: "e1", source: "start", target: "ghost" },
        { id: "e2", source: "work", target: "end" },
      ],
    },
    "unknown node",
  );
  reject(
    "val-bad-graph-id",
    linear("Bad_Id", "set_variable", { name: "result", value: 1 }),
    "Invalid",
  );
  reject(
    "val-bad-node-id",
    {
      ...linear("val-bad-node-id", "set_variable", { name: "result", value: 1 }),
      nodes: [
        node("start", "trigger", "manual"),
        node("bad id", "task", "set_variable", { name: "result", value: 1 }),
        node("end", "control", "end"),
      ],
    },
    "Invalid",
  );
  reject(
    "val-bad-version",
    linear("val-bad-version", "set_variable", { name: "result", value: 1 }, {
      version: "1",
    }),
    "Invalid",
  );
  reject(
    "val-timeout-zero",
    linear("val-timeout-zero", "set_variable", { name: "result", value: 1 }, {
      timeoutMs: 0,
    }),
    "too_small",
  );
  reject(
    "val-retry-one",
    linear("val-retry-one", "set_variable", { name: "result", value: 1 }, {
      onError: { action: "retry", maxAttempts: 1 },
    }),
    "too_small",
  );
  reject(
    "val-empty-name",
    linear("val-empty-name", "set_variable", { name: "result", value: 1 }, {
      name: "   ",
    }),
    "too_small",
  );
  reject(
    "val-goto-trigger",
    linear("val-goto-trigger", "set_variable", { name: "result", value: 1 }, {
      onError: { action: "goto", nodeId: "start" },
    }),
    "cannot goto trigger",
  );

  for (const everyMs of [0, 1, 999, 1000.5, "60000", null, -1000]) {
    const key = `val-sched-${String(everyMs).replaceAll(".", "p").toLowerCase()}`;
    reject(
      key,
      linear(key, "set_variable", { name: "result", value: 1 }, {
        triggerKind: "schedule",
        triggerConfig: { everyMs: everyMs as never },
      }),
      "everyMs",
    );
  }

  const truth: ReadonlyArray<{ key: string; value: unknown; pass: boolean }> = [
    { key: "bool-true", value: true, pass: true },
    { key: "bool-false", value: false, pass: false },
    { key: "one", value: 1, pass: true },
    { key: "zero", value: 0, pass: false },
    { key: "hello", value: "hello", pass: true },
    { key: "empty", value: "", pass: false },
    { key: "str-false", value: "false", pass: true },
    { key: "null", value: null, pass: false },
    { key: "list", value: [1], pass: true },
    { key: "empty-list", value: [], pass: true },
    { key: "obj", value: { a: 1 }, pass: true },
    { key: "neg", value: -1, pass: true },
  ];
  for (const item of truth) {
    add({
      id: `br-${item.key}`,
      family: "branch",
      complexity: "medium",
      mode: "run",
      definition: branchGraph(`br-${item.key}`, item.value),
      expect: { status: "completed", output: item.pass ? "yes" : "no" },
    });
  }
  add({
    id: "br-literal-true",
    family: "branch",
    complexity: "simple",
    mode: "run",
    definition: graph(
      "br-literal-true",
      [
        node("start", "trigger", "manual"),
        node("gate", "control", "branch", { condition: true }),
        node("yes", "task", "set_variable", { name: "result", value: "yes" }),
        node("end", "control", "end", { output: "$vars.result" }),
      ],
      [
        { id: "e1", source: "start", target: "gate" },
        { id: "e2", source: "gate", target: "yes", sourceHandle: "true" },
        { id: "e3", source: "yes", target: "end" },
      ],
    ),
    expect: { status: "completed", output: "yes" },
  });
  add({
    id: "br-unhandled-false",
    family: "branch",
    complexity: "medium",
    mode: "run",
    definition: graph(
      "br-unhandled-false",
      [
        node("start", "trigger", "manual"),
        node("gate", "control", "branch", { condition: false }),
        node("yes", "task", "set_variable", { name: "result", value: "yes" }),
        node("end", "control", "end", { output: "$vars.result" }),
      ],
      [
        { id: "e1", source: "start", target: "gate" },
        { id: "e2", source: "gate", target: "yes", sourceHandle: "true" },
        { id: "e3", source: "yes", target: "end" },
      ],
    ),
    expect: { status: "failed", errorIncludes: "no executable path" },
  });
  add({
    id: "br-no-handle",
    family: "branch",
    complexity: "medium",
    mode: "run",
    definition: graph(
      "br-no-handle",
      [
        node("start", "trigger", "manual"),
        node("gate", "control", "branch", { condition: false }),
        node("next", "task", "set_variable", { name: "result", value: "ran" }),
        node("end", "control", "end", { output: "$vars.result" }),
      ],
      [
        { id: "e1", source: "start", target: "gate" },
        { id: "e2", source: "gate", target: "next" },
        { id: "e3", source: "next", target: "end" },
      ],
    ),
    expect: { status: "completed", output: "ran" },
  });
  add({
    id: "br-input",
    family: "branch",
    complexity: "medium",
    mode: "run",
    definition: graph(
      "br-input",
      [
        node("start", "trigger", "manual"),
        node("gate", "control", "branch", { condition: "$input.go" }),
        node("yes", "task", "set_variable", { name: "path", value: "yes" }),
        node("no", "task", "set_variable", { name: "path", value: "no" }),
        node("end", "control", "end", { output: "$vars.path" }),
      ],
      [
        { id: "e1", source: "start", target: "gate" },
        { id: "e2", source: "gate", target: "yes", sourceHandle: "true" },
        { id: "e3", source: "gate", target: "no", sourceHandle: "false" },
        { id: "e4", source: "yes", target: "end" },
        { id: "e5", source: "no", target: "end" },
      ],
    ),
    input: { go: false },
    expect: { status: "completed", output: "no" },
  });
  add({
    id: "br-skip-steps",
    family: "branch",
    complexity: "complex",
    mode: "run",
    definition: graph(
      "br-skip-steps",
      [
        node("start", "trigger", "manual"),
        node("gate", "control", "branch", { condition: true }),
        node("yes", "task", "set_variable", { name: "path", value: "yes" }),
        node("no", "task", "set_variable", { name: "path", value: "no" }),
        node("end", "control", "end", { output: "$steps.no.value" }),
      ],
      [
        { id: "e1", source: "start", target: "gate" },
        { id: "e2", source: "gate", target: "yes", sourceHandle: "true" },
        { id: "e3", source: "gate", target: "no", sourceHandle: "false" },
        { id: "e4", source: "yes", target: "end" },
        { id: "e5", source: "no", target: "end" },
      ],
    ),
    expect: { status: "failed", errorIncludes: "unresolved" },
  });
  add({
    id: "br-nested",
    family: "branch",
    complexity: "complex",
    mode: "run",
    definition: graph(
      "br-nested",
      [
        node("start", "trigger", "manual"),
        node("outer", "control", "branch", { condition: "$input.outer" }),
        node("inner", "control", "branch", { condition: "$input.inner" }),
        node("a", "task", "set_variable", { name: "path", value: "a" }),
        node("b", "task", "set_variable", { name: "path", value: "b" }),
        node("c", "task", "set_variable", { name: "path", value: "c" }),
        node("end", "control", "end", { output: "$vars.path" }),
      ],
      [
        { id: "e1", source: "start", target: "outer" },
        { id: "e2", source: "outer", target: "inner", sourceHandle: "true" },
        { id: "e3", source: "outer", target: "c", sourceHandle: "false" },
        { id: "e4", source: "inner", target: "a", sourceHandle: "true" },
        { id: "e5", source: "inner", target: "b", sourceHandle: "false" },
        { id: "e6", source: "a", target: "end" },
        { id: "e7", source: "b", target: "end" },
        { id: "e8", source: "c", target: "end" },
      ],
    ),
    input: { outer: true, inner: false },
    expect: { status: "completed", output: "b" },
  });

  const lists = [
    [],
    ["a"],
    ["a", "b", "c"],
    [1, 2, 3, 4, 5],
    [{ n: 1 }, { n: 2 }],
    [true, false],
    ["", "x"],
    [null, 0],
    ["one", "two", "three", "four", "five", "six"],
  ] as const;
  for (const [index, items] of lists.entries()) {
    add({
      id: `fe-${index}`,
      family: "for-each",
      complexity: "medium",
      mode: "run",
      definition: linear(
        `fe-${index}`,
        "for_each",
        {
          items: "$input.items",
          itemVariable: "item",
          collect: "$vars.item",
          resultVariable: "result",
        },
        { taskType: "control", endConfig: { output: "$vars.result" } },
      ),
      input: { items: [...items] },
      expect: { status: "completed", output: [...items] },
    });
  }
  add({
    id: "fe-collect-field",
    family: "for-each",
    complexity: "complex",
    mode: "run",
    definition: linear(
      "fe-collect-field",
      "for_each",
      {
        items: "$input.items",
        itemVariable: "item",
        collect: "$vars.item.n",
        resultVariable: "result",
      },
      { taskType: "control", endConfig: { output: "$vars.result" } },
    ),
    input: { items: [{ n: 10 }, { n: 20 }] },
    expect: { status: "completed", output: [10, 20] },
  });
  add({
    id: "fe-collect-missing",
    family: "for-each",
    complexity: "complex",
    mode: "run",
    definition: linear(
      "fe-collect-missing",
      "for_each",
      {
        items: "$input.items",
        itemVariable: "item",
        collect: "$vars.item.missing",
        resultVariable: "result",
      },
      { taskType: "control" },
    ),
    input: { items: [{ n: 1 }] },
    expect: { status: "failed", errorIncludes: "unresolved" },
  });
  add({
    id: "fe-literal-items",
    family: "for-each",
    complexity: "medium",
    mode: "run",
    definition: linear(
      "fe-literal-items",
      "for_each",
      {
        items: ["p", "q"],
        itemVariable: "item",
        collect: "$vars.item",
        resultVariable: "result",
      },
      { taskType: "control", endConfig: { output: "$vars.result" } },
    ),
    expect: { status: "completed", output: ["p", "q"] },
  });
  add({
    id: "fe-not-array",
    family: "for-each",
    complexity: "medium",
    mode: "run",
    definition: linear(
      "fe-not-array",
      "for_each",
      {
        items: "$input.items",
        itemVariable: "item",
        resultVariable: "result",
      },
      { taskType: "control" },
    ),
    input: { items: "nope" },
    expect: { status: "failed", errorIncludes: "array" },
  });
  add({
    id: "fe-no-collect",
    family: "for-each",
    complexity: "medium",
    mode: "run",
    definition: linear(
      "fe-no-collect",
      "for_each",
      {
        items: "$input.items",
        itemVariable: "item",
        resultVariable: "result",
      },
      { taskType: "control", endConfig: { output: "$vars.result" } },
    ),
    input: { items: [7, 8] },
    expect: { status: "completed", output: [7, 8] },
  });

  for (let width = 2; width <= 8; width += 1) {
    const variables: Record<string, number> = {};
    for (let index = 0; index < width; index += 1) {
      variables[`v${index}`] = index;
    }
    add({
      id: `fan-${width}`,
      family: "parallel",
      complexity: width > 4 ? "complex" : "medium",
      mode: "run",
      definition: fan(`fan-${width}`, width),
      expect: {
        status: "completed",
        variables,
        output: width - 1,
      },
    });
  }
  add({
    id: "par-diamond",
    family: "parallel",
    complexity: "complex",
    mode: "run",
    definition: graph(
      "par-diamond",
      [
        node("start", "trigger", "manual"),
        node("left", "task", "set_variable", { name: "left", value: 1 }),
        node("right", "task", "set_variable", { name: "right", value: 2 }),
        node("end", "control", "end", { output: "$vars.right" }),
      ],
      [
        { id: "e1", source: "start", target: "left" },
        { id: "e2", source: "start", target: "right" },
        { id: "e3", source: "left", target: "end" },
        { id: "e4", source: "right", target: "end" },
      ],
    ),
    expect: {
      status: "completed",
      variables: { left: 1, right: 2 },
      output: 2,
    },
  });

  add({
    id: "tool-echo",
    family: "call-tool",
    complexity: "simple",
    mode: "run",
    definition: linear(
      "tool-echo",
      "call_tool",
      { toolId: "tools.echo", input: { text: "hi" } },
      { endConfig: { output: "$steps.work" }, permissions: ["*"] },
    ),
    expect: { status: "completed", output: { echoed: "hi" } },
  });
  add({
    id: "tool-default-perms",
    family: "call-tool",
    complexity: "simple",
    mode: "run",
    definition: linear(
      "tool-default-perms",
      "call_tool",
      { toolId: "tools.echo", input: { text: "hi" } },
      { endConfig: { output: "$steps.work.echoed" } },
    ),
    expect: { status: "completed", output: "hi" },
  });
  add({
    id: "tool-from-input",
    family: "call-tool",
    complexity: "medium",
    mode: "run",
    definition: linear(
      "tool-from-input",
      "call_tool",
      { toolId: "tools.echo", input: { text: "$input.text" } },
      { endConfig: { output: "$steps.work.echoed" }, permissions: ["*"] },
    ),
    input: { text: "from-input" },
    expect: { status: "completed", output: "from-input" },
  });
  add({
    id: "tool-template",
    family: "call-tool",
    complexity: "medium",
    mode: "run",
    definition: linear(
      "tool-template",
      "call_tool",
      { toolId: "tools.echo", input: { text: "echo-{{ $input.text }}" } },
      { endConfig: { output: "$steps.work.echoed" }, permissions: ["*"] },
    ),
    input: { text: "me" },
    expect: { status: "completed", output: "echo-me" },
  });
  add({
    id: "tool-missing",
    family: "call-tool",
    complexity: "simple",
    mode: "run",
    definition: linear(
      "tool-missing",
      "call_tool",
      { toolId: "tools.missing", input: {} },
      { permissions: ["*"] },
    ),
    expect: { status: "failed", errorIncludes: "unavailable" },
  });
  add({
    id: "tool-empty-input",
    family: "call-tool",
    complexity: "simple",
    mode: "run",
    definition: linear(
      "tool-empty-input",
      "call_tool",
      { toolId: "tools.echo" },
      { endConfig: { output: "$steps.work.echoed" }, permissions: ["*"] },
    ),
    expect: { status: "completed", output: "" },
  });

  add({
    id: "err-skip",
    family: "error-policy",
    complexity: "medium",
    mode: "run",
    definition: linear(
      "err-skip",
      "call_tool",
      { toolId: "tools.missing", input: {} },
      {
        onError: { action: "skip" },
        endConfig: { output: "skipped" },
        permissions: ["*"],
      },
    ),
    expect: { status: "completed", output: "skipped" },
  });
  add({
    id: "err-fail",
    family: "error-policy",
    complexity: "simple",
    mode: "run",
    definition: linear(
      "err-fail",
      "call_tool",
      { toolId: "tools.fail", input: {} },
      { permissions: ["*"] },
    ),
    expect: { status: "failed", errorIncludes: "tool boom" },
  });
  add({
    id: "err-retry-fail",
    family: "error-policy",
    complexity: "medium",
    mode: "run",
    definition: linear(
      "err-retry-fail",
      "call_tool",
      { toolId: "tools.fail", input: {} },
      {
        onError: { action: "retry", maxAttempts: 3 },
        permissions: ["*"],
      },
    ),
    expect: { status: "failed", errorIncludes: "tool boom" },
  });
  add({
    id: "err-retry-flaky",
    family: "error-policy",
    complexity: "complex",
    mode: "run",
    definition: linear(
      "err-retry-flaky",
      "call_tool",
      { toolId: "tools.flaky", input: {} },
      {
        onError: { action: "retry", maxAttempts: 3 },
        endConfig: { output: "$steps.work.ok" },
        permissions: ["*"],
      },
    ),
    flakyFails: 1,
    expect: { status: "completed", output: true },
  });
  add({
    id: "err-retry-too-few",
    family: "error-policy",
    complexity: "complex",
    mode: "run",
    definition: linear(
      "err-retry-too-few",
      "call_tool",
      { toolId: "tools.flaky", input: {} },
      {
        onError: { action: "retry", maxAttempts: 2 },
        permissions: ["*"],
      },
    ),
    flakyFails: 5,
    expect: { status: "failed", errorIncludes: "flaky" },
  });
  add({
    id: "err-goto",
    family: "error-policy",
    complexity: "complex",
    mode: "run",
    definition: graph(
      "err-goto",
      [
        node("start", "trigger", "manual"),
        node(
          "boom",
          "task",
          "call_tool",
          { toolId: "tools.missing", input: {} },
          { onError: { action: "goto", nodeId: "rescue" } },
        ),
        node("rescue", "task", "set_variable", {
          name: "result",
          value: "rescued",
        }),
        node("end", "control", "end", { output: "$vars.result" }),
      ],
      [
        { id: "e1", source: "start", target: "boom" },
        { id: "e2", source: "boom", target: "end" },
        { id: "e3", source: "rescue", target: "end" },
      ],
      { permissions: ["*"] },
    ),
    expect: { status: "completed", output: "rescued" },
  });
  add({
    id: "err-goto-on-path",
    family: "error-policy",
    complexity: "complex",
    mode: "run",
    definition: graph(
      "err-goto-on-path",
      [
        node("start", "trigger", "manual"),
        node(
          "boom",
          "task",
          "call_tool",
          { toolId: "tools.fail", input: {} },
          { onError: { action: "goto", nodeId: "rescue" } },
        ),
        node("rescue", "task", "set_variable", {
          name: "result",
          value: "rescued-on-path",
        }),
        node("end", "control", "end", { output: "$vars.result" }),
      ],
      [
        { id: "e1", source: "start", target: "boom" },
        { id: "e2", source: "boom", target: "rescue" },
        { id: "e3", source: "rescue", target: "end" },
      ],
      { permissions: ["*"] },
    ),
    expect: { status: "completed", output: "rescued-on-path" },
  });
  add({
    id: "err-goto-end",
    family: "error-policy",
    complexity: "complex",
    mode: "run",
    definition: graph(
      "err-goto-end",
      [
        node("start", "trigger", "manual"),
        node(
          "boom",
          "task",
          "call_tool",
          { toolId: "tools.fail", input: {} },
          { onError: { action: "goto", nodeId: "end" } },
        ),
        node("end", "control", "end", { output: "jumped-to-end" }),
      ],
      [
        { id: "e1", source: "start", target: "boom" },
        { id: "e2", source: "boom", target: "end" },
      ],
      { permissions: ["*"] },
    ),
    expect: { status: "completed", output: "jumped-to-end" },
  });
  add({
    id: "err-skip-then-var",
    family: "error-policy",
    complexity: "complex",
    mode: "run",
    definition: graph(
      "err-skip-then-var",
      [
        node("start", "trigger", "manual"),
        node(
          "boom",
          "task",
          "call_tool",
          { toolId: "tools.fail", input: {} },
          { onError: { action: "skip" } },
        ),
        node("after", "task", "set_variable", {
          name: "result",
          value: "after-skip",
        }),
        node("end", "control", "end", { output: "$vars.result" }),
      ],
      [
        { id: "e1", source: "start", target: "boom" },
        { id: "e2", source: "boom", target: "after" },
        { id: "e3", source: "after", target: "end" },
      ],
      { permissions: ["*"] },
    ),
    expect: { status: "completed", output: "after-skip" },
  });

  add({
    id: "delay-zero",
    family: "delay",
    complexity: "medium",
    mode: "run",
    definition: linear("delay-zero", "delay", { ms: 0 }, {
      endConfig: { output: "slept" },
    }),
    hook: "delay",
    expect: { status: "completed", output: "slept" },
  });
  add({
    id: "delay-durationms",
    family: "delay",
    complexity: "medium",
    mode: "run",
    definition: linear("delay-durationms", "delay", { durationMs: 0 }, {
      endConfig: { output: "slept" },
    }),
    hook: "delay",
    expect: { status: "completed", output: "slept" },
  });
  add({
    id: "delay-expr",
    family: "delay",
    complexity: "medium",
    mode: "run",
    definition: linear("delay-expr", "delay", { ms: "$input.ms" }, {
      endConfig: { output: "slept" },
    }),
    input: { ms: 0 },
    hook: "delay",
    expect: { status: "completed", output: "slept" },
  });
  add({
    id: "delay-then-set",
    family: "delay",
    complexity: "complex",
    mode: "run",
    definition: graph(
      "delay-then-set",
      [
        node("start", "trigger", "manual"),
        node("wait", "task", "delay", { ms: 0 }),
        node("after", "task", "set_variable", {
          name: "result",
          value: "awake",
        }),
        node("end", "control", "end", { output: "$vars.result" }),
      ],
      [
        { id: "e1", source: "start", target: "wait" },
        { id: "e2", source: "wait", target: "after" },
        { id: "e3", source: "after", target: "end" },
      ],
    ),
    hook: "delay",
    expect: { status: "completed", output: "awake" },
  });

  add({
    id: "fb-confirm",
    family: "feedback",
    complexity: "medium",
    mode: "run",
    definition: linear(
      "fb-confirm",
      "feedback_gate",
      { prompt: "Go?", form: "confirm" },
      { endConfig: { output: "$steps.work.answer.confirmed" } },
    ),
    hook: "feedback-confirm",
    expect: { status: "completed", output: true },
  });
  add({
    id: "fb-missing-handler",
    family: "feedback",
    complexity: "simple",
    mode: "run",
    definition: linear("fb-missing-handler", "feedback_gate", {
      prompt: "Go?",
      form: "confirm",
    }),
    expect: { status: "failed", errorIncludes: "unavailable" },
  });

  add({
    id: "prompt-basic",
    family: "prompt",
    complexity: "simple",
    mode: "run",
    definition: linear(
      "prompt-basic",
      "invoke_prompt",
      { prompt: "Say hi" },
      { endConfig: { output: "$steps.work.content" } },
    ),
    expect: { status: "completed", output: "model response" },
  });
  add({
    id: "prompt-template",
    family: "prompt",
    complexity: "medium",
    mode: "run",
    definition: linear(
      "prompt-template",
      "invoke_prompt",
      { prompt: "Hello {{ $input.name }}" },
      { endConfig: { output: "$steps.work.content" } },
    ),
    input: { name: "Ada" },
    expect: { status: "completed", output: "model response" },
  });
  add({
    id: "prompt-system",
    family: "prompt",
    complexity: "medium",
    mode: "run",
    definition: linear(
      "prompt-system",
      "invoke_prompt",
      { prompt: "Say hi", system: "Be brief" },
      { endConfig: { output: "$steps.work.modelId" } },
    ),
    expect: { status: "completed", output: "mock:scripted" },
  });
  add({
    id: "prompt-then-branch",
    family: "prompt",
    complexity: "complex",
    mode: "run",
    definition: graph(
      "prompt-then-branch",
      [
        node("start", "trigger", "manual"),
        node("ask", "task", "invoke_prompt", { prompt: "Say hi" }),
        node("gate", "control", "branch", {
          condition: "$steps.ask.content",
        }),
        node("yes", "task", "set_variable", { name: "path", value: "yes" }),
        node("no", "task", "set_variable", { name: "path", value: "no" }),
        node("end", "control", "end", { output: "$vars.path" }),
      ],
      [
        { id: "e1", source: "start", target: "ask" },
        { id: "e2", source: "ask", target: "gate" },
        { id: "e3", source: "gate", target: "yes", sourceHandle: "true" },
        { id: "e4", source: "gate", target: "no", sourceHandle: "false" },
        { id: "e5", source: "yes", target: "end" },
        { id: "e6", source: "no", target: "end" },
      ],
    ),
    expect: { status: "completed", output: "yes" },
  });

  add({
    id: "agent-default",
    family: "agent",
    complexity: "complex",
    mode: "run",
    definition: linear(
      "agent-default",
      "invoke_agent",
      { prompt: "Do work" },
      { endConfig: { output: "$steps.work.output" } },
    ),
    hook: "agent",
    expect: { status: "completed", output: "agent-output" },
  });
  add({
    id: "agent-task-alias",
    family: "agent",
    complexity: "complex",
    mode: "run",
    definition: linear(
      "agent-task-alias",
      "invoke_agent",
      { task: "Do work" },
      { endConfig: { output: "$steps.work.output" } },
    ),
    hook: "agent",
    expect: { status: "completed", output: "agent-output" },
  });
  add({
    id: "agent-missing-persona",
    family: "agent",
    complexity: "medium",
    mode: "run",
    definition: linear("agent-missing-persona", "invoke_agent", {
      prompt: "Do work",
      personaId: "missing",
    }),
    expect: { status: "failed", errorIncludes: "unavailable" },
  });

  add({
    id: "in-msg",
    family: "incoming",
    complexity: "simple",
    mode: "run",
    definition: linear(
      "in-msg",
      "set_variable",
      { name: "result", value: "$input" },
      { triggerKind: "incoming_message", triggerConfig: { channelId: "c1" } },
    ),
    input: { body: "hello" },
    expect: { status: "completed", output: { body: "hello" } },
  });
  for (const binding of ["channelId", "adapterId", "destinationId"] as const) {
    add({
      id: `in-${binding.toLowerCase()}`,
      family: "incoming",
      complexity: "simple",
      mode: "run",
      definition: linear(
        `in-${binding.toLowerCase()}`,
        "set_variable",
        { name: "result", value: "ok" },
        { triggerKind: "incoming_message", triggerConfig: { [binding]: "x" } },
      ),
      expect: { status: "completed", output: "ok" },
    });
  }

  add({
    id: "schema-input-ok",
    family: "schema",
    complexity: "medium",
    mode: "run",
    definition: linear(
      "schema-input-ok",
      "set_variable",
      { name: "result", value: "$input.count" },
      {
        inputSchema: {
          type: "object",
          required: ["count"],
          properties: { count: { type: "number" } },
        },
      },
    ),
    input: { count: 3 },
    expect: { status: "completed", output: 3 },
  });
  add({
    id: "schema-input-bad",
    family: "schema",
    complexity: "medium",
    mode: "run",
    definition: linear(
      "schema-input-bad",
      "set_variable",
      { name: "result", value: 1 },
      {
        inputSchema: {
          type: "object",
          required: ["count"],
          properties: { count: { type: "number" } },
        },
      },
    ),
    input: { count: "nope" },
    expect: { reject: true, rejectPattern: "must be number" },
  });
  add({
    id: "schema-input-missing",
    family: "schema",
    complexity: "medium",
    mode: "run",
    definition: linear(
      "schema-input-missing",
      "set_variable",
      { name: "result", value: 1 },
      {
        inputSchema: {
          type: "object",
          required: ["count"],
          properties: { count: { type: "number" } },
        },
      },
    ),
    input: {},
    expect: { reject: true, rejectPattern: "is required" },
  });
  add({
    id: "schema-additional",
    family: "schema",
    complexity: "medium",
    mode: "run",
    definition: linear(
      "schema-additional",
      "set_variable",
      { name: "result", value: 1 },
      {
        inputSchema: {
          type: "object",
          additionalProperties: false,
        },
      },
    ),
    input: { extra: true },
    expect: { reject: true, rejectPattern: "is not allowed" },
  });
  add({
    id: "schema-enum-ok",
    family: "schema",
    complexity: "medium",
    mode: "run",
    definition: linear(
      "schema-enum-ok",
      "set_variable",
      { name: "result", value: "$input.color" },
      {
        inputSchema: {
          type: "object",
          properties: { color: { enum: ["red", "blue"] } },
        },
      },
    ),
    input: { color: "red" },
    expect: { status: "completed", output: "red" },
  });
  add({
    id: "schema-enum-bad",
    family: "schema",
    complexity: "medium",
    mode: "run",
    definition: linear(
      "schema-enum-bad",
      "set_variable",
      { name: "result", value: 1 },
      {
        inputSchema: {
          type: "object",
          properties: { color: { enum: ["red", "blue"] } },
        },
      },
    ),
    input: { color: "green" },
    expect: { reject: true, rejectPattern: "allowed values" },
  });
  add({
    id: "schema-integer-ok",
    family: "schema",
    complexity: "medium",
    mode: "run",
    definition: linear(
      "schema-integer-ok",
      "set_variable",
      { name: "result", value: "$input.n" },
      {
        inputSchema: {
          type: "object",
          properties: { n: { type: "integer" } },
        },
      },
    ),
    input: { n: 4 },
    expect: { status: "completed", output: 4 },
  });
  add({
    id: "schema-integer-bad",
    family: "schema",
    complexity: "medium",
    mode: "run",
    definition: linear(
      "schema-integer-bad",
      "set_variable",
      { name: "result", value: 1 },
      {
        inputSchema: {
          type: "object",
          properties: { n: { type: "integer" } },
        },
      },
    ),
    input: { n: 1.5 },
    expect: { reject: true, rejectPattern: "must be integer" },
  });
  add({
    id: "schema-array-items",
    family: "schema",
    complexity: "medium",
    mode: "run",
    definition: linear(
      "schema-array-items",
      "set_variable",
      { name: "result", value: "$input.nums.0" },
      {
        inputSchema: {
          type: "object",
          properties: {
            nums: { type: "array", items: { type: "number" } },
          },
        },
      },
    ),
    input: { nums: [9, 8] },
    expect: { status: "completed", output: 9 },
  });
  add({
    id: "schema-array-items-bad",
    family: "schema",
    complexity: "medium",
    mode: "run",
    definition: linear(
      "schema-array-items-bad",
      "set_variable",
      { name: "result", value: 1 },
      {
        inputSchema: {
          type: "object",
          properties: {
            nums: { type: "array", items: { type: "number" } },
          },
        },
      },
    ),
    input: { nums: ["x"] },
    expect: { reject: true, rejectPattern: "must be number" },
  });
  add({
    id: "schema-vars-bad",
    family: "schema",
    complexity: "medium",
    mode: "run",
    definition: linear(
      "schema-vars-bad",
      "set_variable",
      { name: "result", value: 42 },
      {
        variablesSchema: {
          type: "object",
          properties: { result: { type: "string" } },
        },
      },
    ),
    expect: { status: "failed", errorIncludes: "must be string" },
  });
  add({
    id: "schema-bool-ok",
    family: "schema",
    complexity: "medium",
    mode: "run",
    definition: linear(
      "schema-bool-ok",
      "set_variable",
      { name: "result", value: "$input.ok" },
      {
        inputSchema: {
          type: "object",
          properties: { ok: { type: "boolean" } },
        },
      },
    ),
    input: { ok: false },
    expect: { status: "completed", output: false },
  });
  add({
    id: "schema-null-ok",
    family: "schema",
    complexity: "medium",
    mode: "run",
    definition: linear(
      "schema-null-ok",
      "set_variable",
      { name: "result", value: "$input.value" },
      {
        inputSchema: {
          type: "object",
          properties: { value: { type: "null" } },
        },
      },
    ),
    input: { value: null },
    expect: { status: "completed", output: null },
  });
  add({
    id: "schema-nested-ok",
    family: "schema",
    complexity: "complex",
    mode: "run",
    definition: linear(
      "schema-nested-ok",
      "set_variable",
      { name: "result", value: "$input.user.id" },
      {
        inputSchema: {
          type: "object",
          properties: {
            user: {
              type: "object",
              required: ["id"],
              properties: { id: { type: "string" } },
            },
          },
        },
      },
    ),
    input: { user: { id: "u1" } },
    expect: { status: "completed", output: "u1" },
  });
  add({
    id: "schema-nested-bad",
    family: "schema",
    complexity: "complex",
    mode: "run",
    definition: linear(
      "schema-nested-bad",
      "set_variable",
      { name: "result", value: 1 },
      {
        inputSchema: {
          type: "object",
          properties: {
            user: {
              type: "object",
              required: ["id"],
              properties: { id: { type: "string" } },
            },
          },
        },
      },
    ),
    input: { user: { id: 9 } },
    expect: { reject: true, rejectPattern: "must be string" },
  });

  add({
    id: "to-hang",
    family: "timeout",
    complexity: "complex",
    mode: "run",
    definition: linear(
      "to-hang",
      "call_tool",
      { toolId: "tools.hang", input: {} },
      { timeoutMs: 50, permissions: ["*"] },
    ),
    expect: { status: "failed", errorIncludes: "timed out" },
  });
  add({
    id: "to-hang-skip",
    family: "timeout",
    complexity: "complex",
    mode: "run",
    definition: linear(
      "to-hang-skip",
      "call_tool",
      { toolId: "tools.hang", input: {} },
      {
        timeoutMs: 50,
        onError: { action: "skip" },
        endConfig: { output: "skipped-timeout" },
        permissions: ["*"],
      },
    ),
    expect: { status: "completed", output: "skipped-timeout" },
  });

  add({
    id: "cx-branch-foreach",
    family: "complex",
    complexity: "complex",
    mode: "run",
    definition: graph(
      "cx-branch-foreach",
      [
        node("start", "trigger", "manual"),
        node("gate", "control", "branch", { condition: "$input.go" }),
        node("each", "control", "for_each", {
          items: "$input.items",
          itemVariable: "item",
          collect: "$vars.item",
          resultVariable: "result",
        }),
        node("skip", "task", "set_variable", {
          name: "result",
          value: ["skipped"],
        }),
        node("end", "control", "end", { output: "$vars.result" }),
      ],
      [
        { id: "e1", source: "start", target: "gate" },
        { id: "e2", source: "gate", target: "each", sourceHandle: "true" },
        { id: "e3", source: "gate", target: "skip", sourceHandle: "false" },
        { id: "e4", source: "each", target: "end" },
        { id: "e5", source: "skip", target: "end" },
      ],
    ),
    input: { go: true, items: ["x", "y"] },
    expect: { status: "completed", output: ["x", "y"] },
  });
  add({
    id: "cx-branch-foreach-skip",
    family: "complex",
    complexity: "complex",
    mode: "run",
    definition: graph(
      "cx-branch-foreach-skip",
      [
        node("start", "trigger", "manual"),
        node("gate", "control", "branch", { condition: "$input.go" }),
        node("each", "control", "for_each", {
          items: "$input.items",
          itemVariable: "item",
          collect: "$vars.item",
          resultVariable: "result",
        }),
        node("skip", "task", "set_variable", {
          name: "result",
          value: ["skipped"],
        }),
        node("end", "control", "end", { output: "$vars.result" }),
      ],
      [
        { id: "e1", source: "start", target: "gate" },
        { id: "e2", source: "gate", target: "each", sourceHandle: "true" },
        { id: "e3", source: "gate", target: "skip", sourceHandle: "false" },
        { id: "e4", source: "each", target: "end" },
        { id: "e5", source: "skip", target: "end" },
      ],
    ),
    input: { go: false, items: ["x", "y"] },
    expect: { status: "completed", output: ["skipped"] },
  });
  add({
    id: "cx-chain",
    family: "complex",
    complexity: "complex",
    mode: "run",
    definition: graph(
      "cx-chain",
      [
        node("start", "trigger", "manual"),
        node("a", "task", "set_variable", { name: "a", value: 1 }),
        node("b", "task", "set_variable", { name: "b", value: "$vars.a" }),
        node("c", "task", "set_variable", {
          values: { c: "$vars.b", result: "$vars.b" },
        }),
        node("end", "control", "end", { output: "$vars.result" }),
      ],
      [
        { id: "e1", source: "start", target: "a" },
        { id: "e2", source: "a", target: "b" },
        { id: "e3", source: "b", target: "c" },
        { id: "e4", source: "c", target: "end" },
      ],
    ),
    expect: {
      status: "completed",
      output: 1,
      variables: { a: 1, b: 1, c: 1, result: 1 },
    },
  });
  add({
    id: "cx-tool-then-set",
    family: "complex",
    complexity: "complex",
    mode: "run",
    definition: graph(
      "cx-tool-then-set",
      [
        node("start", "trigger", "manual"),
        node("call", "task", "call_tool", {
          toolId: "tools.echo",
          input: { text: "$input.text" },
        }),
        node("save", "task", "set_variable", {
          name: "result",
          value: "$steps.call.echoed",
        }),
        node("end", "control", "end", { output: "$vars.result" }),
      ],
      [
        { id: "e1", source: "start", target: "call" },
        { id: "e2", source: "call", target: "save" },
        { id: "e3", source: "save", target: "end" },
      ],
      { permissions: ["*"] },
    ),
    input: { text: "piped" },
    expect: { status: "completed", output: "piped" },
  });
  add({
    id: "cx-diamond-branch",
    family: "complex",
    complexity: "complex",
    mode: "run",
    definition: graph(
      "cx-diamond-branch",
      [
        node("start", "trigger", "manual"),
        node("left", "task", "set_variable", { name: "left", value: 1 }),
        node("right", "task", "set_variable", { name: "right", value: 0 }),
        node("gate", "control", "branch", { condition: "$vars.left" }),
        node("yes", "task", "set_variable", { name: "path", value: "yes" }),
        node("no", "task", "set_variable", { name: "path", value: "no" }),
        node("end", "control", "end", { output: "$vars.path" }),
      ],
      [
        { id: "e1", source: "start", target: "left" },
        { id: "e2", source: "start", target: "right" },
        { id: "e3", source: "left", target: "gate" },
        { id: "e4", source: "right", target: "gate" },
        { id: "e5", source: "gate", target: "yes", sourceHandle: "true" },
        { id: "e6", source: "gate", target: "no", sourceHandle: "false" },
        { id: "e7", source: "yes", target: "end" },
        { id: "e8", source: "no", target: "end" },
      ],
    ),
    expect: { status: "completed", output: "yes" },
  });
  add({
    id: "cx-foreach-then-branch",
    family: "complex",
    complexity: "complex",
    mode: "run",
    definition: graph(
      "cx-foreach-then-branch",
      [
        node("start", "trigger", "manual"),
        node("each", "control", "for_each", {
          items: "$input.items",
          itemVariable: "item",
          collect: "$vars.item",
          resultVariable: "collected",
        }),
        node("gate", "control", "branch", { condition: "$vars.collected" }),
        node("yes", "task", "set_variable", { name: "path", value: "yes" }),
        node("no", "task", "set_variable", { name: "path", value: "no" }),
        node("end", "control", "end", { output: "$vars.path" }),
      ],
      [
        { id: "e1", source: "start", target: "each" },
        { id: "e2", source: "each", target: "gate" },
        { id: "e3", source: "gate", target: "yes", sourceHandle: "true" },
        { id: "e4", source: "gate", target: "no", sourceHandle: "false" },
        { id: "e5", source: "yes", target: "end" },
        { id: "e6", source: "no", target: "end" },
      ],
    ),
    input: { items: [] },
    expect: { status: "completed", output: "yes" },
  });

  for (let index = 0; index < 12; index += 1) {
    add({
      id: `mode-${index}`,
      family: "mode",
      complexity: "simple",
      mode: "run",
      definition: linear(
        `mode-${index}`,
        "set_variable",
        { name: "result", value: index },
        { mode: index % 2 === 0 ? "background" : "chat" },
      ),
      expect: { status: "completed", output: index },
    });
  }

  for (let length = 2; length <= 16; length += 1) {
    add({
      id: `chain-${length}`,
      family: "chain",
      complexity: length <= 4 ? "simple" : length <= 10 ? "medium" : "complex",
      mode: "run",
      definition: sequential(`chain-${length}`, length, 10),
      expect: { status: "completed", output: 10 + length - 1 },
    });
  }

  let pad = 0;
  while (scenarios.length < 500) {
    const steps = (pad % 8) + 1;
    add({
      id: `seq-${pad}`,
      family: "chain",
      complexity: steps <= 2 ? "simple" : steps <= 5 ? "medium" : "complex",
      mode: "run",
      definition: sequential(`seq-${pad}`, steps, pad),
      expect: { status: "completed", output: pad + steps - 1 },
    });
    pad += 1;
  }

  if (scenarios.length !== 500) {
    const counts = new Map<string, number>();
    for (const scenario of scenarios) {
      counts.set(scenario.family, (counts.get(scenario.family) ?? 0) + 1);
    }
    throw new Error(
      `expected 500 battle scenarios, got ${scenarios.length}: ${[...counts.entries()]
        .map(([family, count]) => `${family}=${count}`)
        .join(", ")}`,
    );
  }
  return scenarios;
}

export function battleCoverage(
  scenarios: readonly BattleScenario[] = generateBattleScenarios(),
): {
  readonly total: number;
  readonly families: Record<string, number>;
  readonly complexity: Record<BattleComplexity, number>;
  readonly modes: Record<string, number>;
} {
  const families: Record<string, number> = {};
  const complexity: Record<BattleComplexity, number> = {
    simple: 0,
    medium: 0,
    complex: 0,
  };
  const modes: Record<string, number> = {};
  for (const scenario of scenarios) {
    families[scenario.family] = (families[scenario.family] ?? 0) + 1;
    complexity[scenario.complexity] += 1;
    modes[scenario.mode] = (modes[scenario.mode] ?? 0) + 1;
  }
  return { total: scenarios.length, families, complexity, modes };
}
