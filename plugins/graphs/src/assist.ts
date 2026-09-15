import {
  assistQuestionSchema,
  graphDefinitionSchema,
  type AssistQuestion,
  type GraphDefinition,
  type GraphNode,
  type ModelMessage,
} from "@borg/contracts";
import { GRAPH_ENGINE_ID } from "./engine-id";
import { builtInKinds } from "./kind-registry";

export type { AssistChoice, AssistQuestion } from "@borg/contracts";

export interface AssistKind {
  readonly kind: string;
  readonly label: string;
  readonly type: GraphNode["type"];
}

export interface AssistTool {
  readonly id: string;
  readonly description: string;
}

export interface AssistPersona {
  readonly id: string;
  readonly name: string;
}

export type AssistTurn =
  | { kind: "question"; question: AssistQuestion; summary: string }
  | { kind: "graph"; definition: GraphDefinition; summary: string };

export type AssistSession = {
  readonly id: string;
  readonly messages: readonly ModelMessage[];
  readonly pendingQuestion?: AssistQuestion;
};

export interface AssistSessions {
  save(session: AssistSession): void;
  get(id: string): AssistSession | undefined;
  drop(id: string): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

export function slugGraphId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  if (/^[a-z][a-z0-9-]*$/.test(slug)) {
    return slug;
  }
  return `graph-${Date.now().toString(36)}`;
}

function uniqueChoiceId(label: string, used: Set<string>): string {
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const seed = /^[a-z][a-z0-9-]*$/.test(slug)
    ? slug
    : `choice-${slug.length > 0 ? slug : "option"}`;
  const base = /^[a-z][a-z0-9-]*$/.test(seed) ? seed : "choice-option";
  let candidate = base;
  let n = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${n}`;
    n += 1;
  }
  used.add(candidate);
  return candidate;
}

export function extractJsonValue(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = fenced?.[1]?.trim() ?? text.trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("The model did not return a graph JSON object");
  }
  return JSON.parse(candidate.slice(start, end + 1)) as unknown;
}

export function extractSummary(text: string): string {
  const withoutFence = text.replace(/```(?:json)?[\s\S]*?```/gi, "").trim();
  const compact = withoutFence.replace(/\s+/g, " ").slice(0, 4_000);
  return compact.length > 0 ? compact : "Updated the graph from your request.";
}

export function applyAssistLayout(definition: GraphDefinition): GraphDefinition {
  const nodes = definition.nodes.map((node, index) => {
    if (node.designer) {
      return node;
    }
    return {
      ...node,
      designer: {
        x: 120 + (index % 4) * 220,
        y: 140 + Math.floor(index / 4) * 140,
      },
    };
  });
  return { ...definition, nodes };
}

export function buildAssistMessages(options: {
  readonly prompt: string;
  readonly current?: GraphDefinition | undefined;
  readonly kinds: readonly AssistKind[];
  readonly tools: readonly AssistTool[];
  readonly personas: readonly AssistPersona[];
}): readonly ModelMessage[] {
  const kinds = options.kinds.length > 0 ? options.kinds : builtInKinds;
  const kindLines = kinds
    .map((item) => `- ${item.kind} (${item.type}): ${item.label}`)
    .join("\n");
  const toolLines =
    options.tools.length > 0
      ? options.tools
          .slice(0, 40)
          .map((tool) => `- ${tool.id}: ${tool.description}`)
          .join("\n")
      : "- tools.echo: Echo text";
  const personaLines =
    options.personas.length > 0
      ? options.personas
          .slice(0, 20)
          .map((persona) => `- ${persona.id} (${persona.name})`)
          .join("\n")
      : "- system/general (General)";
  const currentSection = options.current
    ? `The user is editing this graph. Modify it to satisfy the request. Keep the same id "${options.current.id}" unless they asked to replace it.\n\n${JSON.stringify(options.current, null, 2)}`
    : "This is a new graph. Create a complete definition from the request.";
  const system = `You are Borg's graph authoring assistant. Reply with a short summary and one JSON object.

Rules:
- If the request is underspecified, ask 1–2 structural questions with choices instead of guessing
- Do not emit a graph until enough is known
- To ask the user, emit JSON inside a \`\`\`json fence: { "ask_user": { "question": string, "choices": string[], "allow_freeform": boolean, "multi_select": boolean } }
- allow_freeform defaults to true. multi_select defaults to false
- When you know enough, emit a GraphDefinition JSON object inside a \`\`\`json fence after the summary
- engineId must be "${GRAPH_ENGINE_ID}"
- id is lowercase kebab-case starting with a letter
- version is like 1.0.0
- mode is "chat" or "background"
- Include at least one trigger node and one end node
- Every path must reach an end node
- Node ids match ^[a-zA-Z0-9][a-zA-Z0-9_-]*$
- Edge ids are unique. sourceHandle is "true" or "false" only on branch outputs
- onError is { "action": "fail" } unless the user asked for skip or goto
- call_tool config uses toolId and input
- invoke_agent config uses personaId and prompt
- set_variable config uses name and value
- feedback_gate config uses form (confirm|text|choice) and prompt
- Put designer x,y on each node
- Output JSON only inside a \`\`\`json fence after the summary

Available step kinds:
${kindLines}

Available tools:
${toolLines}

Personas:
${personaLines}`;
  return [
    { role: "system", content: system },
    {
      role: "user",
      content: `${currentSection}\n\nUser request:\n${options.prompt}`,
    },
  ];
}

