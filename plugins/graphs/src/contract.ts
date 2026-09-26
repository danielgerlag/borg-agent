import { defineCommand, defineEvent } from "@borg/contracts";
import { z } from "zod";

export const graphValueMapSchema = z.record(z.string(), z.json());
const graphVersionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export const graphErrorStrategySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("fail") }).strict(),
  z.object({ action: z.literal("skip") }).strict(),
  z
    .object({
      action: z.literal("retry"),
      maxAttempts: z.number().int().min(2).max(10).default(3),
    })
    .strict(),
  z
    .object({
      action: z.literal("goto"),
      nodeId: z.string().min(1),
    })
    .strict(),
]);

export type GraphErrorStrategy = z.infer<typeof graphErrorStrategySchema>;

export const graphNodeSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
    type: z.enum(["trigger", "task", "control"]),
    kind: z.string().regex(/^[a-z][a-z0-9_]*$/),
    config: graphValueMapSchema.default({}),
    outputs: z.record(z.string(), z.string()).optional(),
    onError: graphErrorStrategySchema.default({ action: "fail" }),
    timeoutMs: z.number().int().min(1).max(86_400_000).optional(),
    designer: z
      .object({
        x: z.number().finite(),
        y: z.number().finite(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type GraphNode = z.infer<typeof graphNodeSchema>;

export const graphEdgeSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
    source: z.string().min(1),
    target: z.string().min(1),
    sourceHandle: z.string().min(1).optional(),
  })
  .strict();

export type GraphEdge = z.infer<typeof graphEdgeSchema>;

export const graphDefinitionSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9-]*$/),
    name: z.string().trim().min(1).max(120),
    version: z.string().regex(graphVersionPattern),
    engineId: z.string().min(1),
    description: z.string().max(1_000).optional(),
    mode: z.enum(["background", "chat"]),
    inputSchema: graphValueMapSchema.default({}),
    variablesSchema: graphValueMapSchema.default({}),
    nodes: z.array(graphNodeSchema).min(2),
    edges: z.array(graphEdgeSchema),
    output: z.record(z.string(), z.string()).optional(),
    permissions: z.array(z.string()).optional(),
  })
  .strict()
  .superRefine((definition, context) => {
    const nodeIds = new Set<string>();
    for (const node of definition.nodes) {
      if (nodeIds.has(node.id)) {
        context.addIssue({
          code: "custom",
          path: ["nodes"],
          message: `Duplicate graph node ${node.id}`,
        });
      }
      nodeIds.add(node.id);
    }
    const edgeIds = new Set<string>();
    for (const edge of definition.edges) {
      if (edgeIds.has(edge.id)) {
        context.addIssue({
          code: "custom",
          path: ["edges"],
          message: `Duplicate graph edge ${edge.id}`,
        });
      }
      edgeIds.add(edge.id);
      if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) {
        context.addIssue({
          code: "custom",
          path: ["edges"],
          message: `Graph edge ${edge.id} references an unknown node`,
        });
      }
    }
  });

export type GraphDefinition = z.infer<typeof graphDefinitionSchema>;

export const graphNodeStateSchema = z
  .object({
    nodeId: z.string().min(1),
    status: z.enum([
      "pending",
      "running",
      "waiting",
      "completed",
      "skipped",
      "failed",
    ]),
    attempts: z.number().int().nonnegative(),
    output: z.json().optional(),
    error: z.string().optional(),
    childRunId: z.string().uuid().optional(),
    waitUntil: z.string().datetime().optional(),
    startedAt: z.string().datetime().optional(),
    completedAt: z.string().datetime().optional(),
  })
  .strict();

export type GraphNodeState = z.infer<typeof graphNodeStateSchema>;

export const graphInstanceStatusSchema = z.enum([
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
]);

export const graphTriggerKindSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/);

export const graphInstanceSchema = z
  .object({
    id: z.string().uuid(),
    graphId: z.string().min(1),
    graphName: z.string().min(1),
    definitionVersion: z.string().min(1),
    engineId: z.string().min(1),
    mode: z.enum(["background", "chat"]),
        trigger: graphTriggerKindSchema,
    sessionId: z.string().uuid().optional(),
    status: graphInstanceStatusSchema,
    input: graphValueMapSchema,
    variables: graphValueMapSchema,
    nodeStates: z.array(graphNodeStateSchema),
    output: z.json().optional(),
    error: z.string().optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    completedAt: z.string().datetime().optional(),
  })
  .strict();

export type GraphInstance = z.infer<typeof graphInstanceSchema>;

export const graphsSaveDefinition = defineCommand({
  id: "borg.graphs.saveDefinition",
  input: z.object({ definition: graphDefinitionSchema }).strict(),
  output: z.object({ definition: graphDefinitionSchema }).strict(),
});

