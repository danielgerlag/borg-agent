import type { GraphNode } from "@borg/contracts";

export type FieldWidget =
  | "text"
  | "number"
  | "select"
  | "switch"
  | "persona"
  | "tool"
  | "duration"
  | "expression"
  | "assignments"
  | "choiceList"
  | "toolArgs";

export interface FieldOption {
  readonly value: string;
  readonly label: string;
}

export interface FieldVisibleWhen {
  readonly key: string;
  readonly equals: unknown;
}

export interface FieldSpec {
  readonly key: string;
  readonly widget: FieldWidget;
  readonly label: string;
  readonly required?: boolean;
  readonly multiline?: boolean;
  readonly min?: number;
  readonly options?: readonly FieldOption[];
  readonly visibleWhen?: FieldVisibleWhen;
  readonly allowExpression?: boolean;
}

export interface KindDescriptor {
  readonly kind: string;
  readonly label: string;
  readonly type: GraphNode["type"];
  readonly fields: readonly FieldSpec[];
  readonly defaults: GraphNode["config"];
}

export const builtInKinds: readonly KindDescriptor[] = [
  {
    kind: "manual",
    label: "Manual",
    type: "trigger",
    fields: [],
    defaults: {},
  },
  {
    kind: "schedule",
    label: "Schedule",
    type: "trigger",
    fields: [
      {
        key: "everyMs",
        widget: "duration",
        label: "Every",
        required: true,
        min: 1_000,
      },
    ],
    defaults: { everyMs: 60_000 },
  },
  {
    kind: "incoming_message",
    label: "Incoming message",
    type: "trigger",
    fields: [
      { key: "channelId", widget: "text", label: "Channel ID" },
      { key: "adapterId", widget: "text", label: "Adapter ID" },
      { key: "destinationId", widget: "text", label: "Destination ID" },
    ],
    defaults: {},
  },
  {
    kind: "call_tool",
    label: "Call tool",
    type: "task",
    fields: [
      { key: "toolId", widget: "tool", label: "Tool", required: true },
      { key: "input", widget: "toolArgs", label: "Arguments" },
    ],
    defaults: { input: { text: "Hello from a graph" }, toolId: "tools.echo" },
  },
  {
    kind: "invoke_agent",
    label: "Invoke agent",
    type: "task",
    fields: [
      { key: "personaId", widget: "persona", label: "Persona" },
      {
        key: "prompt",
        widget: "expression",
        label: "Prompt",
        required: true,
        multiline: true,
      },
    ],
    defaults: {
      personaId: "system/general",
      prompt: "Complete this graph step.",
    },
  },
  {
    kind: "delay",
    label: "Delay",
    type: "task",
    fields: [
      {
        key: "ms",
        widget: "duration",
        label: "Duration",
        allowExpression: true,
      },
    ],
    defaults: { ms: 1_000 },
  },
  {
    kind: "set_variable",
    label: "Set variable",
    type: "task",
    fields: [{ key: "values", widget: "assignments", label: "Assignments" }],
    defaults: { name: "value", value: "" },
  },
  {
    kind: "invoke_prompt",
    label: "Invoke prompt",
    type: "task",
    fields: [
      {
        key: "prompt",
        widget: "expression",
        label: "Prompt",
        required: true,
        multiline: true,
      },
      { key: "system", widget: "text", label: "System", multiline: true },
    ],
    defaults: { prompt: "Summarize the graph input." },
  },
  {
    kind: "feedback_gate",
    label: "Feedback gate",
    type: "task",
    fields: [
      {
        key: "prompt",
        widget: "expression",
        label: "Prompt",
        required: true,
        multiline: true,
      },
      {
        key: "form",
        widget: "select",
        label: "Form",
        options: [
          { value: "confirm", label: "Confirm" },
          { value: "text", label: "Text" },
          { value: "choice", label: "Choice" },
        ],
      },
      {
        key: "choices",
        widget: "choiceList",
        label: "Choices",
        visibleWhen: { key: "form", equals: "choice" },
      },
    ],
    defaults: { form: "confirm", prompt: "Continue this graph?" },
  },
  {
    kind: "branch",
    label: "Branch",
    type: "control",
    fields: [
      {
        key: "condition",
        widget: "expression",
        label: "Condition",
        required: true,
      },
    ],
    defaults: { condition: "$vars.value" },
  },
  {
    kind: "for_each",
    label: "For each",
    type: "control",
    fields: [
      { key: "items", widget: "expression", label: "Items", required: true },
      {
        key: "itemVariable",
        widget: "text",
        label: "Item variable",
        required: true,
      },
      { key: "collect", widget: "expression", label: "Collect" },
      { key: "resultVariable", widget: "text", label: "Result variable" },
    ],
    defaults: {
      itemVariable: "item",
      items: "$input.items",
      collect: "$vars.item",
      resultVariable: "items",
    },
  },
  {
    kind: "end",
    label: "End",
    type: "control",
    fields: [{ key: "output", widget: "expression", label: "Output" }],
    defaults: { output: "$vars.result" },
  },
];

const descriptors = new Map(
  builtInKinds.map((item) => [item.kind, item] as const),
);

export function kindDescriptor(kind: string): KindDescriptor | undefined {
  return descriptors.get(kind);
}

export function defaultConfig(kind: string): GraphNode["config"] {
  const defaults = descriptors.get(kind)?.defaults ?? {};
  return structuredClone(defaults);
}

export function formatKind(kind: string): string {
  return descriptors.get(kind)?.label ?? kind.replaceAll("_", " ");
}
