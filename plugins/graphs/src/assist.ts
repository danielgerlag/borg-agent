import {
  graphDefinitionSchema,
  type GraphDefinition,
  type GraphNode,
  type ModelMessage,
} from "@borg/contracts";
import { GRAPH_ENGINE_ID } from "./engine-id";
import { builtInKinds } from "./kind-registry";

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
  const system = `You are Borg's graph authoring assistant. Reply with a short summary and one JSON object for a GraphDefinition.

Rules:
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

export async function generateAssistedGraph(options: {
  readonly prompt: string;
  readonly current?: GraphDefinition | undefined;
  readonly kinds: readonly AssistKind[];
  readonly tools: readonly AssistTool[];
  readonly personas: readonly AssistPersona[];
  readonly complete: (
    messages: readonly ModelMessage[],
  ) => Promise<string>;
}): Promise<{ definition: GraphDefinition; summary: string }> {
  const baseMessages = buildAssistMessages(options);
  const first = await options.complete(baseMessages);
  try {
    const parsed = graphDefinitionSchema.parse(
      coerceCandidate(extractJsonValue(first), options.current),
    );
    return {
      definition: applyAssistLayout(parsed),
      summary: extractSummary(first),
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const repaired = await options.complete([
      ...baseMessages,
      { role: "assistant", content: first },
      {
        role: "user",
        content: `That JSON failed validation:\n${detail}\n\nReturn a corrected complete GraphDefinition JSON fence.`,
      },
    ]);
    const parsed = graphDefinitionSchema.parse(
      coerceCandidate(extractJsonValue(repaired), options.current),
    );
    return {
      definition: applyAssistLayout(parsed),
      summary: extractSummary(repaired),
    };
  }
}