export function formatAssistUserContent(
  prompt: string,
  current?: GraphDefinition,
): string {
  if (current === undefined) {
    return prompt;
  }
  return `${prompt}\n\nCurrent graph JSON:\n${JSON.stringify(current, null, 2)}`;
}

function coerceCandidate(
  value: unknown,
  current: GraphDefinition | undefined,
): unknown {
  if (!isRecord(value)) {
    return value;
  }
  const requestedName = readString(value, "name")?.trim();
  const name =
    requestedName && requestedName.length > 0
      ? requestedName
      : (current?.name ?? "Generated graph");
  const requestedId = readString(value, "id");
  const id =
    current?.id ??
    (requestedId !== undefined && /^[a-z][a-z0-9-]*$/.test(requestedId)
      ? requestedId
      : slugGraphId(name));
  const description = readString(value, "description") ?? current?.description;
  const coerced: Record<string, unknown> = {
    id,
    name,
    version: readString(value, "version") ?? current?.version ?? "1.0.0",
    engineId: GRAPH_ENGINE_ID,
    mode: value.mode === "background" ? "background" : (current?.mode ?? "chat"),
    inputSchema: isRecord(value.inputSchema)
      ? value.inputSchema
      : (current?.inputSchema ?? {}),
    variablesSchema: isRecord(value.variablesSchema)
      ? value.variablesSchema
      : (current?.variablesSchema ?? {}),
    nodes: value.nodes,
    edges: value.edges,
  };
  if (description !== undefined && description.length > 0) {
    coerced.description = description;
  }
  if (value.output !== undefined) {
    coerced.output = value.output;
  } else if (current?.output !== undefined) {
    coerced.output = current.output;
  }
  if (value.permissions !== undefined) {
    coerced.permissions = value.permissions;
  } else if (current?.permissions !== undefined) {
    coerced.permissions = current.permissions;
  }
  return coerced;
}

function parseChoices(value: unknown): { id: string; label: string }[] | undefined {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const used = new Set<string>();
  const choices: { id: string; label: string }[] = [];
  for (const item of value) {
    if (typeof item === "string") {
      const label = item.trim();
      if (label.length === 0) {
        return undefined;
      }
      choices.push({ id: uniqueChoiceId(label, used), label });
      continue;
    }
    if (!isRecord(item)) {
      return undefined;
    }
    const label = readString(item, "label")?.trim();
    if (label === undefined || label.length === 0) {
      return undefined;
    }
    choices.push({ id: uniqueChoiceId(label, used), label });
  }
  return choices;
}

function parseAskUser(value: unknown): AssistQuestion | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const text = readString(value, "question")?.trim();
  if (text === undefined || text.length === 0) {
    return undefined;
  }
  const choices = parseChoices(value.choices);
  if (choices === undefined) {
    return undefined;
  }
  const parsed = assistQuestionSchema.safeParse({
    id: crypto.randomUUID(),
    text,
    choices,
    allowFreeform: value.allow_freeform !== false,
    multiSelect: value.multi_select === true,
  });
  return parsed.success ? parsed.data : undefined;
}

function parseAssistedTurn(
  text: string,
  current: GraphDefinition | undefined,
): AssistTurn {
  const value = extractJsonValue(text);
  if (isRecord(value) && "ask_user" in value) {
    const question = parseAskUser(value.ask_user);
    if (question === undefined) {
      throw new Error("The model ask_user payload was invalid");
    }
    return {
      kind: "question",
      question,
      summary: extractSummary(text),
    };
  }
  const parsed = graphDefinitionSchema.parse(
    coerceCandidate(value, current),
  );
  return {
    kind: "graph",
    definition: applyAssistLayout(parsed),
    summary: extractSummary(text),
  };
}

