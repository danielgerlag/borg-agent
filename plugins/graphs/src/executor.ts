import {
  channelInboundMessage,
  chatAppend,
  feedbackAsk,
  graphDefinitionDeleted,
  graphDefinitionSaved,
  graphDefinitionSchema,
  graphInstanceCompleted,
  graphInstanceFailed,
  graphInstanceSchema,
  graphInstanceStarted,
  graphInstanceUpdated,
  graphStepCompleted,
  type GraphDefinition,
  type GraphInstance,
  type GraphNode,
  type GraphNodeState,
  type LoopRunSnapshot,
} from "@borg/contracts";
import {
  type Disposable,
  type GraphStepContribution,
  type GraphTriggerContribution,
  type PluginContext,
  z,
} from "@borg/plugin-sdk";
import { randomUUID } from "node:crypto";

export const GRAPH_ENGINE_ID = "borg.graphs.hivemind-v1";

const DEFINITION_PREFIX = "definitions/current/";
const DEFINITION_VERSION_PREFIX = "definitions/versions/";
const INSTANCE_PREFIX = "instances/";
const TRIGGER_CURSOR_PREFIX = "trigger-schedules/";
const INBOUND_DEDUP_PREFIX = "trigger-inbound/";
const MAX_NODE_EXECUTIONS = 1_000;
const MAX_CONCURRENT_NODES = 4;

const edgeStateSchema = z.enum(["pending", "active", "inactive"]);
type EdgeState = z.infer<typeof edgeStateSchema>;

interface InstanceRecord {
  version: 1;
  instance: GraphInstance;
  definition: GraphDefinition;
  edgeStates: Record<string, EdgeState>;
  forcedNodes: string[];
  executionCount: number;
  startAnnounced: boolean;
  terminalAnnounced: boolean;
}

type GraphJson = Exclude<GraphNodeState["output"], undefined>;

const persistedDefinitionSchema = z
  .object({
    version: z.literal(1),
    definition: graphDefinitionSchema,
  })
  .strict();

const persistedInstanceSchema = z
  .object({
    version: z.literal(1),
    instance: graphInstanceSchema,
    definition: graphDefinitionSchema,
    edgeStates: z.record(z.string(), edgeStateSchema),
    forcedNodes: z.array(z.string()),
    executionCount: z.number().int().nonnegative(),
    startAnnounced: z.boolean(),
    terminalAnnounced: z.boolean().default(false),
  })
  .strict();

const triggerCursorSchema = z
  .object({
    version: z.literal(1),
    definitionVersion: z.string().min(1).optional(),
    everyMs: z.number().int().min(1_000).optional(),
    nextRunAt: z.string().datetime(),
  })
  .strict();

const quickStartDefinition = graphDefinitionSchema.parse({
  id: "quick-start",
  name: "Quick start",
  version: "1.0.0",
  engineId: GRAPH_ENGINE_ID,
  description: "A small starter graph that stores and returns a greeting.",
  mode: "background",
  inputSchema: {},
  variablesSchema: {},
  nodes: [
    {
      id: "start",
      type: "trigger",
      kind: "manual",
      config: {},
      onError: { action: "fail" },
    },
    {
      id: "set-message",
      type: "task",
      kind: "set_variable",
      config: {
        name: "message",
        value: "Quick-start graph completed.",
      },
      onError: { action: "fail" },
    },
    {
      id: "finish",
      type: "control",
      kind: "end",
      config: {},
      onError: { action: "fail" },
    },
  ],
  edges: [
    { id: "start-to-message", source: "start", target: "set-message" },
    { id: "message-to-finish", source: "set-message", target: "finish" },
  ],
  output: {
    message: "$vars.message",
  },
});

class GraphTimeoutError extends Error {
  constructor(nodeId: string, timeoutMs: number) {
    super(`Graph step ${nodeId} timed out after ${timeoutMs}ms`);
    this.name = "GraphTimeoutError";
  }
}

function asJsonValue(value: unknown): GraphJson {
  return JSON.parse(JSON.stringify(value)) as GraphJson;
}

function cloneDefinition(definition: GraphDefinition): GraphDefinition {
  return graphDefinitionSchema.parse(asJsonValue(definition));
}

function isJsonObject(value: unknown): value is Record<string, GraphJson> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("Graph execution was cancelled");
}

function isExpression(value: string): boolean {
  return /^\$(?:input|vars|steps)(?:\.|$)/.test(value.trim());
}

function requireString(
  config: Record<string, GraphJson>,
  keys: readonly string[],
  label: string,
): string {
  for (const key of keys) {
    const value = config[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  throw new Error(`${label} is required`);
}

function optionalString(
  config: Record<string, GraphJson>,
  key: string,
): string | undefined {
  const value = config[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value;
}

function jsonEquals(left: GraphJson, right: GraphJson): boolean {
  if (left === right) {
    return true;
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((item, index) => jsonEquals(item, right[index]!))
    );
  }
  if (isJsonObject(left) && isJsonObject(right)) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key, index) =>
          key === rightKeys[index] &&
          jsonEquals(left[key]!, right[key]!),
      )
    );
  }
  return false;
}

function assertJsonSchema(
  value: GraphJson,
  schema: Record<string, GraphJson>,
  label: string,
  enforceRequired = true,
): void {
  if (Object.keys(schema).length === 0) {
    return;
  }
  const expectedType = schema.type;
  const validType =
    expectedType === undefined ||
    (expectedType === "object" && isJsonObject(value)) ||
    (expectedType === "array" && Array.isArray(value)) ||
    (expectedType === "string" && typeof value === "string") ||
    (expectedType === "number" &&
      typeof value === "number" &&
      Number.isFinite(value)) ||
    (expectedType === "integer" &&
      typeof value === "number" &&
      Number.isInteger(value)) ||
    (expectedType === "boolean" && typeof value === "boolean") ||
    (expectedType === "null" && value === null);
  if (!validType) {
    throw new Error(`${label} must be ${String(expectedType)}`);
  }
  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((candidate) => jsonEquals(candidate, value))
  ) {
    throw new Error(`${label} is not one of the allowed values`);
  }
  if (isJsonObject(value)) {
    const required = schema.required;
    if (
      enforceRequired &&
      Array.isArray(required) &&
      required.every((item) => typeof item === "string")
    ) {
      for (const key of required) {
        if (!Object.hasOwn(value, key)) {
          throw new Error(`${label}.${key} is required`);
        }
      }
    }
    const properties = schema.properties;
    for (const [key, propertyValue] of Object.entries(value)) {
      const propertySchema = isJsonObject(properties)
        ? properties[key]
        : undefined;
      if (isJsonObject(propertySchema)) {
        assertJsonSchema(
          propertyValue,
          propertySchema,
          `${label}.${key}`,
        );
      } else if (schema.additionalProperties === false) {
        throw new Error(`${label}.${key} is not allowed`);
      }
    }
  }
  if (Array.isArray(value) && isJsonObject(schema.items)) {
    value.forEach((item, index) =>
      assertJsonSchema(item, schema.items as Record<string, GraphJson>, `${label}[${index}]`),
    );
  }
}

function requireNumber(
  config: Record<string, GraphJson>,
  keys: readonly string[],
  label: string,
): number {
  for (const key of keys) {
    const value = config[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
  }
  throw new Error(`${label} is required`);
}

function compareVersions(left: string, right: string): number {
  const parse = (version: string): { core: number[]; prerelease: string[] } => {
    const buildIndex = version.indexOf("+");
    const withoutBuild =
      buildIndex >= 0 ? version.slice(0, buildIndex) : version;
    const prereleaseIndex = withoutBuild.indexOf("-");
    const core =
      prereleaseIndex >= 0
        ? withoutBuild.slice(0, prereleaseIndex)
        : withoutBuild;
    const prerelease =
      prereleaseIndex >= 0 ? withoutBuild.slice(prereleaseIndex + 1) : "";
    return {
      core: core.split(".").map((part) => Number(part)),
      prerelease: prerelease.length > 0 ? prerelease.split(".") : [],
    };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a.core[index] ?? 0) - (b.core[index] ?? 0);
    if (difference !== 0) {
      return Math.sign(difference);
    }
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return a.prerelease.length === b.prerelease.length
      ? 0
      : a.prerelease.length === 0
        ? 1
        : -1;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined || rightPart === undefined) {
      return leftPart === rightPart ? 0 : leftPart === undefined ? -1 : 1;
    }
    if (leftPart === rightPart) {
      continue;
    }
    const leftNumber = /^\d+$/.test(leftPart) ? Number(leftPart) : undefined;
    const rightNumber = /^\d+$/.test(rightPart) ? Number(rightPart) : undefined;
    if (leftNumber !== undefined && rightNumber !== undefined) {
      return Math.sign(leftNumber - rightNumber);
    }
    if (leftNumber !== undefined || rightNumber !== undefined) {
      return leftNumber !== undefined ? -1 : 1;
    }
    return leftPart.localeCompare(rightPart);
  }
  return 0;
}

function nextPatchVersion(version: string): string {
  const [core = "0.0.0"] = version.split(/[+-]/, 1);
  const [major = "0", minor = "0", patch = "0"] = core.split(".");
  return `${major}.${minor}.${Number(patch) + 1}`;
}

