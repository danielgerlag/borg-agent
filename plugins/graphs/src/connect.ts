import type { GraphDefinition, GraphEdge } from "@borg/contracts";

export type BranchHandle = "true" | "false";

export interface ConnectInput {
  readonly source: string;
  readonly target: string;
  readonly sourceHandle?: BranchHandle | undefined;
}

export type ConnectResult =
  | { readonly ok: true; readonly definition: GraphDefinition; readonly edge: GraphEdge }
  | { readonly ok: false; readonly reason: string };

export function nextUniqueId(base: string, ids: ReadonlySet<string>): string {
  if (!ids.has(base)) {
    return base;
  }
  let suffix = 2;
  while (ids.has(`${base}-${suffix}`)) {
    suffix += 1;
  }
  return `${base}-${suffix}`;
}

export function connectNodes(
  definition: GraphDefinition,
  input: ConnectInput,
): ConnectResult {
  const source = input.source.trim();
  const target = input.target.trim();
  if (source.length === 0 || target.length === 0) {
    return { ok: false, reason: "Choose a source and target step." };
  }
  if (source === target) {
    return { ok: false, reason: "An edge must connect two different steps." };
  }
  const sourceNode = definition.nodes.find(({ id }) => id === source);
  const targetNode = definition.nodes.find(({ id }) => id === target);
  if (!sourceNode || !targetNode) {
    return { ok: false, reason: "Choose a source and target step." };
  }
  const sourceHandle =
    sourceNode.kind === "branch" ? input.sourceHandle : undefined;
  if (
    definition.edges.some(
      (edge) =>
        edge.source === source &&
        edge.target === target &&
        edge.sourceHandle === sourceHandle,
    )
  ) {
    return { ok: false, reason: "That edge already exists." };
  }
  const edgeIds = new Set(definition.edges.map(({ id }) => id));
  const edge: GraphEdge = {
    id: nextUniqueId(`${source}-to-${target}`, edgeIds),
    source,
    target,
    ...(sourceHandle ? { sourceHandle } : {}),
  };
  return {
    ok: true,
    definition: {
      ...definition,
      edges: [...definition.edges, edge],
    },
    edge,
  };
}