function repairUserContent(
  error: unknown,
  options: {
    readonly kinds: readonly AssistKind[];
    readonly tools: readonly AssistTool[];
    readonly personas: readonly AssistPersona[];
  },
): string {
  const detail = error instanceof Error ? error.message : String(error);
  const kinds =
    options.kinds.length > 0
      ? options.kinds.map((item) => item.kind).join(", ")
      : "none";
  const tools =
    options.tools.length > 0
      ? options.tools.map((item) => item.id).join(", ")
      : "none";
  const personas =
    options.personas.length > 0
      ? options.personas.map((item) => item.id).join(", ")
      : "none";
  return `That JSON was neither a valid ask_user question nor a GraphDefinition:\n${detail}\n\nReturn a corrected JSON fence with either {"ask_user":{"question":string,"choices":string[],"allow_freeform":boolean,"multi_select":boolean}} or a complete GraphDefinition. Available step kinds: ${kinds}. Tools: ${tools}. Personas: ${personas}.`;
}

export async function generateAssistedTurn(options: {
  readonly messages: readonly ModelMessage[];
  readonly current?: GraphDefinition | undefined;
  readonly kinds: readonly AssistKind[];
  readonly tools: readonly AssistTool[];
  readonly personas: readonly AssistPersona[];
  readonly complete: (
    messages: readonly ModelMessage[],
  ) => Promise<string>;
}): Promise<{ readonly turn: AssistTurn; readonly raw: string }> {
  const first = await options.complete(options.messages);
  try {
    return {
      turn: parseAssistedTurn(first, options.current),
      raw: first,
    };
  } catch (error) {
    const repaired = await options.complete([
      ...options.messages,
      { role: "assistant", content: first },
      {
        role: "user",
        content: repairUserContent(error, options),
      },
    ]);
    return {
      turn: parseAssistedTurn(repaired, options.current),
      raw: repaired,
    };
  }
}

export function applyAnswer(
  session: AssistSession,
  answer: {
    readonly questionId: string;
    readonly text?: string;
    readonly choiceIds?: readonly string[];
  },
): AssistSession {
  const pending = session.pendingQuestion;
  if (pending === undefined || pending.id !== answer.questionId) {
    throw new Error("Unknown assist question");
  }
  const selectedIds = answer.choiceIds === undefined ? [] : [...answer.choiceIds];
  if (!pending.multiSelect && selectedIds.length > 1) {
    throw new Error("This question allows only one choice");
  }
  if (!pending.allowFreeform && selectedIds.length === 0) {
    throw new Error("This question requires a choice");
  }
  const labelsById = new Map<string, string>();
  for (const choice of pending.choices) {
    labelsById.set(choice.id, choice.label);
  }
  const labels: string[] = [];
  for (const id of selectedIds) {
    const label = labelsById.get(id);
    if (label === undefined) {
      throw new Error("Unknown assist choice");
    }
    labels.push(label);
  }
  const trimmed = answer.text?.trim();
  const hasText = trimmed !== undefined && trimmed.length > 0;
  const parts: string[] = [];
  if (labels.length > 0) {
    parts.push(labels.join(", "));
  }
  if (hasText && trimmed !== undefined) {
    parts.push(trimmed);
  }
  if (parts.length === 0) {
    throw new Error("Answer requires text or a choice");
  }
  return {
    id: session.id,
    messages: [...session.messages, { role: "user", content: parts.join("\n") }],
  };
}

export function withCurrentGraph(
  session: AssistSession,
  current: GraphDefinition,
): AssistSession {
  const last = session.messages[session.messages.length - 1];
  if (last === undefined || last.role !== "user") {
    return session;
  }
  return {
    id: session.id,
    ...(session.pendingQuestion !== undefined
      ? { pendingQuestion: session.pendingQuestion }
      : {}),
    messages: [
      ...session.messages.slice(0, -1),
      {
        role: "user",
        content: formatAssistUserContent(last.content, current),
      },
    ],
  };
}

export function createAssistSessions(limit = 8): AssistSessions {
  const sessions = new Map<string, AssistSession>();
  const touch = (id: string, session: AssistSession): void => {
    sessions.delete(id);
    sessions.set(id, session);
    while (sessions.size > limit) {
      const oldest = sessions.keys().next();
      if (oldest.done) {
        return;
      }
      sessions.delete(oldest.value);
    }
  };
  return {
    save(session) {
      touch(session.id, session);
    },
    get(id) {
      const session = sessions.get(id);
      if (session === undefined) {
        return undefined;
      }
      touch(id, session);
      return session;
    },
    drop(id) {
      sessions.delete(id);
    },
  };
}