function intersectToolPatterns(
  graphPatterns: readonly string[],
  nodePatterns: readonly string[],
): string[] {
  const intersections = new Set<string>();
  for (const graphPattern of graphPatterns) {
    for (const nodePattern of nodePatterns) {
      if (graphPattern === "*") {
        intersections.add(nodePattern);
        continue;
      }
      if (nodePattern === "*") {
        intersections.add(graphPattern);
        continue;
      }
      const graphPrefix = graphPattern.endsWith("*")
        ? graphPattern.slice(0, -1)
        : undefined;
      const nodePrefix = nodePattern.endsWith("*")
        ? nodePattern.slice(0, -1)
        : undefined;
      if (graphPrefix !== undefined && nodePrefix !== undefined) {
        if (graphPrefix.startsWith(nodePrefix)) {
          intersections.add(graphPattern);
        } else if (nodePrefix.startsWith(graphPrefix)) {
          intersections.add(nodePattern);
        }
      } else if (
        graphPrefix !== undefined &&
        nodePattern.startsWith(graphPrefix)
      ) {
        intersections.add(nodePattern);
      } else if (
        nodePrefix !== undefined &&
        graphPattern.startsWith(nodePrefix)
      ) {
        intersections.add(graphPattern);
      } else if (graphPattern === nodePattern) {
        intersections.add(graphPattern);
      }
    }
  }
  return [...intersections].sort();
}

function validateNodeConfig(node: GraphNode): void {
  const config = node.config;
  switch (node.kind) {
    case "manual":
      return;
    case "schedule": {
      const everyMs = config.everyMs;
      if (
        typeof everyMs !== "number" ||
        !Number.isInteger(everyMs) ||
        everyMs < 1_000
      ) {
        throw new Error(
          `Schedule trigger ${node.id} requires integer config.everyMs >= 1000`,
        );
      }
      return;
    }
    case "incoming_message": {
      const channelId = config.channelId;
      if (
        channelId !== undefined &&
        (typeof channelId !== "string" || channelId.trim().length === 0)
      ) {
        throw new Error(
          `Incoming-message trigger ${node.id} has an invalid channelId`,
        );
      }
      return;
    }
    case "call_tool":
      requireString(config, ["toolId"], `Tool ID for ${node.id}`);
      return;
    case "invoke_agent":
      requireString(config, ["prompt", "task"], `Agent prompt for ${node.id}`);
      optionalString(config, "personaId");
      return;
    case "delay": {
      const value = config.durationMs ?? config.ms;
      if (
        !(
          (typeof value === "number" &&
            Number.isInteger(value) &&
            value >= 0) ||
          (typeof value === "string" && isExpression(value))
        )
      ) {
        throw new Error(
          `Delay step ${node.id} requires non-negative config.durationMs`,
        );
      }
      return;
    }
    case "set_variable": {
      const values = config.values ?? config.variables;
      if (values !== undefined) {
        if (!isJsonObject(values)) {
          throw new Error(`Variable map for ${node.id} must be an object`);
        }
        return;
      }
      requireString(
        config,
        ["name", "variable"],
        `Variable name for ${node.id}`,
      );
      if (!Object.hasOwn(config, "value")) {
        throw new Error(`Variable value for ${node.id} is required`);
      }
      return;
    }
    case "invoke_prompt":
      requireString(config, ["prompt"], `Prompt for ${node.id}`);
      return;
    case "feedback_gate": {
      requireString(config, ["prompt"], `Feedback prompt for ${node.id}`);
      const form = config.form;
      if (
        form !== undefined &&
        form !== "text" &&
        form !== "confirm" &&
        form !== "choice" &&
        !(typeof form === "string" && isExpression(form))
      ) {
        throw new Error(`Feedback form for ${node.id} is invalid`);
      }
      if (form === "choice" && !Array.isArray(config.choices)) {
        throw new Error(`Choice feedback ${node.id} requires choices`);
      }
      return;
    }
    case "branch":
      if (!Object.hasOwn(config, "condition")) {
        throw new Error(`Branch ${node.id} requires config.condition`);
      }
      return;
    case "for_each":
      if (!Object.hasOwn(config, "items")) {
        throw new Error(`For-each ${node.id} requires config.items`);
      }
      requireString(
        config,
        ["itemVariable"],
        `Item variable for ${node.id}`,
      );
      return;
    case "end":
      return;
    default:
      throw new Error(`Graph node ${node.id} uses unsupported kind ${node.kind}`);
  }
}

export function validateGraphDefinition(
  candidate: unknown,
  extensions?: {
    readonly steps?: readonly GraphStepContribution[];
    readonly triggers?: readonly GraphTriggerContribution[];
  },
): GraphDefinition {
  const definition = graphDefinitionSchema.parse(candidate);
  if (definition.engineId !== GRAPH_ENGINE_ID) {
    throw new Error(
      `Graph ${definition.id} requires unavailable engine ${definition.engineId}`,
    );
  }

  const allowedKinds: Record<GraphNode["type"], ReadonlySet<string>> = {
    trigger: new Set([
      "manual",
      "schedule",
      "incoming_message",
      ...(extensions?.triggers?.map(({ kind }) => kind) ?? []),
    ]),
    task: new Set([
      "call_tool",
      "invoke_agent",
      "delay",
      "set_variable",
      "invoke_prompt",
      "feedback_gate",
      ...(extensions?.steps
        ?.filter(({ type }) => type === "task")
        .map(({ kind }) => kind) ?? []),
    ]),
    control: new Set([
      "branch",
      "for_each",
      "end",
      ...(extensions?.steps
        ?.filter(({ type }) => type === "control")
        .map(({ kind }) => kind) ?? []),
    ]),
  };
  const nodes = new Map(definition.nodes.map((node) => [node.id, node]));
  const triggers = definition.nodes.filter((node) => node.type === "trigger");
  const ends = definition.nodes.filter(
    (node) => node.type === "control" && node.kind === "end",
  );
  if (triggers.length !== 1) {
    throw new Error(`Graph ${definition.id} must contain exactly one trigger`);
  }
  if (ends.length !== 1) {
    throw new Error(`Graph ${definition.id} must contain exactly one end node`);
  }

  for (const node of definition.nodes) {
    if (!allowedKinds[node.type].has(node.kind)) {
      throw new Error(
        `Graph node ${node.id} has invalid ${node.type} kind ${node.kind}`,
      );
    }
    const external =
      node.type === "trigger"
        ? extensions?.triggers?.find(({ kind }) => kind === node.kind)
        : extensions?.steps?.find(
            ({ kind, type }) => kind === node.kind && type === node.type,
          );
    if (external) {
      const parsed = external.configSchema.safeParse(node.config);
      if (!parsed.success) {
        throw new Error(
          `Graph node ${node.id} has invalid ${node.kind} configuration`,
          { cause: parsed.error },
        );
      }
    } else {
      validateNodeConfig(node);
    }
    if (
      node.onError.action === "goto" &&
      !nodes.has(node.onError.nodeId)
    ) {
      throw new Error(
        `Graph node ${node.id} has an unknown goto target ${node.onError.nodeId}`,
      );
    }
  }

  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const node of definition.nodes) {
    outgoing.set(node.id, []);
    incoming.set(node.id, []);
  }
  for (const edge of definition.edges) {
    outgoing.get(edge.source)!.push(edge.target);
    incoming.get(edge.target)!.push(edge.source);
    const source = nodes.get(edge.source)!;
    if (
      source.kind === "branch" &&
      edge.sourceHandle !== undefined &&
      edge.sourceHandle !== "true" &&
      edge.sourceHandle !== "false"
    ) {
      throw new Error(
        `Branch edge ${edge.id} must use sourceHandle true or false`,
      );
    }
  }

  const trigger = triggers[0]!;
  const end = ends[0]!;
  if (incoming.get(trigger.id)!.length > 0) {
    throw new Error(`Trigger ${trigger.id} cannot have incoming edges`);
  }
  if (outgoing.get(end.id)!.length > 0) {
    throw new Error(`End node ${end.id} cannot have outgoing edges`);
  }
  for (const node of definition.nodes) {
    if (node.id !== trigger.id && incoming.get(node.id)!.length === 0) {
      throw new Error(`Graph node ${node.id} has no incoming edge`);
    }
    if (node.id !== end.id && outgoing.get(node.id)!.length === 0) {
      throw new Error(`Graph node ${node.id} has no outgoing edge`);
    }
  }

  const reachable = new Set<string>();
  const visit = (nodeId: string): void => {
    if (reachable.has(nodeId)) {
      return;
    }
    reachable.add(nodeId);
    for (const target of outgoing.get(nodeId) ?? []) {
      visit(target);
    }
  };
  visit(trigger.id);
  const unreachable = definition.nodes.filter((node) => !reachable.has(node.id));
  if (unreachable.length > 0) {
    throw new Error(
      `Graph ${definition.id} has unreachable nodes: ${unreachable
        .map(({ id }) => id)
        .join(", ")}`,
    );
  }

  const canReachEnd = new Set<string>();
  const visitReverse = (nodeId: string): void => {
    if (canReachEnd.has(nodeId)) {
      return;
    }
    canReachEnd.add(nodeId);
    for (const source of incoming.get(nodeId) ?? []) {
      visitReverse(source);
    }
  };
  visitReverse(end.id);
  const deadEnds = definition.nodes.filter((node) => !canReachEnd.has(node.id));
  if (deadEnds.length > 0) {
    throw new Error(
      `Graph ${definition.id} has nodes that cannot reach end: ${deadEnds
        .map(({ id }) => id)
        .join(", ")}`,
    );
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const assertAcyclic = (nodeId: string): void => {
    if (visiting.has(nodeId)) {
      throw new Error(`Graph ${definition.id} contains a cycle at ${nodeId}`);
    }
    if (visited.has(nodeId)) {
      return;
    }
    visiting.add(nodeId);
    for (const target of outgoing.get(nodeId) ?? []) {
      assertAcyclic(target);
    }
    visiting.delete(nodeId);
    visited.add(nodeId);
  };
  assertAcyclic(trigger.id);

  return cloneDefinition(definition);
}