export const graphsListDefinitions = defineCommand({
  id: "borg.graphs.listDefinitions",
  input: z.object({}).strict(),
  output: z.object({ definitions: z.array(graphDefinitionSchema) }).strict(),
});

export const graphContributionDescriptorSchema = z
  .object({
    kind: z.string().regex(/^[a-z][a-z0-9_]*$/),
    label: z.string().min(1),
    type: z.enum(["trigger", "task", "control"]),
  })
  .strict();

export const graphsListContributions = defineCommand({
  id: "borg.graphs.listContributions",
  input: z.object({}).strict(),
  output: z
    .object({
      contributions: z.array(graphContributionDescriptorSchema),
    })
    .strict(),
});

export const graphToolCatalogEntrySchema = z
  .object({
    id: z.string().min(1),
    description: z.string(),
    inputSchema: z.json(),
  })
  .strict();

export const graphsListCatalog = defineCommand({
  id: "borg.graphs.listCatalog",
  input: z.object({}).strict(),
  output: z
    .object({
      tools: z.array(graphToolCatalogEntrySchema),
    })
    .strict(),
});

export const graphsGetDefinition = defineCommand({
  id: "borg.graphs.getDefinition",
  input: z.object({ graphId: z.string().min(1) }).strict(),
  output: z.object({ definition: graphDefinitionSchema.nullable() }).strict(),
});

export const graphsDeleteDefinition = defineCommand({
  id: "borg.graphs.deleteDefinition",
  input: z.object({ graphId: z.string().min(1) }).strict(),
  output: z.object({ deleted: z.boolean() }).strict(),
});

export const graphsLaunch = defineCommand({
  id: "borg.graphs.launch",
  input: z
    .object({
      graphId: z.string().min(1),
      sessionId: z.string().uuid().optional(),
      input: graphValueMapSchema.default({}),
          trigger: graphTriggerKindSchema.default("manual"),
    })
    .strict(),
  output: z.object({ instanceId: z.string().uuid() }).strict(),
});

export const graphsListRunning = defineCommand({
  id: "borg.graphs.listRunning",
  input: z.object({ sessionId: z.string().uuid().optional() }).strict(),
  output: z.object({ instances: z.array(graphInstanceSchema) }).strict(),
});

export const graphsListInstances = defineCommand({
  id: "borg.graphs.listInstances",
  input: z.object({ graphId: z.string().min(1).optional() }).strict(),
  output: z.object({ instances: z.array(graphInstanceSchema) }).strict(),
});

export const graphsGetInstance = defineCommand({
  id: "borg.graphs.getInstance",
  input: z.object({ instanceId: z.string().uuid() }).strict(),
  output: z.object({ instance: graphInstanceSchema.nullable() }).strict(),
});

export const graphsCancelInstance = defineCommand({
  id: "borg.graphs.cancelInstance",
  input: z.object({ instanceId: z.string().uuid() }).strict(),
  output: z.object({ cancelled: z.boolean() }).strict(),
});

export const graphDefinitionSaved = defineEvent({
  id: "borg.graphs.definition.saved",
  payload: z.object({ definition: graphDefinitionSchema }).strict(),
});

export const graphDefinitionDeleted = defineEvent({
  id: "borg.graphs.definition.deleted",
  payload: z.object({ graphId: z.string().min(1) }).strict(),
});

export const graphInstanceStarted = defineEvent({
  id: "borg.graphs.instance.started",
  payload: z.object({ instance: graphInstanceSchema }).strict(),
});

export const graphInstanceUpdated = defineEvent({
  id: "borg.graphs.instance.updated",
  payload: z.object({ instance: graphInstanceSchema }).strict(),
});

export const graphInstanceCompleted = defineEvent({
  id: "borg.graphs.instance.completed",
  payload: z
    .object({
      instanceId: z.string().uuid(),
      graphId: z.string().min(1),
      sessionId: z.string().uuid().optional(),
      output: z.json().optional(),
      completedAt: z.string().datetime(),
    })
    .strict(),
});

export const graphInstanceFailed = defineEvent({
  id: "borg.graphs.instance.failed",
  payload: z
    .object({
      instanceId: z.string().uuid(),
      graphId: z.string().min(1),
      sessionId: z.string().uuid().optional(),
      error: z.string().min(1),
      completedAt: z.string().datetime(),
    })
    .strict(),
});

export const graphStepCompleted = defineEvent({
  id: "borg.graphs.step.completed",
  payload: z
    .object({
      instanceId: z.string().uuid(),
      graphId: z.string().min(1),
      stepId: z.string().min(1),
      output: z.json().optional(),
      completedAt: z.string().datetime(),
    })
    .strict(),
});
