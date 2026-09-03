import {
  graphDefinitionDeleted,
  graphDefinitionSaved,
  graphDefinitionSchema,
  graphInstanceCompleted,
  graphInstanceFailed,
  graphInstanceStarted,
  graphInstanceUpdated,
  graphStepCompleted,
  graphsDeleteDefinition,
  graphsLaunch,
  graphsListContributions,
  graphsListDefinitions,
  graphsListRunning,
  graphsSaveDefinition,
  type GraphDefinition,
  type GraphInstance,
  type GraphNode,
} from "@borg/contracts";
import { defineUiPlugin, type Disposable } from "@borg/plugin-sdk";
import { Button, EmptyState, Panel } from "@borg/ui-kit";
import cytoscape from "cytoscape";
import {
  Activity,
  CircleAlert,
  GitBranch,
  LoaderCircle,
  Play,
  Plus,
  Save,
  Trash2,
  Workflow,
} from "lucide-solid";
import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  type Component,
} from "solid-js";
import { Portal } from "solid-js/web";

type NodeType = GraphNode["type"];

interface PaletteItem {
  readonly kind: string;
  readonly label: string;
  readonly type: NodeType;
}

const ENGINE_ID = "borg.graphs.hivemind-v1";

const builtInKinds = [
  { kind: "manual", label: "Manual", type: "trigger" },
  { kind: "schedule", label: "Schedule", type: "trigger" },
  {
    kind: "incoming_message",
    label: "Incoming message",
    type: "trigger",
  },
  { kind: "call_tool", label: "Call tool", type: "task" },
  { kind: "invoke_agent", label: "Invoke agent", type: "task" },
  { kind: "delay", label: "Delay", type: "task" },
  { kind: "set_variable", label: "Set variable", type: "task" },
  { kind: "invoke_prompt", label: "Invoke prompt", type: "task" },
  { kind: "feedback_gate", label: "Feedback gate", type: "task" },
  { kind: "branch", label: "Branch", type: "control" },
  { kind: "for_each", label: "For each", type: "control" },
  { kind: "end", label: "End", type: "control" },
] as const satisfies readonly PaletteItem[];

const cytoscapeStyles: cytoscape.StylesheetJson = [
  {
    selector: "node",
    style: {
      "background-color": "#334155",
      "border-color": "#64748b",
      "border-width": 2,
      color: "#e2e8f0",
      "font-family": "ui-sans-serif, system-ui, sans-serif",
      "font-size": 11,
      height: 52,
      label: "data(label)",
      "text-halign": "center",
      "text-valign": "center",
      "text-wrap": "wrap",
      width: 132,
    },
  },
  {
    selector: "node.trigger",
    style: {
      "background-color": "#115e59",
      "border-color": "#2dd4bf",
      shape: "round-rectangle",
    },
  },
  {
    selector: "node.task",
    style: {
      "background-color": "#334155",
      "border-color": "#94a3b8",
      shape: "round-rectangle",
    },
  },
  {
    selector: "node.control",
    style: {
      "background-color": "#5b21b6",
      "border-color": "#a78bfa",
      shape: "round-rectangle",
    },
  },
  {
    selector: "node:selected",
    style: {
      "border-color": "#22d3ee",
      "border-width": 4,
      "overlay-color": "#22d3ee",
      "overlay-opacity": 0.08,
      "overlay-padding": 8,
    },
  },
  {
    selector: "edge",
    style: {
      "curve-style": "bezier",
      "line-color": "#64748b",
      "target-arrow-color": "#64748b",
      "target-arrow-shape": "triangle",
      width: 2,
    },
  },
  {
    selector: "edge:selected",
    style: {
      "line-color": "#22d3ee",
      "target-arrow-color": "#22d3ee",
      width: 3,
    },
  },
];

let graphSequence = 0;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cloneDefinition(definition: GraphDefinition): GraphDefinition {
  return structuredClone(definition);
}