export class HiveMindGraphEngine {
  readonly #definitions = new Map<string, GraphDefinition>();
  readonly #instances = new Map<string, InstanceRecord>();
  readonly #activeTasks = new Map<string, Disposable>();
  readonly #executionControllers = new Map<string, AbortController>();
  readonly #announcementTasks = new Map<string, Disposable>();
  readonly #delaySchedules = new Map<string, Disposable>();
  readonly #triggerSchedules = new Map<string, Disposable>();
  readonly #toolScopes = new Map<string, Disposable>();
  readonly #definitionOperations = new Map<string, Promise<void>>();
  readonly #inboundMessages = new Set<string>();
  #disposed = false;

  constructor(readonly context: PluginContext) {}

  #validateDefinition(candidate: unknown): GraphDefinition {
    return validateGraphDefinition(candidate, {
      steps: this.context.graphs.listSteps(),
      triggers: this.context.graphs.listTriggers(),
    });
  }

  async initialize(): Promise<void> {
    await this.#loadDefinitions();
    if (this.#definitions.size === 0) {
      await this.#persistDefinition(quickStartDefinition);
      this.#definitions.set(quickStartDefinition.id, quickStartDefinition);
    }
    await this.#loadInstances();

    for (const definition of this.#definitions.values()) {
      await this.#armDefinitionTrigger(definition).catch((error: unknown) => {
        this.context.logger.error(
          `Could not activate trigger for graph ${definition.id}`,
          { error: errorMessage(error) },
        );
      });
    }
    for (const record of this.#instances.values()) {
      if (
        record.instance.status === "running" ||
        record.instance.status === "waiting"
      ) {
        await this.#recover(record);
      } else if (
        (record.instance.status === "completed" ||
          record.instance.status === "failed") &&
        !record.terminalAnnounced
      ) {
        this.#spawnTerminalAnnouncement(record);
      }
    }
  }

  listDefinitions(): GraphDefinition[] {
    return [...this.#definitions.values()]
      .map(cloneDefinition)
      .sort(
        (left, right) =>
          left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
      );
  }

  getDefinition(graphId: string): GraphDefinition | null {
    const definition = this.#definitions.get(graphId);
    return definition ? cloneDefinition(definition) : null;
  }

  async refreshContributions(): Promise<void> {
    await this.#loadDefinitions();
    for (const definition of this.#definitions.values()) {
      const trigger = definition.nodes.find(
        ({ type }) => type === "trigger",
      );
      if (
        trigger &&
        trigger.kind !== "manual" &&
        trigger.kind !== "schedule" &&
        trigger.kind !== "incoming_message"
      ) {
        await this.#armDefinitionTrigger(definition).catch(
          (error: unknown) => {
            this.context.logger.error(
              `Could not refresh trigger for graph ${definition.id}`,
              { error: errorMessage(error) },
            );
          },
        );
      }
    }
  }

  listInstances(graphId?: string, sessionId?: string): GraphInstance[] {
    return [...this.#instances.values()]
      .map(({ instance }) => instance)
      .filter(
        (instance) =>
          (graphId === undefined || instance.graphId === graphId) &&
          (sessionId === undefined || instance.sessionId === sessionId),
      )
      .map((instance) => graphInstanceSchema.parse(asJsonValue(instance)))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  getInstance(instanceId: string): GraphInstance | null {
    const instance = this.#instances.get(instanceId)?.instance;
    return instance
      ? graphInstanceSchema.parse(asJsonValue(instance))
      : null;
  }

  async saveDefinition(candidate: unknown): Promise<GraphDefinition> {
    const validated = this.#validateDefinition(candidate);
    const observedVersion = this.#definitions.get(validated.id)?.version;
    return this.#serializeDefinition(validated.id, async () => {
      let definition = validated;
      const current = this.#definitions.get(definition.id);
      if (current) {
        const comparison = compareVersions(definition.version, current.version);
        if (comparison <= 0) {
          if (
            comparison < 0 &&
            definition.version !== observedVersion
          ) {
            throw new Error(
              `Graph ${definition.id} version ${definition.version} is stale; current version is ${current.version}`,
            );
          }
          const candidateAtCurrentVersion = {
            ...definition,
            version: current.version,
          };
          if (
            JSON.stringify(current) ===
            JSON.stringify(candidateAtCurrentVersion)
          ) {
            return cloneDefinition(current);
          }
          definition = this.#validateDefinition({
            ...definition,
            version: nextPatchVersion(current.version),
          });
        }
      }

      await this.#persistDefinition(definition);
      this.#definitions.set(definition.id, definition);
      await this.#armDefinitionTrigger(definition).catch((error: unknown) => {
        this.context.logger.error(
          `Saved graph ${definition.id}, but its trigger could not be activated`,
          { error: errorMessage(error) },
        );
      });
      await this.context.bus.emit(graphDefinitionSaved, { definition });
      return cloneDefinition(definition);
    });
  }

  async deleteDefinition(graphId: string): Promise<boolean> {
    return this.#serializeDefinition(graphId, async () => {
      if (!this.#definitions.has(graphId)) {
        return false;
      }
      await this.#disposeTriggerSchedule(graphId);
      const versions = await this.context.store.list(
        `${DEFINITION_VERSION_PREFIX}${graphId}/`,
      );
      await this.context.store.transaction([
        { type: "delete", key: `${DEFINITION_PREFIX}${graphId}` },
        { type: "delete", key: `${TRIGGER_CURSOR_PREFIX}${graphId}` },
        ...versions.map(({ key }) => ({ type: "delete" as const, key })),
      ]);
      this.#definitions.delete(graphId);
      await this.context.bus.emit(graphDefinitionDeleted, { graphId });
      return true;
    });
  }

  async launch(input: {
    graphId: string;
    sessionId?: string | undefined;
    input?: Record<string, GraphJson> | undefined;
    trigger?: string | undefined;
  }, persistence?: {
    readonly dedupKey: string;
    readonly dedupValue: GraphJson;
  }): Promise<string> {
    if (this.#disposed) {
      throw new Error("Graph engine is unavailable");
    }
    let definition = this.#definitions.get(input.graphId);
    if (!definition) {
      await this.refreshContributions();
      definition = this.#definitions.get(input.graphId);
    }
    if (!definition) {
      throw new Error(`Graph ${input.graphId} is unavailable`);
    }
    this.#validateDefinition(definition);
    const triggerNode = definition.nodes.find(({ type }) => type === "trigger")!;
    const launchTrigger = input.trigger ?? "manual";
    if (launchTrigger !== "manual" && triggerNode.kind !== launchTrigger) {
      throw new Error(
        `Graph ${definition.id} does not support ${launchTrigger} triggers`,
      );
    }
    const graphInput = asJsonValue(input.input ?? {});
    assertJsonSchema(
      graphInput,
      definition.inputSchema,
      `Graph ${definition.id} input`,
    );

    const now = new Date().toISOString();
    const instanceId = randomUUID();
    const instance = graphInstanceSchema.parse({
      id: instanceId,
      graphId: definition.id,
      graphName: definition.name,
      definitionVersion: definition.version,
      engineId: GRAPH_ENGINE_ID,
      mode: definition.mode,
      trigger: launchTrigger,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      status: "running",
      input: graphInput,
      variables: {},
      nodeStates: definition.nodes.map(({ id }) => ({
        nodeId: id,
        status: "pending",
        attempts: 0,
      })),
      createdAt: now,
      updatedAt: now,
    });
    const record: InstanceRecord = {
      version: 1,
      instance,
      definition: cloneDefinition(definition),
      edgeStates: Object.fromEntries(
        definition.edges.map(({ id }) => [id, "pending" as const]),
      ),
      forcedNodes: [triggerNode.id],
      executionCount: 0,
      startAnnounced: false,
      terminalAnnounced: false,
    };

    this.context.workspace.allocate(instanceId);
    try {
      this.#registerToolScope(record);
      if (persistence) {
        const persisted = this.#serializedInstance(record);
        await this.context.store.transaction([
          {
            type: "set",
            key: `${INSTANCE_PREFIX}${record.instance.id}`,
            value: asJsonValue(persisted),
          },
          {
            type: "set",
            key: persistence.dedupKey,
            value: persistence.dedupValue,
          },
        ]);
      } else {
        await this.#persistInstance(record);
      }
    } catch (error) {
      await this.#disposeToolScope(instanceId);
      await this.context.workspace.release(instanceId).catch(() => undefined);
      throw error;
    }
    this.#instances.set(instanceId, record);
    await this.context.bus.emit(graphInstanceStarted, { instance });
    this.#spawn(record, false);
    return instanceId;
  }

  async cancel(instanceId: string): Promise<boolean> {
    const record = this.#instances.get(instanceId);
    if (
      !record ||
      (record.instance.status !== "running" &&
        record.instance.status !== "waiting")
    ) {
      return false;
    }
    const completedAt = new Date().toISOString();
    record.instance.status = "cancelled";
    record.instance.updatedAt = completedAt;
    record.instance.completedAt = completedAt;
    this.#executionControllers
      .get(instanceId)
      ?.abort(new Error(`Graph ${instanceId} was cancelled`));
    await this.#activeTasks.get(instanceId)?.dispose();
    for (const state of record.instance.nodeStates) {
      if (state.childRunId) {
        this.context.loops.cancel(state.childRunId);
      }
      await this.#disposeDelay(instanceId, state.nodeId);
    }
    await this.#persistInstance(record);
    await this.context.bus.emit(graphInstanceUpdated, {
      instance: record.instance,
    });
    if (!this.#activeTasks.has(instanceId)) {
      await this.#releaseWorkspace(instanceId);
    }
    return true;
  }

  async handleInboundMessage(
    payload: z.infer<typeof channelInboundMessage.payload>,
  ): Promise<void> {
    const matching = [...this.#definitions.values()].filter((definition) => {
      const trigger = definition.nodes.find(({ type }) => type === "trigger");
      if (trigger?.kind !== "incoming_message") {
        return false;
      }
      const channelId = trigger.config.channelId;
      return channelId === undefined || channelId === payload.channelId;
    });
    for (const definition of matching) {
      const dedupKey = `${INBOUND_DEDUP_PREFIX}${definition.id}/${payload.id}`;
      if (
        this.#inboundMessages.has(dedupKey) ||
        (await this.context.store.get(dedupKey)) !== undefined
      ) {
        continue;
      }
      this.#inboundMessages.add(dedupKey);
      try {
        await this.launch(
          {
            graphId: definition.id,
            input: {
              id: payload.id,
              channelId: payload.channelId,
              text: payload.text,
              ...(payload.sender ? { sender: payload.sender } : {}),
              metadata: payload.metadata,
              receivedAt: payload.receivedAt,
              message: asJsonValue(payload),
            },
            trigger: "incoming_message",
          },
          {
            dedupKey,
            dedupValue: asJsonValue({
              version: 1,
              receivedAt: payload.receivedAt,
            }),
          },
        );
      } catch (error) {
        this.context.logger.error(
          `Failed to launch graph ${definition.id} from inbound message`,
          { error: errorMessage(error) },
        );
      } finally {
        this.#inboundMessages.delete(dedupKey);
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.#disposed) {
      return;
    }
    this.#disposed = true;
    for (const record of this.#instances.values()) {
      if (
        record.instance.status !== "running" &&
        record.instance.status !== "waiting"
      ) {
        continue;
      }
      for (const state of record.instance.nodeStates) {
        if (state.childRunId) {
          this.context.loops.cancel(state.childRunId);
        }
      }
    }
    await Promise.allSettled([
      ...[...this.#activeTasks.values()].map((task) =>
        Promise.resolve(task.dispose()),
      ),
      ...[...this.#announcementTasks.values()].map((task) =>
        Promise.resolve(task.dispose()),
      ),
      ...[...this.#delaySchedules.values()].map((schedule) =>
        Promise.resolve(schedule.dispose()),
      ),
      ...[...this.#triggerSchedules.values()].map((schedule) =>
        Promise.resolve(schedule.dispose()),
      ),
      ...[...this.#toolScopes.values()].map((scope) =>
        Promise.resolve(scope.dispose()),
      ),
    ]);
    this.#activeTasks.clear();
    this.#executionControllers.clear();
    this.#announcementTasks.clear();
    this.#delaySchedules.clear();
    this.#triggerSchedules.clear();
    this.#toolScopes.clear();
  }

  async #loadDefinitions(): Promise<void> {
    for (const stored of await this.context.store.list(DEFINITION_PREFIX)) {
      try {
        const definition =
          isJsonObject(stored.value) && "version" in stored.value
            ? persistedDefinitionSchema.parse(stored.value).definition
            : graphDefinitionSchema.parse(stored.value);
        const validated = this.#validateDefinition(definition);
        this.#definitions.set(validated.id, validated);
      } catch (error) {
        this.context.logger.warn(
          `Skipped unavailable graph definition at ${stored.key}`,
          { error: errorMessage(error) },
        );
      }
    }
  }

  async #loadInstances(): Promise<void> {
    for (const stored of await this.context.store.list(INSTANCE_PREFIX)) {
      try {
        const parsed = persistedInstanceSchema.parse(stored.value);
        const definition = this.#validateDefinition(parsed.definition);
        if (
          parsed.instance.engineId !== GRAPH_ENGINE_ID ||
          parsed.instance.graphId !== definition.id ||
          parsed.instance.definitionVersion !== definition.version
        ) {
          throw new Error(
            `Persisted graph instance ${parsed.instance.id} has an invalid definition snapshot`,
          );
        }
        this.#instances.set(parsed.instance.id, {
          version: 1,
          instance: parsed.instance,
          definition,
          edgeStates: parsed.edgeStates,
          forcedNodes: [...parsed.forcedNodes],
          executionCount: parsed.executionCount,
          startAnnounced: parsed.startAnnounced,
          terminalAnnounced: parsed.terminalAnnounced,
        });
      } catch (error) {
        this.context.logger.warn(
          `Skipped unavailable graph instance at ${stored.key}`,
          { error: errorMessage(error) },
        );
      }
    }
  }

  async #persistDefinition(definition: GraphDefinition): Promise<void> {
    const value = asJsonValue({
      version: 1,
      definition: cloneDefinition(definition),
    });
    await this.context.store.transaction([
      {
        type: "set",
        key: `${DEFINITION_PREFIX}${definition.id}`,
        value,
      },
      {
        type: "set",
        key: `${DEFINITION_VERSION_PREFIX}${definition.id}/${definition.version}`,
        value,
      },
    ]);
  }

  async #persistInstance(record: InstanceRecord): Promise<void> {
    const persisted = this.#serializedInstance(record);
    await this.context.store.set(
      `${INSTANCE_PREFIX}${record.instance.id}`,
      asJsonValue(persisted),
    );
  }

  #serializedInstance(record: InstanceRecord): InstanceRecord {
    graphInstanceSchema.parse(record.instance);
    return persistedInstanceSchema.parse(record);
  }

  async #checkpoint(record: InstanceRecord, emit = true): Promise<void> {
    record.instance.updatedAt = new Date().toISOString();
    await this.#persistInstance(record);
    if (emit) {
      await this.context.bus.emit(graphInstanceUpdated, {
        instance: record.instance,
      });
    }
  }

  async #recover(record: InstanceRecord): Promise<void> {
    this.context.workspace.allocate(record.instance.id);
    const indeterminate = record.instance.nodeStates.find((state) => {
      const node = this.#node(record, state.nodeId);
      const kind = node.kind;
      const contributedStep = this.context.graphs
        .listSteps()
        .find(
          ({ kind: candidateKind, type }) =>
            candidateKind === kind && type === node.type,
        );
      return (
        (state.status === "running" &&
          (kind === "call_tool" ||
            kind === "invoke_prompt" ||
            (contributedStep !== undefined &&
              contributedStep.replaySafe !== true))) ||
        ((state.status === "running" || state.status === "waiting") &&
          kind === "invoke_agent")
      );
    });
    if (indeterminate) {
      const completedAt = new Date().toISOString();
      indeterminate.status = "failed";
      indeterminate.error =
        "Borg stopped before this side-effecting step was durably completed; automatic replay was blocked.";
      indeterminate.completedAt = completedAt;
      record.instance.status = "failed";
      record.instance.error = `Step ${indeterminate.nodeId} has an indeterminate result and requires a new graph run.`;
      record.instance.completedAt = completedAt;
      record.instance.updatedAt = completedAt;
      await this.#persistInstance(record);
      await this.#releaseWorkspace(record.instance.id);
      this.#spawnTerminalAnnouncement(record);
      return;
    }
    this.#registerToolScope(record);
    let delayed = false;
    for (const state of record.instance.nodeStates) {
      if (
        state.status === "waiting" &&
        this.#node(record, state.nodeId).kind === "delay" &&
        state.waitUntil
      ) {
        delayed = true;
        await this.#armDelay(record, this.#node(record, state.nodeId), state);
        continue;
      }
      if (state.status === "running" || state.status === "waiting") {
        state.status = "pending";
        if (!record.forcedNodes.includes(state.nodeId)) {
          record.forcedNodes.push(state.nodeId);
        }
      }
    }
    record.instance.status = delayed ? "waiting" : "running";
    await this.#persistInstance(record);
    if (!delayed || record.forcedNodes.length > 0) {
      this.#spawn(record, true);
    }
  }

  #spawn(record: InstanceRecord, defer: boolean): void {
    const instanceId = record.instance.id;
    if (
      this.#disposed ||
      this.#activeTasks.has(instanceId) ||
      (record.instance.status !== "running" &&
        record.instance.status !== "waiting")
    ) {
      return;
    }
    const executionController = new AbortController();
    this.#executionControllers.set(instanceId, executionController);
    let disposable!: Disposable;
    disposable = this.context.runtime.spawn(async (runtimeSignal) => {
      const signal = AbortSignal.any([
        runtimeSignal,
        executionController.signal,
      ]);
      try {
        if (defer) {
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
        if (!record.startAnnounced) {
          record.startAnnounced = await this.#appendChat(record, "started");
          if (record.startAnnounced) {
            await this.#persistInstance(record);
          }
        }
        await this.#execute(record, signal);
      } catch (error) {
        if (!signal.aborted && record.instance.status !== "cancelled") {
          await this.#fail(record, errorMessage(error)).catch(
            (failure: unknown) => {
              this.context.logger.error(
                `Failed to record graph ${instanceId} failure`,
                { error: errorMessage(failure) },
              );
            },
          );
        }
      } finally {
        if (
          this.#executionControllers.get(instanceId) === executionController
        ) {
          this.#executionControllers.delete(instanceId);
        }
        if (this.#activeTasks.get(instanceId) === disposable) {
          this.#activeTasks.delete(instanceId);
        }
        if (
          record.instance.status === "failed" ||
          record.instance.status === "cancelled"
        ) {
          await this.#releaseWorkspace(instanceId);
        }
      }
    });
    this.#activeTasks.set(instanceId, disposable);
  }

  #spawnTerminalAnnouncement(record: InstanceRecord): void {
    const instanceId = record.instance.id;
    if (this.#announcementTasks.has(instanceId)) {
      return;
    }
    let disposable: Disposable;
    disposable = this.context.runtime.spawn(async (signal) => {
      try {
        await this.#waitForAnnouncementRetry(signal, 0);
        let attempts = 0;
        while (
          !signal.aborted &&
          !record.terminalAnnounced &&
          attempts < 12
        ) {
          attempts += 1;
          const status =
            record.instance.status === "completed" ? "completed" : "failed";
          record.terminalAnnounced = await this.#appendChat(record, status);
          if (record.terminalAnnounced) {
            await this.#persistInstance(record);
            return;
          }
          await this.#waitForAnnouncementRetry(signal, 5_000);
        }
      } finally {
        if (this.#announcementTasks.get(instanceId) === disposable) {
          this.#announcementTasks.delete(instanceId);
        }
      }
    });
    this.#announcementTasks.set(instanceId, disposable);
  }

  async #waitForAnnouncementRetry(
    signal: AbortSignal,
    delayMs: number,
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, delayMs);
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(abortReason(signal));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
      }
    });
  }

  async #execute(record: InstanceRecord, signal: AbortSignal): Promise<void> {
    while (
      !signal.aborted &&
      (record.instance.status === "running" ||
        record.instance.status === "waiting")
    ) {
      if (record.executionCount >= MAX_NODE_EXECUTIONS) {
        throw new Error(
          `Graph exceeded the ${MAX_NODE_EXECUTIONS} step execution limit`,
        );
      }
      await this.#propagateInactive(record);
      const nodes = this.#readyNodes(record);
      if (nodes.length === 0) {
        if (
          record.instance.nodeStates.some(({ status }) => status === "waiting")
        ) {
          record.instance.status = "waiting";
          await this.#checkpoint(record);
          return;
        }
        throw new Error("Graph has no executable path to its end node");
      }
      record.executionCount += nodes.length;
      const outcomes = await Promise.all(
        nodes.map((node) => this.#executeNode(record, node, signal)),
      );
      if (outcomes.includes("terminal")) {
        return;
      }
    }
    if (signal.aborted) {
      throw abortReason(signal);
    }
  }

  #readyNodes(record: InstanceRecord): GraphNode[] {
    const ready: GraphNode[] = [];
    while (
      record.forcedNodes.length > 0 &&
      ready.length < MAX_CONCURRENT_NODES
    ) {
      const nodeId = record.forcedNodes.shift()!;
      const state = this.#state(record, nodeId);
      if (state.status === "pending") {
        ready.push(this.#node(record, nodeId));
      }
    }
    for (const node of record.definition.nodes) {
      if (ready.length >= MAX_CONCURRENT_NODES) {
        break;
      }
      const state = this.#state(record, node.id);
      if (
        state.status !== "pending" ||
        node.type === "trigger" ||
        ready.some(({ id }) => id === node.id)
      ) {
        continue;
      }
      const incoming = record.definition.edges.filter(
        ({ target }) => target === node.id,
      );
      const edgeStates = incoming.map(({ id }) => record.edgeStates[id]);
      if (
        edgeStates.length > 0 &&
        edgeStates.every((edgeState) => edgeState !== "pending") &&
        edgeStates.some((edgeState) => edgeState === "active")
      ) {
        ready.push(node);
      }
    }
    return ready;
  }

  async #propagateInactive(record: InstanceRecord): Promise<void> {
    let changed = true;
    let anyChange = false;
    while (changed) {
      changed = false;
      for (const node of record.definition.nodes) {
        const state = this.#state(record, node.id);
        if (state.status !== "pending" || node.type === "trigger") {
          continue;
        }
        const incoming = record.definition.edges.filter(
          ({ target }) => target === node.id,
        );
        if (
          incoming.length > 0 &&
          incoming.every(({ id }) => record.edgeStates[id] === "inactive")
        ) {
          state.status = "skipped";
          state.completedAt = new Date().toISOString();
          for (const edge of record.definition.edges.filter(
            ({ source }) => source === node.id,
          )) {
            record.edgeStates[edge.id] = "inactive";
          }
          changed = true;
          anyChange = true;
        }
      }
    }
    if (anyChange) {
      await this.#checkpoint(record);
    }
  }

  async #executeNode(
    record: InstanceRecord,
    node: GraphNode,
    signal: AbortSignal,
  ): Promise<"continue" | "waiting" | "terminal"> {
    if (this.#isTerminal(record)) {
      return "terminal";
    }
    const state = this.#state(record, node.id);
    state.status = "running";
    state.attempts += 1;
    state.startedAt ??= new Date().toISOString();
    delete state.completedAt;
    delete state.error;
    this.#refreshActiveStatus(record);
    await this.#checkpoint(record);

    try {
      if (node.kind === "delay") {
        await this.#startDelay(record, node, state);
        return "waiting";
      }
      const rawOutput = await this.#withTimeout(
        node,
        signal,
        (operationSignal) =>
          this.#performNode(record, node, state, operationSignal),
      );
      signal.throwIfAborted();
      if (this.#isTerminal(record)) {
        return "terminal";
      }
      const output = this.#applyDeclaredOutputs(record, node, rawOutput);
      state.status = "completed";
      state.completedAt = new Date().toISOString();
      if (output === undefined) {
        delete state.output;
      } else {
        state.output = output;
      }
      delete state.waitUntil;
      this.#refreshActiveStatus(record);
      this.#decideOutgoingEdges(
        record,
        node,
        node.kind === "branch" ? rawOutput : output,
      );
      await this.#checkpoint(record);
      await this.context.bus.emit(graphStepCompleted, {
        instanceId: record.instance.id,
        graphId: record.instance.graphId,
        stepId: node.id,
        ...(output === undefined ? {} : { output }),
        completedAt: state.completedAt,
      });
      if (node.kind === "end") {
        await this.#complete(record, output);
        return "terminal";
      }
      return "continue";
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      if (this.#isTerminal(record)) {
        return "terminal";
      }
      return this.#handleNodeError(record, node, state, error);
    }
  }

  async #performNode(
    record: InstanceRecord,
    node: GraphNode,
    state: GraphNodeState,
    signal: AbortSignal,
  ): Promise<GraphJson | undefined> {
    if (node.kind === "for_each") {
      return this.#performForEach(record, node);
    }
    const resolved = this.#resolveValue(node.config, record);
    if (!isJsonObject(resolved)) {
      throw new Error(`Graph step ${node.id} config did not resolve to an object`);
    }

    switch (node.kind) {
      case "manual":
      case "schedule":
      case "incoming_message":
        return asJsonValue(record.instance.input);
      case "call_tool": {
        const toolId = requireString(
          resolved,
          ["toolId"],
          `Tool ID for ${node.id}`,
        );
        const toolInput = resolved.input ?? resolved.arguments ?? {};
        return asJsonValue(
          await this.context.tools.invoke(toolId, toolInput, {
            runId: record.instance.id,
            signal,
          }),
        );
      }
      case "invoke_agent":
        return this.#invokeAgent(record, node, state, resolved, signal);
      case "set_variable": {
        const values = resolved.values ?? resolved.variables;
        if (values !== undefined) {
          if (!isJsonObject(values)) {
            throw new Error(`Variable map for ${node.id} must be an object`);
          }
          const nextVariables = {
            ...record.instance.variables,
            ...values,
          };
          assertJsonSchema(
            nextVariables,
            record.definition.variablesSchema,
            `Graph ${record.definition.id} variables`,
            false,
          );
          record.instance.variables = nextVariables;
          return asJsonValue(values);
        }
        const name = requireString(
          resolved,
          ["name", "variable"],
          `Variable name for ${node.id}`,
        );
        if (!Object.hasOwn(resolved, "value")) {
          throw new Error(`Variable value for ${node.id} is required`);
        }
        const value = resolved.value!;
        assertJsonSchema(
          { ...record.instance.variables, [name]: value },
          record.definition.variablesSchema,
          `Graph ${record.definition.id} variables`,
          false,
        );
        record.instance.variables[name] = value;
        return asJsonValue({ name, value });
      }
      case "invoke_prompt": {
        const prompt = requireString(
          resolved,
          ["prompt"],
          `Prompt for ${node.id}`,
        );
        const system = optionalString(resolved, "system");
        const completion = await this.context.models.complete(
          {
            ...(optionalString(resolved, "providerId")
              ? { providerId: optionalString(resolved, "providerId") }
              : {}),
            ...(optionalString(resolved, "modelId")
              ? { modelId: optionalString(resolved, "modelId") }
              : {}),
            messages: [
              ...(system
                ? ([{ role: "system" as const, content: system }] as const)
                : []),
              { role: "user", content: prompt },
            ],
          },
          signal,
        );
        const content = completion.result.content;
        if (content === undefined) {
          throw new Error(`Prompt step ${node.id} returned no content`);
        }
        return asJsonValue({
          content,
          providerId: completion.providerId,
          modelId: completion.modelId,
        });
      }
      case "feedback_gate":
        return this.#askForFeedback(record, node, state, resolved, signal);
      case "branch":
        return asJsonValue({
          condition: Boolean(resolved.condition),
        });
      case "for_each":
        throw new Error("For-each steps are resolved separately");
      case "end":
        return this.#resolveEndOutput(record, resolved);
      case "delay":
        throw new Error("Delay steps are scheduled separately");
      default: {
        if (
          node.type === "trigger" &&
          this.context.graphs
            .listTriggers()
            .some(({ kind }) => kind === node.kind)
        ) {
          return asJsonValue(record.instance.input);
        }
        const contribution = this.context.graphs
          .listSteps()
          .find(
            ({ kind, type }) =>
              kind === node.kind && type === node.type,
          );
        if (contribution) {
          const config = asJsonValue(
            contribution.configSchema.parse(resolved),
          );
          return asJsonValue(
            await contribution.execute(config, {
              instanceId: record.instance.id,
              nodeId: node.id,
              input: record.instance.input,
              variables: record.instance.variables,
              signal,
            }),
          );
        }
        throw new Error(`Unsupported graph step ${node.kind}`);
      }
    }
  }

  #performForEach(
    record: InstanceRecord,
    node: GraphNode,
  ): GraphJson {
    const items = this.#resolveValue(node.config.items!, record);
    if (!Array.isArray(items)) {
      throw new Error(`For-each ${node.id} items must resolve to an array`);
    }
    const itemVariable = requireString(
      node.config,
      ["itemVariable"],
      `Item variable for ${node.id}`,
    );
    const resultVariable = optionalString(node.config, "resultVariable");
    const results: GraphJson[] = [];
    for (const item of items) {
      record.instance.variables[itemVariable] = asJsonValue(item);
      const collected = Object.hasOwn(node.config, "collect")
        ? this.#resolveValue(node.config.collect!, record)
        : asJsonValue(item);
      results.push(collected);
    }
    if (resultVariable) {
      record.instance.variables[resultVariable] = asJsonValue(results);
    }
    assertJsonSchema(
      record.instance.variables,
      record.definition.variablesSchema,
      `Graph ${record.definition.id} variables`,
      false,
    );
    return asJsonValue({ count: items.length, items, results });
  }

  async #invokeAgent(
    record: InstanceRecord,
    node: GraphNode,
    state: GraphNodeState,
    config: Record<string, GraphJson>,
    signal: AbortSignal,
  ): Promise<GraphJson> {
    const prompt = requireString(
      config,
      ["prompt", "task"],
      `Agent prompt for ${node.id}`,
    );
    const configuredPersonaId = optionalString(config, "personaId");
    const persona = configuredPersonaId
      ? this.context.personas.get(configuredPersonaId)
      : this.context.personas.getDefault();
    if (!persona || persona.archived) {
      throw new Error(
        `Persona ${configuredPersonaId ?? "(default)"} is unavailable`,
      );
    }

    let snapshot = state.childRunId
      ? this.context.loops.get(state.childRunId)
      : undefined;
    if (snapshot?.status === "cancelled") {
      delete state.childRunId;
      snapshot = undefined;
    }
    if (!snapshot) {
      const configuredAllowedTools = config.allowedTools;
      if (
        configuredAllowedTools !== undefined &&
        (!Array.isArray(configuredAllowedTools) ||
          configuredAllowedTools.some((toolId) => typeof toolId !== "string"))
      ) {
        throw new Error(`allowedTools for ${node.id} must be a string array`);
      }
      const allowedTools = intersectToolPatterns(
        record.definition.permissions ?? ["*"],
        configuredAllowedTools
          ? (configuredAllowedTools as string[])
          : ["*"],
      );
      snapshot = await this.context.loops.start({
        prompt,
        personaId: persona.id,
        ...(optionalString(config, "providerId")
          ? { providerId: optionalString(config, "providerId") }
          : {}),
        ...(optionalString(config, "modelId")
          ? { modelId: optionalString(config, "modelId") }
          : {}),
        allowedTools,
        sessionId: record.instance.id,
      });
      state.childRunId = snapshot.id;
    }
    await this.#markWaiting(record, state);
    const terminal = await this.#awaitLoop(snapshot.id, signal);
    if (terminal.status === "failed") {
      throw new Error(
        terminal.error ?? `Agent run ${terminal.id} failed without an error`,
      );
    }
    if (terminal.status === "cancelled") {
      throw new Error(`Agent run ${terminal.id} was cancelled`);
    }
    if (terminal.status !== "completed") {
      throw new Error(`Agent run ${terminal.id} ended in ${terminal.status}`);
    }
    return asJsonValue({
      runId: terminal.id,
      output: terminal.output ?? "",
    });
  }

  async #awaitLoop(
    runId: string,
    signal: AbortSignal,
  ): Promise<LoopRunSnapshot> {
    const terminal = (snapshot: LoopRunSnapshot | undefined): boolean =>
      snapshot !== undefined &&
      (snapshot.status === "completed" ||
        snapshot.status === "failed" ||
        snapshot.status === "cancelled");
    const existing = this.context.loops.get(runId);
    if (terminal(existing)) {
      return existing!;
    }

    return new Promise<LoopRunSnapshot>((resolve, reject) => {
      let settled = false;
      let subscription: Disposable | undefined;
      const finish = (error?: Error, snapshot?: LoopRunSnapshot): void => {
        if (settled) {
          return;
        }
        settled = true;
        signal.removeEventListener("abort", onAbort);
        void subscription?.dispose();
        if (error) {
          reject(error);
        } else {
          resolve(snapshot!);
        }
      };
      const check = (): void => {
        const snapshot = this.context.loops.get(runId);
        if (terminal(snapshot)) {
          finish(undefined, snapshot);
        }
      };
      const onAbort = (): void => {
        this.context.loops.cancel(runId);
        finish(abortReason(signal));
      };
      subscription = this.context.loops.subscribe(runId, check);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
      } else {
        check();
      }
    });
  }

  async #askForFeedback(
    record: InstanceRecord,
    node: GraphNode,
    state: GraphNodeState,
    config: Record<string, GraphJson>,
    signal: AbortSignal,
  ): Promise<GraphJson> {
    if (!this.context.bus.provides(feedbackAsk)) {
      throw new Error(
        "Graph feedback is unavailable because borg.feedback.ask has no handler",
      );
    }
    const prompt = requireString(
      config,
      ["prompt"],
      `Feedback prompt for ${node.id}`,
    );
    const form = config.form ?? "text";
    if (form !== "text" && form !== "confirm" && form !== "choice") {
      throw new Error(`Feedback form for ${node.id} is invalid`);
    }
    const choices = config.choices;
    if (
      choices !== undefined &&
      (!Array.isArray(choices) ||
        choices.some(
          (choice) =>
            !isJsonObject(choice) ||
            typeof choice.id !== "string" ||
            typeof choice.label !== "string",
        ))
    ) {
      throw new Error(`Feedback choices for ${node.id} are invalid`);
    }
    await this.#markWaiting(record, state);
    const result = await this.context.bus.invoke(
      feedbackAsk,
      {
        ...(optionalString(config, "title")
          ? { title: optionalString(config, "title") }
          : {}),
        prompt,
        form,
        ...(choices
          ? {
              choices: choices as {
                id: string;
                label: string;
              }[],
            }
          : {}),
        source: {
          ...(record.instance.sessionId
            ? { sessionId: record.instance.sessionId }
            : {}),
          instanceId: record.instance.id,
          stepId: node.id,
        },
        ...(typeof config.timeoutMs === "number"
          ? { timeoutMs: config.timeoutMs }
          : node.timeoutMs
            ? { timeoutMs: node.timeoutMs }
            : {}),
      },
      { signal },
    );
    return asJsonValue(result);
  }

  async #markWaiting(
    record: InstanceRecord,
    state: GraphNodeState,
  ): Promise<void> {
    state.status = "waiting";
    record.instance.status = "waiting";
    await this.#checkpoint(record);
  }

  async #startDelay(
    record: InstanceRecord,
    node: GraphNode,
    state: GraphNodeState,
  ): Promise<void> {
    const resolved = this.#resolveValue(node.config, record);
    if (!isJsonObject(resolved)) {
      throw new Error(`Delay ${node.id} config did not resolve to an object`);
    }
    const durationMs = requireNumber(
      resolved,
      ["durationMs", "ms"],
      `Delay duration for ${node.id}`,
    );
    if (!Number.isInteger(durationMs) || durationMs < 0) {
      throw new Error(`Delay ${node.id} duration must be a non-negative integer`);
    }
    state.status = "waiting";
    state.waitUntil = new Date(Date.now() + durationMs).toISOString();
    record.instance.status = "waiting";
    await this.#checkpoint(record);
    await this.#armDelay(record, node, state);
  }

  async #armDelay(
    record: InstanceRecord,
    node: GraphNode,
    state: GraphNodeState,
  ): Promise<void> {
    const waitUntil = state.waitUntil;
    if (!waitUntil) {
      throw new Error(`Delay ${node.id} has no persisted deadline`);
    }
    const scheduleId = this.#delayScheduleId(record.instance.id, node.id);
    await this.#disposeDelay(record.instance.id, node.id);
    const disposable = this.context.scheduler.schedule(
      scheduleId,
      waitUntil,
      async (signal) => {
        this.#delaySchedules.delete(scheduleId);
        if (
          signal.aborted ||
          this.#disposed ||
          this.#isTerminal(record)
        ) {
          return;
        }
        const current = this.#state(record, node.id);
        if (current.status !== "waiting" || current.waitUntil !== waitUntil) {
          return;
        }
        const completedAt = new Date().toISOString();
        const output = asJsonValue({ waitUntil });
        current.status = "completed";
        current.output = output;
        current.completedAt = completedAt;
        this.#refreshActiveStatus(record);
        this.#decideOutgoingEdges(record, node, output);
        await this.#checkpoint(record);
        await this.context.bus.emit(graphStepCompleted, {
          instanceId: record.instance.id,
          graphId: record.instance.graphId,
          stepId: node.id,
          output,
          completedAt,
        });
        this.#spawn(record, false);
      },
    );
    this.#delaySchedules.set(scheduleId, disposable);
  }

  async #handleNodeError(
    record: InstanceRecord,
    node: GraphNode,
    state: GraphNodeState,
    error: unknown,
  ): Promise<"continue" | "terminal"> {
    if (this.#isTerminal(record)) {
      return "terminal";
    }
    const message = errorMessage(error);
    state.error = message;
    state.completedAt = new Date().toISOString();
    this.#refreshActiveStatus(record);
    const strategy = node.onError;
    if (strategy.action === "retry" && state.attempts < strategy.maxAttempts) {
      state.status = "pending";
      record.forcedNodes.unshift(node.id);
      await this.#checkpoint(record);
      return "continue";
    }
    if (strategy.action === "skip") {
      state.status = "skipped";
      this.#setAllOutgoing(record, node.id, "active");
      await this.#checkpoint(record);
      return "continue";
    }
    if (strategy.action === "goto") {
      state.status = "failed";
      this.#setAllOutgoing(record, node.id, "inactive");
      const target = this.#state(record, strategy.nodeId);
      target.status = "pending";
      delete target.completedAt;
      delete target.error;
      delete target.output;
      delete target.waitUntil;
      if (!record.forcedNodes.includes(strategy.nodeId)) {
        record.forcedNodes.unshift(strategy.nodeId);
      }
      await this.#checkpoint(record);
      return "continue";
    }
    state.status = "failed";
    await this.#checkpoint(record);
    await this.#fail(record, `Step ${node.id} failed: ${message}`);
    return "terminal";
  }

  #decideOutgoingEdges(
    record: InstanceRecord,
    node: GraphNode,
    output: GraphJson | undefined,
  ): void {
    const outgoing = record.definition.edges.filter(
      ({ source }) => source === node.id,
    );
    if (node.kind !== "branch") {
      for (const edge of outgoing) {
        record.edgeStates[edge.id] = "active";
      }
      return;
    }
    const condition =
      isJsonObject(output) && typeof output.condition === "boolean"
        ? output.condition
        : Boolean(output);
    for (const edge of outgoing) {
      record.edgeStates[edge.id] =
        edge.sourceHandle === undefined ||
        edge.sourceHandle === String(condition)
          ? "active"
          : "inactive";
    }
  }

  #setAllOutgoing(
    record: InstanceRecord,
    nodeId: string,
    edgeState: EdgeState,
  ): void {
    for (const edge of record.definition.edges.filter(
      ({ source }) => source === nodeId,
    )) {
      record.edgeStates[edge.id] = edgeState;
    }
  }

  #refreshActiveStatus(record: InstanceRecord): void {
    if (this.#isTerminal(record)) {
      return;
    }
    record.instance.status = record.instance.nodeStates.some(
      ({ status }) => status === "waiting",
    )
      ? "waiting"
      : "running";
  }

  #isTerminal(record: InstanceRecord): boolean {
    return (
      record.instance.status === "completed" ||
      record.instance.status === "failed" ||
      record.instance.status === "cancelled"
    );
  }

  #applyDeclaredOutputs(
    record: InstanceRecord,
    node: GraphNode,
    output: GraphJson | undefined,
  ): GraphJson | undefined {
    if (!node.outputs) {
      return output;
    }
    const mapped: Record<string, GraphJson> = {};
    const overrides =
      output === undefined ? undefined : new Map([[node.id, output]]);
    for (const [key, expression] of Object.entries(node.outputs)) {
      mapped[key] = this.#resolveValue(expression, record, overrides);
    }
    return mapped;
  }

  #resolveEndOutput(
    record: InstanceRecord,
    config: Record<string, GraphJson>,
  ): GraphJson {
    if (Object.hasOwn(config, "output")) {
      return config.output!;
    }
    if (record.definition.output) {
      const output: Record<string, GraphJson> = {};
      for (const [key, expression] of Object.entries(record.definition.output)) {
        output[key] = this.#resolveValue(expression, record);
      }
      return output;
    }
    return {};
  }

  #resolveValue(
    value: GraphJson,
    record: InstanceRecord,
    overrides?: ReadonlyMap<string, GraphJson>,
  ): GraphJson {
    if (typeof value === "string") {
      const exact = value.trim();
      if (/^\$(?:input|vars|steps)(?:\.|$)/.test(exact)) {
        return this.#resolveReference(exact, record, overrides);
      }
      return value.replace(
        /\{\{\s*(\$(?:input|vars|steps)(?:\.[^{}]+)?)\s*\}\}/g,
        (_match, expression: string) => {
          const resolved = this.#resolveReference(
            expression.trim(),
            record,
            overrides,
          );
          return typeof resolved === "string"
            ? resolved
            : JSON.stringify(resolved);
        },
      );
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.#resolveValue(item, record, overrides));
    }
    if (isJsonObject(value)) {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          this.#resolveValue(item, record, overrides),
        ]),
      );
    }
    return value;
  }

  #resolveReference(
    expression: string,
    record: InstanceRecord,
    overrides?: ReadonlyMap<string, GraphJson>,
  ): GraphJson {
    const match =
      /^\$(input|vars|steps)(?:\.(.+))?$/.exec(expression.trim());
    if (!match) {
      throw new Error(`Invalid graph expression ${expression}`);
    }
    const rootName = match[1]!;
    const path = match[2]?.split(".") ?? [];
    let current: GraphJson;
    if (rootName === "input") {
      current = record.instance.input;
    } else if (rootName === "vars") {
      current = record.instance.variables;
    } else {
      const steps: Record<string, GraphJson> = {};
      for (const state of record.instance.nodeStates) {
        const override = overrides?.get(state.nodeId);
        if (override !== undefined) {
          steps[state.nodeId] = override;
        } else if (state.output !== undefined) {
          steps[state.nodeId] = state.output;
        }
      }
      current = steps;
    }
    for (const segment of path) {
      if (Array.isArray(current)) {
        const index = Number(segment);
        if (!Number.isInteger(index) || current[index] === undefined) {
          throw new Error(`Graph expression ${expression} is unresolved`);
        }
        current = current[index]!;
      } else if (isJsonObject(current) && current[segment] !== undefined) {
        current = current[segment]!;
      } else {
        throw new Error(`Graph expression ${expression} is unresolved`);
      }
    }
    return asJsonValue(current);
  }

  async #withTimeout<T>(
    node: GraphNode,
    parentSignal: AbortSignal,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const signal = AbortSignal.any([parentSignal, controller.signal]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (node.timeoutMs !== undefined) {
      timer = setTimeout(
        () => controller.abort(new GraphTimeoutError(node.id, node.timeoutMs!)),
        node.timeoutMs,
      );
    }
    try {
      return await new Promise<T>((resolve, reject) => {
        let settled = false;
        const finish = (error?: unknown, value?: T): void => {
          if (settled) {
            return;
          }
          settled = true;
          signal.removeEventListener("abort", onAbort);
          if (error !== undefined) {
            reject(error);
          } else {
            resolve(value as T);
          }
        };
        const onAbort = (): void => finish(abortReason(signal));
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) {
          onAbort();
          return;
        }
        void operation(signal).then(
          (value) => finish(undefined, value),
          (error: unknown) => finish(error),
        );
      });
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  async #complete(
    record: InstanceRecord,
    output: GraphJson | undefined,
  ): Promise<void> {
    if (this.#isTerminal(record)) {
      return;
    }
    assertJsonSchema(
      record.instance.variables,
      record.definition.variablesSchema,
      `Graph ${record.definition.id} variables`,
    );
    const completedAt = new Date().toISOString();
    record.instance.status = "completed";
    if (output !== undefined) {
      record.instance.output = output;
    }
    delete record.instance.error;
    record.instance.completedAt = completedAt;
    record.instance.updatedAt = completedAt;
    await this.#persistInstance(record);
    await this.context.bus.emit(graphInstanceUpdated, {
      instance: record.instance,
    });
    await this.context.bus.emit(graphInstanceCompleted, {
      instanceId: record.instance.id,
      graphId: record.instance.graphId,
      ...(record.instance.sessionId
        ? { sessionId: record.instance.sessionId }
        : {}),
      ...(output === undefined ? {} : { output }),
      completedAt,
    });
    record.terminalAnnounced = await this.#appendChat(record, "completed");
    if (record.terminalAnnounced) {
      await this.#persistInstance(record);
    } else {
      this.#spawnTerminalAnnouncement(record);
    }
    await this.#releaseWorkspace(record.instance.id);
  }

  async #fail(record: InstanceRecord, message: string): Promise<void> {
    if (
      record.instance.status === "cancelled" ||
      record.instance.status === "failed" ||
      record.instance.status === "completed"
    ) {
      return;
    }
    const completedAt = new Date().toISOString();
    record.instance.status = "failed";
    this.#executionControllers
      .get(record.instance.id)
      ?.abort(new Error(`Graph ${record.instance.id} failed`));
    record.instance.error = message;
    record.instance.completedAt = completedAt;
    record.instance.updatedAt = completedAt;
    await this.#persistInstance(record);
    await this.context.bus.emit(graphInstanceUpdated, {
      instance: record.instance,
    });
    await this.context.bus.emit(graphInstanceFailed, {
      instanceId: record.instance.id,
      graphId: record.instance.graphId,
      ...(record.instance.sessionId
        ? { sessionId: record.instance.sessionId }
        : {}),
      error: message,
      completedAt,
    });
    record.terminalAnnounced = await this.#appendChat(record, "failed");
    if (record.terminalAnnounced) {
      await this.#persistInstance(record);
    } else {
      this.#spawnTerminalAnnouncement(record);
    }
    if (!this.#activeTasks.has(record.instance.id)) {
      await this.#releaseWorkspace(record.instance.id);
    }
  }

  async #appendChat(
    record: InstanceRecord,
    status: "started" | "completed" | "failed",
  ): Promise<boolean> {
    const sessionId = record.instance.sessionId;
    if (!sessionId) {
      return true;
    }
    if (!this.context.bus.provides(chatAppend)) {
      return false;
    }
    const content =
      status === "started"
        ? `Graph “${record.instance.graphName}” started.`
        : status === "completed"
          ? `Graph “${record.instance.graphName}” completed.`
          : `Graph “${record.instance.graphName}” failed: ${record.instance.error ?? "Unknown error"}`;
    try {
      await this.context.bus.invoke(chatAppend, {
        sessionId,
        entry: {
          role: "event",
          content,
          metadata: {
            graphId: record.instance.graphId,
            instanceId: record.instance.id,
            status,
          },
        },
      });
      return true;
    } catch (error) {
      this.context.logger.warn(
        `Could not append graph ${status} event to chat ${sessionId}`,
        { error: errorMessage(error) },
      );
      return false;
    }
  }

  async #releaseWorkspace(instanceId: string): Promise<void> {
    await this.#disposeToolScope(instanceId);
    await this.context.workspace.release(instanceId).catch((error: unknown) => {
      this.context.logger.warn(
        `Could not release graph workspace ${instanceId}`,
        { error: errorMessage(error) },
      );
    });
  }

  #registerToolScope(record: InstanceRecord): void {
    if (this.#toolScopes.has(record.instance.id)) {
      return;
    }
    const scope = this.context.tools.registerExecutionScope(
      record.instance.id,
      record.instance.id,
      record.definition.permissions ?? ["*"],
    );
    this.#toolScopes.set(record.instance.id, scope);
  }

  async #disposeToolScope(instanceId: string): Promise<void> {
    const scope = this.#toolScopes.get(instanceId);
    this.#toolScopes.delete(instanceId);
    await scope?.dispose();
  }

  async #armDefinitionTrigger(definition: GraphDefinition): Promise<void> {
    await this.#disposeTriggerSchedule(definition.id);
    const trigger = definition.nodes.find(({ type }) => type === "trigger")!;
    if (trigger.kind !== "schedule") {
      await this.context.store
        .delete(`${TRIGGER_CURSOR_PREFIX}${definition.id}`)
        .catch(() => undefined);
      const contribution = this.context.graphs
        .listTriggers()
        .find(({ kind }) => kind === trigger.kind);
      if (contribution) {
        const config = asJsonValue(
          contribution.configSchema.parse(trigger.config),
        );
        const disposable = await contribution.subscribe(
          config,
          async (input = {}) => {
            const graphInput = asJsonValue(input);
            if (!isJsonObject(graphInput)) {
              throw new Error(
                `Custom trigger ${trigger.kind} input must be an object`,
              );
            }
            await this.launch({
              graphId: definition.id,
              input: graphInput,
              trigger: trigger.kind,
            });
          },
          this.context.signal,
        );
        this.#triggerSchedules.set(definition.id, disposable);
      }
      return;
    }
    const everyMs = requireNumber(
      trigger.config,
      ["everyMs"],
      `Schedule interval for ${trigger.id}`,
    );
    const persistedCursor = await this.context.store.get(
      `${TRIGGER_CURSOR_PREFIX}${definition.id}`,
    );
    const cursor = persistedCursor
      ? triggerCursorSchema.parse(persistedCursor)
      : undefined;
    const compatibleCursor =
      cursor?.definitionVersion === definition.version &&
      cursor.everyMs === everyMs
        ? cursor.nextRunAt
        : undefined;
    const nextRunAt =
      compatibleCursor && Date.parse(compatibleCursor) > Date.now()
        ? compatibleCursor
        : compatibleCursor
          ? new Date().toISOString()
          : new Date(Date.now() + everyMs).toISOString();
    await this.#scheduleDefinition(definition, everyMs, nextRunAt);
  }

  async #scheduleDefinition(
    definition: GraphDefinition,
    everyMs: number,
    nextRunAt: string,
  ): Promise<void> {
    if (
      this.#disposed ||
      this.#definitions.get(definition.id)?.version !== definition.version
    ) {
      return;
    }
    const scheduleId = `trigger:${definition.id}`;
    await this.context.store.set(
      `${TRIGGER_CURSOR_PREFIX}${definition.id}`,
      asJsonValue({
        version: 1,
        definitionVersion: definition.version,
        everyMs,
        nextRunAt,
      }),
    );
    const disposable = this.context.scheduler.schedule(
      scheduleId,
      nextRunAt,
      async (signal) => {
        this.#triggerSchedules.delete(definition.id);
        if (signal.aborted || this.#disposed) {
          return;
        }
        try {
          await this.launch({
            graphId: definition.id,
            input: { scheduledAt: nextRunAt },
            trigger: "schedule",
          });
        } catch (error) {
          this.context.logger.error(
            `Scheduled graph ${definition.id} could not launch`,
            { error: errorMessage(error) },
          );
        } finally {
          if (
            !this.#disposed &&
            this.#definitions.get(definition.id)?.version ===
              definition.version
          ) {
            await this.#scheduleDefinition(
              definition,
              everyMs,
              new Date(Date.now() + everyMs).toISOString(),
            );
          }
        }
      },
    );
    this.#triggerSchedules.set(definition.id, disposable);
  }

  async #disposeTriggerSchedule(graphId: string): Promise<void> {
    const disposable = this.#triggerSchedules.get(graphId);
    this.#triggerSchedules.delete(graphId);
    await disposable?.dispose();
    this.context.scheduler.cancel(`trigger:${graphId}`);
  }

  #delayScheduleId(instanceId: string, nodeId: string): string {
    return `delay:${instanceId}:${nodeId}`;
  }

  async #disposeDelay(instanceId: string, nodeId: string): Promise<void> {
    const scheduleId = this.#delayScheduleId(instanceId, nodeId);
    const disposable = this.#delaySchedules.get(scheduleId);
    this.#delaySchedules.delete(scheduleId);
    await disposable?.dispose();
    this.context.scheduler.cancel(scheduleId);
  }

  async #serializeDefinition<T>(
    graphId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous =
      this.#definitionOperations.get(graphId) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(operation);
    const marker = pending.then(
      () => undefined,
      () => undefined,
    );
    this.#definitionOperations.set(graphId, marker);
    try {
      return await pending;
    } finally {
      if (this.#definitionOperations.get(graphId) === marker) {
        this.#definitionOperations.delete(graphId);
      }
    }
  }

  #node(record: InstanceRecord, nodeId: string): GraphNode {
    const node = record.definition.nodes.find(({ id }) => id === nodeId);
    if (!node) {
      throw new Error(`Graph node ${nodeId} is unavailable`);
    }
    return node;
  }

  #state(record: InstanceRecord, nodeId: string): GraphNodeState {
    const state = record.instance.nodeStates.find(
      ({ nodeId: candidate }) => candidate === nodeId,
    );
    if (!state) {
      throw new Error(`Graph node state ${nodeId} is unavailable`);
    }
    return state;
  }
}
