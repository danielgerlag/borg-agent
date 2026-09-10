export const GRAPH_ENGINE_ID = "borg.graphs.v1";

const LEGACY_GRAPH_ENGINE_IDS: ReadonlySet<string> = new Set([
  "borg.graphs.hivemind-v1",
]);

export function resolveGraphEngineId(engineId: string): string {
  return LEGACY_GRAPH_ENGINE_IDS.has(engineId)
    ? GRAPH_ENGINE_ID
    : engineId;
}