function sortDefinitions(
  definitions: readonly GraphDefinition[],
): readonly GraphDefinition[] {
  return [...definitions].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

function formatKind(kind: string): string {
  return (
    builtInKinds.find((item) => item.kind === kind)?.label ??
    kind.replaceAll("_", " ")
  );
}

function defaultConfig(kind: string): GraphNode["config"] {
  switch (kind) {
    case "schedule":
      return { everyMs: 60_000 };
    case "incoming_message":
      return {};
    case "call_tool":
      return { input: { text: "Hello from a graph" }, toolId: "tools.echo" };
    case "invoke_agent":
      return {
        personaId: "system/general",
        prompt: "Complete this graph step.",
      };
    case "delay":
      return { ms: 1_000 };
    case "set_variable":
      return { name: "value", value: "" };
    case "invoke_prompt":
      return { prompt: "Summarize the graph input." };
    case "feedback_gate":
      return { form: "confirm", prompt: "Continue this graph?" };
    case "branch":
      return { condition: "$vars.value" };
    case "for_each":
      return {
        itemVariable: "item",
        items: "$input.items",
        collect: "$vars.item",
        resultVariable: "items",
      };
    case "end":
      return { output: "$vars.result" };
    default:
      return {};
  }
}

function createDefaultGraph(): GraphDefinition {
  graphSequence += 1;
  return {
    id: `graph-${Date.now().toString(36)}-${graphSequence}`,
    name: "Untitled graph",
    version: "1.0.0",
    engineId: ENGINE_ID,
    description: "",
    mode: "chat",
    inputSchema: {},
    variablesSchema: {},
    nodes: [
      {
        id: "manual",
        type: "trigger",
        kind: "manual",
        config: {},
        onError: { action: "fail" },
        designer: { x: 100, y: 180 },
      },
      {
        id: "set-variable",
        type: "task",
        kind: "set_variable",
        config: { name: "result", value: "Ready" },
        onError: { action: "fail" },
        designer: { x: 350, y: 180 },
      },
      {
        id: "end",
        type: "control",
        kind: "end",
        config: { output: "$vars.result" },
        onError: { action: "fail" },
        designer: { x: 600, y: 180 },
      },
    ],
    edges: [
      {
        id: "manual-to-set-variable",
        source: "manual",
        target: "set-variable",
      },
      {
        id: "set-variable-to-end",
        source: "set-variable",
        target: "end",
      },
    ],
  };
}

function nextUniqueId(base: string, ids: ReadonlySet<string>): string {
  if (!ids.has(base)) {
    return base;
  }
  let suffix = 2;
  while (ids.has(`${base}-${suffix}`)) {
    suffix += 1;
  }
  return `${base}-${suffix}`;
}

function isJsonObject(value: unknown): value is GraphNode["config"] {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function graphElements(
  definition: GraphDefinition,
): cytoscape.ElementDefinition[] {
  const fallbackY = 120;
  return [
    ...definition.nodes.map(
      (node, index): cytoscape.ElementDefinition => ({
        group: "nodes",
        data: {
          id: node.id,
          kind: node.kind,
          label: formatKind(node.kind),
          type: node.type,
        },
        classes: node.type,
        position: node.designer ?? {
          x: 140 + index * 210,
          y: fallbackY,
        },
      }),
    ),
    ...definition.edges.map(
      (edge): cytoscape.ElementDefinition => ({
        group: "edges",
        data: {
          id: edge.id,
          source: edge.source,
          sourceHandle: edge.sourceHandle ?? "",
          target: edge.target,
        },
      }),
    ),
  ];
}

function statusLabel(status: GraphInstance["status"]): string {
  switch (status) {
    case "running":
      return "Running";
    case "waiting":
      return "Waiting for input";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
  }
}

export default defineUiPlugin<Component>({
  id: "borg.graphs",
  activate(context) {
    const GraphDesigner: Component = () => {
      const [definitions, setDefinitions] =
        createSignal<readonly GraphDefinition[]>([]);
      const [draft, setDraft] = createSignal<GraphDefinition>();
      const [selectedNodeId, setSelectedNodeId] = createSignal<string>();
      const [selectedKind, setSelectedKind] = createSignal("set_variable");
      const [paletteItems, setPaletteItems] =
        createSignal<readonly PaletteItem[]>(builtInKinds);
      const [configText, setConfigText] = createSignal("");
      const [configError, setConfigError] = createSignal<string>();
      const [edgeSource, setEdgeSource] = createSignal("");
      const [edgeTarget, setEdgeTarget] = createSignal("");
      const [edgeHandle, setEdgeHandle] = createSignal<"true" | "false">(
        "true",
      );
      const [validationErrors, setValidationErrors] =
        createSignal<readonly string[]>([]);
      const [error, setError] = createSignal<string>();
      const [operationStatus, setOperationStatus] = createSignal("");
      const [instanceStatus, setInstanceStatus] =
        createSignal("No graph launched in this view.");
      const [launchedInstanceId, setLaunchedInstanceId] =
        createSignal<string>();
      const [loading, setLoading] = createSignal(true);
      const [saving, setSaving] = createSignal(false);
      const [running, setRunning] = createSignal(false);
      const [isNewDefinition, setIsNewDefinition] = createSignal(false);
      const [dirty, setDirty] = createSignal(false);
      const selectedNode = createMemo(() =>
        draft()?.nodes.find(({ id }) => id === selectedNodeId()),
      );
      const edgeSourceNode = createMemo(() =>
        draft()?.nodes.find(({ id }) => id === edgeSource()),
      );
      const subscriptions: Disposable[] = [];
      let active = true;
      let canvasElement: HTMLDivElement | undefined;
      let graph: cytoscape.Core | undefined;
      let resizeObserver: ResizeObserver | undefined;

      const setSelectedNode = (nodeId?: string): void => {
        setSelectedNodeId(nodeId);
        const node = draft()?.nodes.find(({ id }) => id === nodeId);
        setConfigText(node ? JSON.stringify(node.config, null, 2) : "");
        setConfigError(undefined);
        graph?.nodes().unselect();
        if (nodeId) {
          graph?.$id(nodeId).select();
          if (!edgeSource()) {
            setEdgeSource(nodeId);
          } else if (edgeSource() !== nodeId) {
            setEdgeTarget(nodeId);
          }
        }
      };

      const renderDefinition = (
        definition: GraphDefinition,
        fit = true,
      ): void => {
        if (!graph) {
          return;
        }
        graph.startBatch();
        graph.elements().remove();
        graph.add(graphElements(definition));
        graph.endBatch();
        graph
          .layout({
            name: "preset",
            fit,
            padding: 36,
          })
          .run();
        const selectedId = selectedNodeId();
        if (selectedId && definition.nodes.some(({ id }) => id === selectedId)) {
          graph.$id(selectedId).select();
        }
      };

      const definitionWithCanvasPositions = (
        definition: GraphDefinition,
      ): GraphDefinition => {
        if (!graph) {
          return definition;
        }
        return {
          ...definition,
          nodes: definition.nodes.map((node) => {
            const element = graph?.$id(node.id);
            if (!element || element.length === 0 || !element.isNode()) {
              return node;
            }
            const position = element.position();
            return {
              ...node,
              designer: { x: position.x, y: position.y },
            };
          }),
        };
      };

      const selectDefinition = (
        definition: GraphDefinition,
        isNew = false,
      ): void => {
        const copy = cloneDefinition(definition);
        setDraft(copy);
        setIsNewDefinition(isNew);
        setDirty(isNew);
        setValidationErrors([]);
        setError(undefined);
        setOperationStatus(isNew ? "New graph — save when ready." : "");
        setSelectedNodeId(undefined);
        setConfigText("");
        setConfigError(undefined);
        setEdgeSource(copy.nodes[0]?.id ?? "");
        setEdgeTarget(copy.nodes[1]?.id ?? "");
        renderDefinition(copy);
      };

      const clearDefinition = (): void => {
        setDraft(undefined);
        setSelectedNodeId(undefined);
        setConfigText("");
        setEdgeSource("");
        setEdgeTarget("");
        setEdgeHandle("true");
        setValidationErrors([]);
        graph?.elements().remove();
      };

      const refreshDefinitions = async (): Promise<void> => {
        try {
          const [result, contributionResult] = await Promise.all([
            context.bus.invoke(graphsListDefinitions, {}),
            context.bus.invoke(graphsListContributions, {}),
          ]);
          if (!active) {
            return;
          }
          const next = sortDefinitions(result.definitions);
          const builtIn = new Set<string>(
            builtInKinds.map(({ kind }) => kind),
          );
          setPaletteItems([
            ...builtInKinds,
            ...contributionResult.contributions.filter(
              ({ kind }) => !builtIn.has(kind),
            ),
          ]);
          setDefinitions(next);
          const current = draft();
          if (!current) {
            const first = next[0];
            if (first) {
              selectDefinition(first);
            }
            return;
          }
          if (isNewDefinition()) {
            return;
          }
          const refreshed = next.find(({ id }) => id === current.id);
          if (!refreshed) {
            const first = next[0];
            if (first) {
              selectDefinition(first);
            } else {
              clearDefinition();
            }
          } else if (!dirty()) {
            const status = operationStatus();
            selectDefinition(refreshed);
            setOperationStatus(status);
          }
        } catch (failure) {
          if (active) {
            setError(describeError(failure));
          }
        }
      };

      const refreshRunning = async (): Promise<void> => {
        try {
          const result = await context.bus.invoke(graphsListRunning, {});
          if (!active) {
            return;
          }
          const launchedId = launchedInstanceId();
          const currentGraphId = draft()?.id;
          const instance =
            result.instances.find(({ id }) => id === launchedId) ??
            result.instances.find(({ graphId }) => graphId === currentGraphId);
          if (instance) {
            setLaunchedInstanceId(instance.id);
            setInstanceStatus(
              `${instance.graphName}: ${statusLabel(instance.status)}`,
            );
          }
        } catch (failure) {
          if (active) {
            setError(describeError(failure));
          }
        }
      };

      const trackSubscription = async (
        subscription: Promise<Disposable>,
      ): Promise<void> => {
        const disposable = await subscription;
        if (active) {
          subscriptions.push(disposable);
        } else {
          await disposable.dispose();
        }
      };

      const subscribeToDeltas = (): void => {
        void trackSubscription(
          context.bus.on(graphDefinitionSaved, () => refreshDefinitions()),
        );
        void trackSubscription(
          context.bus.on(graphDefinitionDeleted, () => refreshDefinitions()),
        );
        void trackSubscription(
          context.bus.on(graphInstanceStarted, ({ instance }) => {
            if (instance.graphId === draft()?.id) {
              setLaunchedInstanceId(instance.id);
              setInstanceStatus(
                `${instance.graphName}: ${statusLabel(instance.status)}`,
              );
            }
            void refreshRunning();
          }),
        );
        void trackSubscription(
          context.bus.on(graphInstanceUpdated, ({ instance }) => {
            if (
              instance.id === launchedInstanceId() ||
              instance.graphId === draft()?.id
            ) {
              setLaunchedInstanceId(instance.id);
              setInstanceStatus(
                `${instance.graphName}: ${statusLabel(instance.status)}`,
              );
            }
            void refreshRunning();
          }),
        );
        void trackSubscription(
          context.bus.on(graphInstanceCompleted, ({ instanceId, graphId }) => {
            if (
              instanceId === launchedInstanceId() ||
              graphId === draft()?.id
            ) {
              setInstanceStatus("Graph completed.");
            }
            void refreshRunning();
          }),
        );
        void trackSubscription(
          context.bus.on(
            graphInstanceFailed,
            ({ instanceId, graphId, error: instanceError }) => {
              if (
                instanceId === launchedInstanceId() ||
                graphId === draft()?.id
              ) {
                setInstanceStatus(`Graph failed: ${instanceError}`);
              }
              void refreshRunning();
            },
          ),
        );
        void trackSubscription(
          context.bus.on(graphStepCompleted, ({ instanceId }) => {
            if (instanceId === launchedInstanceId()) {
              void refreshRunning();
            }
          }),
        );
      };

      const initializeCanvas = (element: HTMLDivElement): void => {
        canvasElement = element;
        if (graph?.container() === element) {
          return;
        }
        resizeObserver?.disconnect();
        graph?.destroy();
        graph = cytoscape({
          container: canvasElement,
          elements: [],
          layout: { name: "preset" },
          minZoom: 0.2,
          maxZoom: 2.5,
          style: cytoscapeStyles,
          wheelSensitivity: 0.2,
        });
        graph.on(
          "tap",
          "node",
          (event: cytoscape.EventObjectNode): void => {
            setSelectedNode(event.target.id());
          },
        );
        graph.on("tap", (event: cytoscape.EventObject): void => {
          if (event.target === graph) {
            setSelectedNode(undefined);
          }
        });
        if (typeof ResizeObserver !== "undefined") {
          resizeObserver = new ResizeObserver(() => graph?.resize());
          resizeObserver.observe(canvasElement);
        }
        const current = draft();
        if (current) {
          renderDefinition(current);
        }
      };

      onMount(() => {
        subscribeToDeltas();
        void Promise.all([refreshDefinitions(), refreshRunning()]).finally(() => {
          if (active) {
            setLoading(false);
          }
        });
      });

      onCleanup(() => {
        active = false;
        resizeObserver?.disconnect();
        graph?.destroy();
        graph = undefined;
        for (const subscription of subscriptions) {
          void subscription.dispose();
        }
      });

      const updateConfig = (text: string): void => {
        setConfigText(text);
        const nodeId = selectedNodeId();
        if (!nodeId) {
          return;
        }
        try {
          const parsed = JSON.parse(text) as unknown;
          if (!isJsonObject(parsed)) {
            throw new Error("Config must be a JSON object.");
          }
          setDraft((current) =>
            current
              ? {
                  ...current,
                  nodes: current.nodes.map((node) =>
                    node.id === nodeId ? { ...node, config: parsed } : node,
                  ),
                }
              : current,
          );
          setConfigError(undefined);
          setDirty(true);
        } catch (failure) {
          setConfigError(describeError(failure));
        }
      };

      const addNode = (): void => {
        const current = draft();
        const paletteItem = paletteItems().find(
          ({ kind }) => kind === selectedKind(),
        );
        if (!current || !paletteItem) {
          return;
        }
        const positioned = definitionWithCanvasPositions(current);
        const ids = new Set(positioned.nodes.map(({ id }) => id));
        const base = paletteItem.kind.replaceAll("_", "-");
        const id = nextUniqueId(base, ids);
        const selectedElement = selectedNodeId()
          ? graph?.$id(selectedNodeId() ?? "")
          : undefined;
        const selectedPosition =
          selectedElement && selectedElement.length > 0
            ? selectedElement.position()
            : undefined;
        const next: GraphDefinition = {
          ...positioned,
          nodes: [
            ...positioned.nodes,
            {
              id,
              type: paletteItem.type,
              kind: paletteItem.kind,
              config: defaultConfig(paletteItem.kind),
              onError: { action: "fail" },
              designer: selectedPosition
                ? {
                    x: selectedPosition.x + 200,
                    y: selectedPosition.y + 90,
                  }
                : {
                    x: 140 + positioned.nodes.length * 70,
                    y: 130 + positioned.nodes.length * 55,
                  },
            },
          ],
        };
        setDraft(next);
        setDirty(true);
        renderDefinition(next, false);
        setSelectedNode(id);
        setOperationStatus(`${paletteItem.label} step added.`);
      };

      const removeSelectedNode = (): void => {
        const current = draft();
        const nodeId = selectedNodeId();
        if (!current || !nodeId) {
          return;
        }
        const positioned = definitionWithCanvasPositions(current);
        const next: GraphDefinition = {
          ...positioned,
          nodes: positioned.nodes.filter(({ id }) => id !== nodeId),
          edges: positioned.edges.filter(
            ({ source, target }) => source !== nodeId && target !== nodeId,
          ),
        };
        setDraft(next);
        setDirty(true);
        setSelectedNodeId(undefined);
        setConfigText("");
        setEdgeSource(next.nodes[0]?.id ?? "");
        setEdgeTarget(next.nodes[1]?.id ?? "");
        renderDefinition(next);
        setOperationStatus(`Removed ${nodeId}.`);
      };

      const addEdge = (): void => {
        const current = draft();
        const source = edgeSource();
        const target = edgeTarget();
        const sourceHandle =
          current?.nodes.find(({ id }) => id === source)?.kind === "branch"
            ? edgeHandle()
            : undefined;
        if (!current || !source || !target) {
          setOperationStatus("Choose a source and target step.");
          return;
        }
        if (source === target) {
          setOperationStatus("An edge must connect two different steps.");
          return;
        }
        if (
          current.edges.some(
            (edge) =>
              edge.source === source &&
              edge.target === target &&
              edge.sourceHandle === sourceHandle,
          )
        ) {
          setOperationStatus("That edge already exists.");
          return;
        }
        const positioned = definitionWithCanvasPositions(current);
        const edgeIds = new Set(positioned.edges.map(({ id }) => id));
        const edgeId = nextUniqueId(`${source}-to-${target}`, edgeIds);
        const next: GraphDefinition = {
          ...positioned,
          edges: [
            ...positioned.edges,
            {
              id: edgeId,
              source,
              target,
              ...(sourceHandle ? { sourceHandle } : {}),
            },
          ],
        };
        setDraft(next);
        setDirty(true);
        renderDefinition(next, false);
        setOperationStatus(`Connected ${source} to ${target}.`);
      };

      const removeEdge = (edgeId: string): void => {
        const current = draft();
        if (!current) {
          return;
        }
        const positioned = definitionWithCanvasPositions(current);
        const next: GraphDefinition = {
          ...positioned,
          edges: positioned.edges.filter(({ id }) => id !== edgeId),
        };
        setDraft(next);
        setDirty(true);
        renderDefinition(next, false);
        setOperationStatus("Edge removed.");
      };

      const prepareDefinition = (): GraphDefinition | undefined => {
        const current = draft();
        if (!current) {
          setValidationErrors(["Create or select a graph first."]);
          return undefined;
        }
        let candidate = definitionWithCanvasPositions(current);
        const nodeId = selectedNodeId();
        if (nodeId) {
          try {
            const parsedConfig = JSON.parse(configText()) as unknown;
            if (!isJsonObject(parsedConfig)) {
              throw new Error("Config must be a JSON object.");
            }
            candidate = {
              ...candidate,
              nodes: candidate.nodes.map((node) =>
                node.id === nodeId
                  ? { ...node, config: parsedConfig }
                  : node,
              ),
            };
            setConfigError(undefined);
          } catch (failure) {
            const message = describeError(failure);
            setConfigError(message);
            setValidationErrors([`Selected node config: ${message}`]);
            return undefined;
          }
        }
        const parsed = graphDefinitionSchema.safeParse(candidate);
        if (!parsed.success) {
          setValidationErrors(
            parsed.error.issues.map((issue) => {
              const path = issue.path.map(String).join(".");
              return path ? `${path}: ${issue.message}` : issue.message;
            }),
          );
          return undefined;
        }
        setValidationErrors([]);
        setDraft(parsed.data);
        return parsed.data;
      };

      const upsertDefinition = (definition: GraphDefinition): void => {
        setDefinitions((current) =>
          sortDefinitions([
            definition,
            ...current.filter(({ id }) => id !== definition.id),
          ]),
        );
      };

      const save = async (): Promise<GraphDefinition | undefined> => {
        const candidate = prepareDefinition();
        if (!candidate || saving()) {
          return undefined;
        }
        setSaving(true);
        setError(undefined);
        setOperationStatus("Saving…");
        try {
          const result = await context.bus.invoke(graphsSaveDefinition, {
            definition: candidate,
          });
          if (!active) {
            return undefined;
          }
          const saved = cloneDefinition(result.definition);
          setDraft(saved);
          setIsNewDefinition(false);
          setDirty(false);
          upsertDefinition(saved);
          renderDefinition(saved, false);
          setOperationStatus("Graph saved.");
          return saved;
        } catch (failure) {
          if (active) {
            setError(describeError(failure));
            setOperationStatus("Save failed.");
          }
          return undefined;
        } finally {
          if (active) {
            setSaving(false);
          }
        }
      };

      const run = async (): Promise<void> => {
        if (running()) {
          return;
        }
        const candidate = prepareDefinition();
        if (!candidate) {
          return;
        }
        setRunning(true);
        setError(undefined);
        setOperationStatus("Saving before launch…");
        try {
          const saved = await context.bus.invoke(graphsSaveDefinition, {
            definition: candidate,
          });
          if (!active) {
            return;
          }
          setDraft(cloneDefinition(saved.definition));
          setIsNewDefinition(false);
          setDirty(false);
          upsertDefinition(saved.definition);
          const result = await context.bus.invoke(graphsLaunch, {
            graphId: saved.definition.id,
            input: {},
            trigger: "manual",
          });
          if (!active) {
            return;
          }
          setLaunchedInstanceId(result.instanceId);
          setInstanceStatus(`${saved.definition.name}: Running`);
          setOperationStatus("Graph launched.");
          void refreshRunning();
        } catch (failure) {
          if (active) {
            setError(describeError(failure));
            setOperationStatus("Launch failed.");
          }
        } finally {
          if (active) {
            setRunning(false);
          }
        }
      };

      const selectAfterDiscardCheck = (
        definition: GraphDefinition,
        isNew = false,
      ): void => {
        if (
          dirty() &&
          !isNew &&
          !isNewDefinition() &&
          draft()?.id === definition.id
        ) {
          return;
        }
        const changesWouldBeLost = dirty();
        if (
          changesWouldBeLost &&
          !globalThis.confirm(
            "Discard your unsaved graph changes?",
          )
        ) {
          return;
        }
        selectDefinition(definition, isNew);
      };

      return (
        <section
          class="h-full min-h-0 overflow-hidden bg-[var(--panel)]"
          data-testid="graph-designer"
        >
          <div class="grid h-full min-h-0 grid-cols-[14rem_minmax(28rem,1fr)_20rem]">
            <aside class="flex min-h-0 flex-col border-r border-[var(--border)] bg-[var(--panel-muted)]/45 p-3">
              <Button
                type="button"
                class="w-full"
                onClick={() =>
                  selectAfterDiscardCheck(createDefaultGraph(), true)
                }
                data-testid="graph-create"
              >
                <Plus aria-hidden="true" size={16} />
                Create graph
              </Button>
              <div
                class="mt-3 grid min-h-0 gap-1 overflow-y-auto"
                data-testid="graph-list"
              >
                <Show
                  when={!loading()}
                  fallback={
                    <div class="flex items-center justify-center gap-2 px-3 py-6 text-xs text-[var(--text-muted)]">
                      <LoaderCircle
                        aria-hidden="true"
                        class="animate-spin"
                        size={15}
                      />
                      Loading graphs…
                    </div>
                  }
                >
                  <For
                    each={definitions()}
                    fallback={
                      <p class="px-3 py-6 text-center text-xs leading-5 text-[var(--text-subtle)]">
                        No saved graphs yet. Create one to start with a useful
                        three-step flow.
                      </p>
                    }
                  >
                    {(definition) => (
                      <button
                        type="button"
                        class="w-full rounded-xl px-3 py-2.5 text-left text-sm transition hover:bg-[var(--panel)]"
                        classList={{
                          "bg-[var(--panel)] text-[var(--accent)]":
                            draft()?.id === definition.id &&
                            !isNewDefinition(),
                        }}
                        onClick={() => selectAfterDiscardCheck(definition)}
                        data-testid={`graph-list-item-${definition.id}`}
                      >
                        <span class="block truncate font-medium">
                          {definition.name}
                        </span>
                        <span class="mt-1 block text-[10px] uppercase tracking-wider text-[var(--text-subtle)]">
                          {definition.mode} · {definition.nodes.length} steps
                        </span>
                      </button>
                    )}
                  </For>
                </Show>
              </div>
            </aside>

            <main class="flex min-w-0 flex-col">
              <Show
                when={draft()}
                fallback={
                  <EmptyState
                    eyebrow="Graph designer"
                    title="Build a reusable workflow"
                    description="Create a graph or choose a saved definition. Graphs can be launched from chat and continue safely in the background."
                    class="my-auto"
                  >
                    <Button
                      type="button"
                      class="mt-6"
                      onClick={() =>
                        selectDefinition(createDefaultGraph(), true)
                      }
                    >
                      <Plus aria-hidden="true" size={16} />
                      Create graph
                    </Button>
                  </EmptyState>
                }
              >
                {(current) => (
                  <>
                    <header class="border-b border-[var(--border)] px-5 py-3">
                      <div class="flex items-start gap-3">
                        <div class="min-w-0 flex-1">
                          <label class="sr-only" for="graph-name">
                            Graph name
                          </label>
                          <input
                            id="graph-name"
                            value={current().name}
                            onInput={(event) => {
                              const name = event.currentTarget.value;
                              setDraft((definition) =>
                                definition ? { ...definition, name } : definition,
                              );
                              setDirty(true);
                            }}
                            class="w-full border-0 bg-transparent text-lg font-semibold outline-none placeholder:text-[var(--text-subtle)]"
                            placeholder="Graph name"
                            data-testid="graph-name"
                          />
                          <label class="sr-only" for="graph-description">
                            Graph description
                          </label>
                          <input
                            id="graph-description"
                            value={current().description ?? ""}
                            onInput={(event) => {
                              const description = event.currentTarget.value;
                              setDraft((definition) =>
                                definition
                                  ? { ...definition, description }
                                  : definition,
                              );
                              setDirty(true);
                            }}
                            class="mt-1 w-full border-0 bg-transparent text-xs text-[var(--text-muted)] outline-none placeholder:text-[var(--text-subtle)]"
                            placeholder="Describe when this graph should be used"
                            data-testid="graph-description"
                          />
                        </div>
                        <label class="flex items-center gap-2 text-xs text-[var(--text-muted)]">
                          Mode
                          <select
                            value={current().mode}
                            onChange={(event) => {
                              const mode = event.currentTarget.value;
                              if (mode !== "chat" && mode !== "background") {
                                return;
                              }
                              setDraft((definition) =>
                                definition ? { ...definition, mode } : definition,
                              );
                              setDirty(true);
                            }}
                            class="rounded-lg border border-[var(--border)] bg-[var(--background)] px-2 py-1.5 text-xs text-[var(--text)]"
                          >
                            <option value="chat">Chat</option>
                            <option value="background">Background</option>
                          </select>
                        </label>
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          disabled={saving() || running()}
                          onClick={() => void save()}
                          data-testid="graph-save"
                        >
                          <Save aria-hidden="true" size={15} />
                          {saving() ? "Saving…" : "Save"}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          disabled={saving() || running()}
                          onClick={() => void run()}
                          data-testid="graph-run"
                        >
                          <Play aria-hidden="true" size={15} />
                          {running() ? "Launching…" : "Run"}
                        </Button>
                      </div>
                    </header>

                    <div class="relative min-h-0 flex-1 bg-[#0b1120]">
                      <div
                        ref={(element) => {
                          initializeCanvas(element);
                        }}
                        class="absolute inset-0"
                        aria-label="Graph canvas"
                        data-testid="graph-canvas"
                      />
                      <div class="pointer-events-none absolute bottom-3 left-3 rounded-lg border border-slate-700 bg-slate-950/80 px-3 py-2 text-[10px] text-slate-400">
                        Drag steps to arrange · Scroll to zoom · Select a step
                        to edit
                      </div>
                    </div>

                    <footer class="border-t border-[var(--border)] bg-[var(--panel-muted)]/25 px-5 py-2.5">
                      <Show when={error()}>
                        {(message) => (
                          <p
                            class="mb-2 flex items-center gap-2 text-xs text-[var(--danger)]"
                            role="alert"
                          >
                            <CircleAlert aria-hidden="true" size={14} />
                            {message()}
                          </p>
                        )}
                      </Show>
                      <div
                        class="text-xs text-[var(--danger)]"
                        data-testid="graph-validation-errors"
                        role={validationErrors().length > 0 ? "alert" : undefined}
                      >
                        <For each={validationErrors()}>
                          {(message) => <p>{message}</p>}
                        </For>
                      </div>
                      <div class="flex items-center justify-between gap-4">
                        <p class="truncate text-xs text-[var(--text-muted)]">
                          {operationStatus() ||
                            (dirty() ? "Unsaved changes" : "Up to date")}
                        </p>
                        <p
                          class="truncate text-xs text-[var(--text-muted)]"
                          data-testid="graph-instance-status"
                        >
                          {instanceStatus()}
                        </p>
                      </div>
                    </footer>
                  </>
                )}
              </Show>
            </main>

            <aside class="min-h-0 overflow-y-auto border-l border-[var(--border)] bg-[var(--panel-muted)]/35 p-4">
              <section>
                <div class="flex items-center gap-2">
                  <Plus
                    aria-hidden="true"
                    size={16}
                    class="text-[var(--accent)]"
                  />
                  <h3 class="text-sm font-semibold">Add step</h3>
                </div>
                <div class="mt-3 grid gap-2">
                  <select
                    value={selectedKind()}
                    onChange={(event) =>
                      setSelectedKind(event.currentTarget.value)
                    }
                    class="w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-xs"
                    data-testid="graph-node-kind"
                  >
                    <optgroup label="Triggers">
                      <For
                        each={paletteItems().filter(
                          ({ type }) => type === "trigger",
                        )}
                      >
                        {(item) => (
                          <option value={item.kind}>{item.label}</option>
                        )}
                      </For>
                    </optgroup>
                    <optgroup label="Tasks">
                      <For
                        each={paletteItems().filter(
                          ({ type }) => type === "task",
                        )}
                      >
                        {(item) => (
                          <option value={item.kind}>{item.label}</option>
                        )}
                      </For>
                    </optgroup>
                    <optgroup label="Controls">
                      <For
                        each={paletteItems().filter(
                          ({ type }) => type === "control",
                        )}
                      >
                        {(item) => (
                          <option value={item.kind}>{item.label}</option>
                        )}
                      </For>
                    </optgroup>
                  </select>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    class="w-full"
                    disabled={!draft()}
                    onClick={addNode}
                    data-testid="graph-add-node"
                  >
                    Add selected step
                  </Button>
                </div>
              </section>

              <section class="mt-5 border-t border-[var(--border)] pt-5">
                <div class="flex items-center gap-2">
                  <GitBranch
                    aria-hidden="true"
                    size={16}
                    class="text-[var(--accent)]"
                  />
                  <h3 class="text-sm font-semibold">Connect steps</h3>
                </div>
                <label class="mt-3 block text-[10px] font-medium uppercase tracking-wider text-[var(--text-subtle)]">
                  Source
                  <select
                    value={edgeSource()}
                    onChange={(event) =>
                      setEdgeSource(event.currentTarget.value)
                    }
                    class="mt-1.5 w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-2.5 py-2 text-xs normal-case tracking-normal text-[var(--text)]"
                  >
                    <For each={draft()?.nodes ?? []}>
                      {(node) => <option value={node.id}>{node.id}</option>}
                    </For>
                  </select>
                </label>
                <label class="mt-2 block text-[10px] font-medium uppercase tracking-wider text-[var(--text-subtle)]">
                  Target
                  <select
                    value={edgeTarget()}
                    onChange={(event) =>
                      setEdgeTarget(event.currentTarget.value)
                    }
                    class="mt-1.5 w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-2.5 py-2 text-xs normal-case tracking-normal text-[var(--text)]"
                  >
                    <For each={draft()?.nodes ?? []}>
                      {(node) => <option value={node.id}>{node.id}</option>}
                    </For>
                  </select>
                </label>
                <Show when={edgeSourceNode()?.kind === "branch"}>
                  <label class="mt-2 block text-[10px] font-medium uppercase tracking-wider text-[var(--text-subtle)]">
                    Branch outcome
                    <select
                      value={edgeHandle()}
                      onChange={(event) =>
                        setEdgeHandle(
                          event.currentTarget.value as "true" | "false",
                        )
                      }
                      class="mt-1.5 w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-2.5 py-2 text-xs normal-case tracking-normal text-[var(--text)]"
                      data-testid="graph-edge-handle"
                    >
                      <option value="true">Condition is true</option>
                      <option value="false">Condition is false</option>
                    </select>
                  </label>
                </Show>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  class="mt-2 w-full"
                  disabled={!draft()}
                  onClick={addEdge}
                  data-testid="graph-add-edge"
                >
                  Add edge
                </Button>
                <div class="mt-3 grid gap-1.5">
                  <For each={draft()?.edges ?? []}>
                    {(edge) => (
                      <div class="flex items-center gap-2 rounded-lg border border-[var(--border)] px-2 py-1.5">
                        <span class="min-w-0 flex-1 truncate text-[10px] text-[var(--text-muted)]">
                          {edge.source}
                          {edge.sourceHandle
                            ? ` (${edge.sourceHandle})`
                            : ""}{" "}
                          → {edge.target}
                        </span>
                        <button
                          type="button"
                          class="rounded p-1 text-[var(--text-subtle)] hover:bg-[var(--danger)]/10 hover:text-[var(--danger)]"
                          aria-label={`Remove edge ${edge.source} to ${edge.target}`}
                          onClick={() => removeEdge(edge.id)}
                        >
                          <Trash2 aria-hidden="true" size={12} />
                        </button>
                      </div>
                    )}
                  </For>
                </div>
              </section>

              <section
                class="mt-5 border-t border-[var(--border)] pt-5"
                data-testid="graph-node-inspector"
              >
                <div class="flex items-center gap-2">
                  <Workflow
                    aria-hidden="true"
                    size={16}
                    class="text-[var(--accent)]"
                  />
                  <h3 class="text-sm font-semibold">Step inspector</h3>
                </div>
                <div
                  class="mt-3 flex flex-wrap gap-1.5"
                  aria-label="Graph steps"
                >
                  <For each={draft()?.nodes ?? []}>
                    {(node) => (
                      <button
                        type="button"
                        class="rounded-lg border border-[var(--border)] px-2 py-1 text-[10px] text-[var(--text-muted)] hover:border-[var(--accent)] hover:text-[var(--text)]"
                        classList={{
                          "border-[var(--accent)] text-[var(--accent)]":
                            selectedNodeId() === node.id,
                        }}
                        aria-pressed={selectedNodeId() === node.id}
                        onClick={() => setSelectedNode(node.id)}
                        data-testid={`graph-node-option-${node.id}`}
                      >
                        {node.id}
                      </button>
                    )}
                  </For>
                </div>
                <Show
                  when={selectedNode()}
                  fallback={
                    <p class="mt-3 text-xs leading-5 text-[var(--text-subtle)]">
                      Select a step above or on the canvas to inspect its ID and
                      edit its configuration.
                    </p>
                  }
                >
                  {(node) => (
                    <>
                      <dl class="mt-3 grid gap-2 text-xs">
                        <div>
                          <dt class="text-[10px] uppercase tracking-wider text-[var(--text-subtle)]">
                            Selected node ID
                          </dt>
                          <dd
                            class="mt-1 break-all font-mono text-[var(--text)]"
                            data-testid="graph-selected-node-id"
                          >
                            {node().id}
                          </dd>
                        </div>
                        <div class="grid grid-cols-2 gap-2">
                          <div>
                            <dt class="text-[10px] uppercase tracking-wider text-[var(--text-subtle)]">
                              Kind
                            </dt>
                            <dd class="mt-1">{formatKind(node().kind)}</dd>
                          </div>
                          <div>
                            <dt class="text-[10px] uppercase tracking-wider text-[var(--text-subtle)]">
                              Type
                            </dt>
                            <dd class="mt-1 capitalize">{node().type}</dd>
                          </div>
                        </div>
                      </dl>
                      <label class="mt-4 block text-[10px] font-medium uppercase tracking-wider text-[var(--text-subtle)]">
                        Config JSON
                        <textarea
                          value={configText()}
                          onInput={(event) =>
                            updateConfig(event.currentTarget.value)
                          }
                          rows={9}
                          spellcheck={false}
                          class="mt-1.5 w-full resize-y rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2 font-mono text-[11px] leading-5 normal-case tracking-normal text-[var(--text)] outline-none focus:border-[var(--accent)]"
                          classList={{
                            "border-[var(--danger)]": Boolean(configError()),
                          }}
                          data-testid="graph-node-config"
                        />
                      </label>
                      <Show when={configError()}>
                        {(message) => (
                          <p class="mt-2 text-xs text-[var(--danger)]" role="alert">
                            {message()}
                          </p>
                        )}
                      </Show>
                      <Button
                        type="button"
                        variant="danger"
                        size="sm"
                        class="mt-3 w-full"
                        onClick={removeSelectedNode}
                      >
                        <Trash2 aria-hidden="true" size={14} />
                        Remove step
                      </Button>
                    </>
                  )}
                </Show>
              </section>
            </aside>
          </div>
        </section>
      );
    };

    const RunningGraphs: Component = () => {
      const [instances, setInstances] =
        createSignal<readonly GraphInstance[]>([]);
      const [loading, setLoading] = createSignal(true);
      const [error, setError] = createSignal<string>();
      const subscriptions: Disposable[] = [];
      let active = true;

      const refresh = async (): Promise<void> => {
        try {
          const result = await context.bus.invoke(graphsListRunning, {});
          if (active) {
            setInstances(
              [...result.instances].sort((left, right) =>
                right.updatedAt.localeCompare(left.updatedAt),
              ),
            );
            setError(undefined);
          }
        } catch (failure) {
          if (active) {
            setError(describeError(failure));
          }
        } finally {
          if (active) {
            setLoading(false);
          }
        }
      };

      const track = async (
        subscription: Promise<Disposable>,
      ): Promise<void> => {
        const disposable = await subscription;
        if (active) {
          subscriptions.push(disposable);
        } else {
          await disposable.dispose();
        }
      };

      onMount(() => {
        for (const event of [
          graphInstanceStarted,
          graphInstanceUpdated,
          graphInstanceCompleted,
          graphInstanceFailed,
          graphStepCompleted,
        ] as const) {
          void track(context.bus.on(event, () => refresh()));
        }
        void refresh();
      });

      onCleanup(() => {
        active = false;
        for (const subscription of subscriptions) {
          void subscription.dispose();
        }
      });

      return (
        <Panel data-testid="flightdeck-running-graphs">
          <div class="flex items-start justify-between gap-4">
            <div class="flex items-center gap-3">
              <div class="rounded-xl bg-[var(--accent)]/10 p-2 text-[var(--accent)]">
                <Activity aria-hidden="true" size={19} />
              </div>
              <div>
                <p class="text-sm font-semibold">Running graphs</p>
                <p class="text-xs text-[var(--text-muted)]">
                  <span data-testid="flightdeck-graph-count">
                    {instances().length}
                  </span>{" "}
                  running or waiting
                </p>
              </div>
            </div>
            <Show when={loading()}>
              <LoaderCircle
                aria-label="Loading running graphs"
                class="animate-spin text-[var(--text-subtle)]"
                size={16}
              />
            </Show>
          </div>
          <Show when={error()}>
            {(message) => (
              <p class="mt-4 text-xs text-[var(--danger)]" role="alert">
                {message()}
              </p>
            )}
          </Show>
          <Show when={!loading() && !error() && instances().length === 0}>
            <p class="mt-4 border-t border-[var(--border)] pt-4 text-xs text-[var(--text-subtle)]">
              No graphs are running. Launch one from the designer or chat.
            </p>
          </Show>
          <For each={instances()}>
            {(instance) => (
              <div class="mt-3 flex items-center justify-between gap-3 rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2.5">
                <div class="min-w-0">
                  <p class="truncate text-xs font-semibold">
                    {instance.graphName}
                  </p>
                  <p class="mt-1 truncate font-mono text-[10px] text-[var(--text-subtle)]">
                    {instance.id}
                  </p>
                </div>
                <span
                  class="shrink-0 rounded-full px-2 py-1 text-[10px] font-medium"
                  classList={{
                    "bg-[var(--accent)]/10 text-[var(--accent)]":
                      instance.status === "running",
                    "bg-amber-500/10 text-amber-300":
                      instance.status === "waiting",
                  }}
                >
                  {statusLabel(instance.status)}
                </span>
              </div>
            )}
          </For>
        </Panel>
      );
    };

    const GraphSettings: Component = () => {
      const [definitions, setDefinitions] =
        createSignal<readonly GraphDefinition[]>([]);
      const [deleteCandidate, setDeleteCandidate] =
        createSignal<GraphDefinition>();
      const [loading, setLoading] = createSignal(true);
      const [deleting, setDeleting] = createSignal(false);
      const [error, setError] = createSignal<string>();
      const subscriptions: Disposable[] = [];
      let active = true;
      let deleteTrigger: HTMLButtonElement | undefined;
      let deleteCancelButton: HTMLButtonElement | undefined;
      let deleteConfirmButton: HTMLButtonElement | undefined;
      let settingsRoot: HTMLElement | undefined;

      const closeDeleteDialog = (restoreFocus = true): void => {
        setDeleteCandidate(undefined);
        if (restoreFocus) {
          queueMicrotask(() => deleteTrigger?.focus());
        } else {
          queueMicrotask(() => settingsRoot?.focus());
        }
      };

      createEffect(() => {
        if (deleteCandidate()) {
          queueMicrotask(() => deleteCancelButton?.focus());
        }
      });

      const refresh = async (): Promise<void> => {
        try {
          const result = await context.bus.invoke(graphsListDefinitions, {});
          if (active) {
            setDefinitions(sortDefinitions(result.definitions));
            setError(undefined);
          }
        } catch (failure) {
          if (active) {
            setError(describeError(failure));
          }
        } finally {
          if (active) {
            setLoading(false);
          }
        }
      };

      const track = async (
        subscription: Promise<Disposable>,
      ): Promise<void> => {
        const disposable = await subscription;
        if (active) {
          subscriptions.push(disposable);
        } else {
          await disposable.dispose();
        }
      };

      onMount(() => {
        void track(context.bus.on(graphDefinitionSaved, () => refresh()));
        void track(
          context.bus.on(graphDefinitionDeleted, ({ graphId }) => {
            if (deleteCandidate()?.id === graphId) {
              setDeleteCandidate(undefined);
            }
            void refresh();
          }),
        );
        void refresh();
      });

      onCleanup(() => {
        active = false;
        for (const subscription of subscriptions) {
          void subscription.dispose();
        }
      });

      const deleteDefinition = async (
        definition: GraphDefinition,
      ): Promise<void> => {
        if (deleting()) {
          return;
        }
        setDeleting(true);
        setError(undefined);
        try {
          await context.bus.invoke(graphsDeleteDefinition, {
            graphId: definition.id,
          });
          if (active) {
            closeDeleteDialog(false);
            await refresh();
          }
        } catch (failure) {
          if (active) {
            setError(describeError(failure));
          }
        } finally {
          if (active) {
            setDeleting(false);
          }
        }
      };

      return (
        <section
          ref={(element) => {
            settingsRoot = element;
          }}
          tabIndex={-1}
          data-testid="graphs-settings-page"
        >
          <div class="flex items-start gap-4">
            <div class="rounded-xl bg-[var(--accent)]/10 p-2.5 text-[var(--accent)]">
              <Workflow aria-hidden="true" size={20} />
            </div>
            <div>
              <p class="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--accent)]">
                Graph library
              </p>
              <h3 class="mt-2 text-xl font-semibold">Saved graph definitions</h3>
              <p class="mt-2 text-sm leading-6 text-[var(--text-muted)]">
                Review reusable workflows. Deleting a definition is permanent,
                but existing run history remains inspectable.
              </p>
            </div>
          </div>

          <Show when={loading()}>
            <div class="mt-6 flex items-center gap-2 text-sm text-[var(--text-muted)]">
              <LoaderCircle
                aria-hidden="true"
                class="animate-spin"
                size={16}
              />
              Loading graph definitions…
            </div>
          </Show>
          <Show when={error()}>
            {(message) => (
              <p class="mt-5 text-sm text-[var(--danger)]" role="alert">
                {message()}
              </p>
            )}
          </Show>
          <Show when={!loading() && !error() && definitions().length === 0}>
            <Panel class="mt-6">
              <p class="text-sm font-semibold">No graph definitions</p>
              <p class="mt-2 text-xs leading-5 text-[var(--text-muted)]">
                Create your first graph in the Graphs workspace.
              </p>
            </Panel>
          </Show>
          <div class="mt-6 grid gap-3">
            <For each={definitions()}>
              {(definition) => (
                <div class="flex items-center gap-4 rounded-2xl border border-[var(--border)] bg-[var(--panel-muted)]/35 p-4">
                  <div class="min-w-0 flex-1">
                    <p class="truncate text-sm font-semibold">
                      {definition.name}
                    </p>
                    <p class="mt-1 truncate text-xs text-[var(--text-muted)]">
                      {definition.description || "No description"}
                    </p>
                    <p class="mt-2 text-[10px] uppercase tracking-wider text-[var(--text-subtle)]">
                      {definition.id} · v{definition.version} ·{" "}
                      {definition.nodes.length} steps
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="danger"
                    size="sm"
                    onClick={(event) => {
                      deleteTrigger = event.currentTarget;
                      setDeleteCandidate(definition);
                    }}
                    data-testid={`graph-delete-${definition.id}`}
                  >
                    <Trash2 aria-hidden="true" size={14} />
                    Delete
                  </Button>
                </div>
              )}
            </For>
          </div>

          <Portal>
            <Show keyed when={deleteCandidate()}>
              {(candidate) => (
                <div
                  class="fixed inset-0 z-50 grid place-items-center bg-black/65 p-5 backdrop-blur-sm"
                  role="alertdialog"
                  aria-modal="true"
                  aria-labelledby="graph-delete-title"
                  aria-describedby="graph-delete-description"
                  onKeyDown={(event) => {
                    if (event.key === "Escape" && !deleting()) {
                      event.preventDefault();
                      closeDeleteDialog();
                      return;
                    }
                    if (event.key !== "Tab") {
                      return;
                    }
                    if (
                      event.shiftKey &&
                      globalThis.document.activeElement === deleteCancelButton
                    ) {
                      event.preventDefault();
                      deleteConfirmButton?.focus();
                    } else if (
                      !event.shiftKey &&
                      globalThis.document.activeElement === deleteConfirmButton
                    ) {
                      event.preventDefault();
                      deleteCancelButton?.focus();
                    }
                  }}
                >
                  <Panel class="w-full max-w-md">
                    <p class="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--danger)]">
                      Delete graph
                    </p>
                    <h3
                      id="graph-delete-title"
                      class="mt-2 text-xl font-semibold"
                    >
                      Delete “{candidate.name}”?
                    </h3>
                    <p
                      id="graph-delete-description"
                      class="mt-3 text-sm leading-6 text-[var(--text-muted)]"
                    >
                      This permanently removes the saved definition. Existing
                      instance history is not deleted.
                    </p>
                    <div class="mt-6 flex justify-end gap-3">
                      <Button
                        ref={(element) => {
                          deleteCancelButton = element;
                        }}
                        type="button"
                        variant="secondary"
                        disabled={deleting()}
                        onClick={() => closeDeleteDialog()}
                        data-testid="graph-delete-cancel"
                      >
                        Keep graph
                      </Button>
                      <Button
                        ref={(element) => {
                          deleteConfirmButton = element;
                        }}
                        type="button"
                        variant="danger"
                        disabled={deleting()}
                        onClick={() => void deleteDefinition(candidate)}
                        data-testid="graph-delete-confirm"
                      >
                        {deleting() ? "Deleting…" : "Delete graph"}
                      </Button>
                    </div>
                  </Panel>
                </div>
              )}
            </Show>
          </Portal>
        </section>
      );
    };

    const workspace = context.ui.registerWorkspaceView({
      id: "borg.graphs.designer",
      label: "Graphs",
      order: 20,
      placement: "primary",
      component: GraphDesigner,
    });
    const widget = context.ui.registerFlightDeckWidget({
      id: "borg.graphs.running",
      label: "Running graphs",
      order: 30,
      placement: "primary",
      component: RunningGraphs,
    });
    const settings = context.ui.registerSettingsPage({
      id: "borg.graphs.settings",
      label: "Graphs",
      order: 40,
      placement: "primary",
      component: GraphSettings,
    });

    return {
      dispose: async () => {
        await settings.dispose();
        await widget.dispose();
        await workspace.dispose();
      },
    };
  },
});
