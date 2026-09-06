import { z } from "zod";

export type CommandErrorCode =
  | "unavailable"
  | "invalid_input"
  | "invalid_output"
  | "forbidden"
  | "timeout"
  | "failed";

export interface BusEnvelope {
  readonly correlationId: string;
  readonly causationId?: string | undefined;
  readonly source: {
    readonly kind: "kernel" | "plugin" | "renderer";
    readonly id: string;
  };
  readonly timestamp: string;
  readonly parentExecutionGrant?: ParentExecutionGrant | undefined;
}

export interface CommandDefinition<
  TInput extends z.ZodType = z.ZodType,
  TOutput extends z.ZodType = z.ZodType,
> {
  readonly id: string;
  readonly input: TInput;
  readonly output: TOutput;
  readonly timeoutMs?: number;
}

export interface EventDefinition<TPayload extends z.ZodType = z.ZodType> {
  readonly id: string;
  readonly payload: TPayload;
}

export type CommandInput<TCommand extends CommandDefinition> = z.input<TCommand["input"]>;
export type CommandOutput<TCommand extends CommandDefinition> = z.output<TCommand["output"]>;
export type EventPayload<TEvent extends EventDefinition> = z.output<TEvent["payload"]>;

export function defineCommand<
  const TInput extends z.ZodType,
  const TOutput extends z.ZodType,
>(definition: CommandDefinition<TInput, TOutput>): CommandDefinition<TInput, TOutput> {
  return Object.freeze(definition);
}

export function defineEvent<const TPayload extends z.ZodType>(
  definition: EventDefinition<TPayload>,
): EventDefinition<TPayload> {
  return Object.freeze(definition);
}

export const commandErrorCodeSchema = z.enum([
  "unavailable",
  "invalid_input",
  "invalid_output",
  "forbidden",
  "timeout",
  "failed",
]);

export const commandErrorSchema = z.object({
  code: commandErrorCodeSchema,
  message: z.string(),
});

export type CommandErrorShape = z.infer<typeof commandErrorSchema>;

export const helloGetStatus = defineCommand({
  id: "borg.hello.getStatus",
  input: z.object({}).strict(),
  output: z.object({
    pluginId: z.string(),
    kernelVersion: z.string(),
    status: z.literal("alive"),
    message: z.string(),
    startedAt: z.string().datetime(),
    now: z.string().datetime(),
  }),
});

export const interactionKindSchema = z.enum([
  "tool_approval",
  "classification",
  "human_input",
]);

export const interactionSourceSchema = z
  .object({
    pluginId: z.string().min(1),
    feature: z.string().min(1),
    sessionId: z.string().min(1).optional(),
    runId: z.string().min(1).optional(),
    instanceId: z.string().min(1).optional(),
    stepId: z.string().min(1).optional(),
    toolCallId: z.string().min(1).optional(),
  })
  .strict();

export const interactionChoiceSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
  })
  .strict();

export const interactionResponseSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("approval"),
    decision: z.enum(["allow", "deny"]),
  }),
  z.object({
    kind: z.literal("text"),
    text: z.string(),
  }),
  z.object({
    kind: z.literal("confirm"),
    confirmed: z.boolean(),
  }),
  z.object({
    kind: z.literal("choice"),
    choiceId: z.string().min(1),
    text: z.string().optional(),
  }),
]);

export type InteractionResponse = z.infer<typeof interactionResponseSchema>;

export const pendingInteractionSchema = z
  .object({
    id: z.string().uuid(),
    kind: interactionKindSchema,
    title: z.string().min(1),
    prompt: z.string().min(1),
    form: z.enum(["approval", "text", "confirm", "choice"]),
    choices: z.array(interactionChoiceSchema).optional(),
    source: interactionSourceSchema,
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime().optional(),
  })
  .strict();

export type PendingInteraction = z.infer<typeof pendingInteractionSchema>;

export const feedbackAnswerSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("text"),
    text: z.string(),
  }),
  z.object({
    kind: z.literal("confirm"),
    confirmed: z.boolean(),
  }),
  z.object({
    kind: z.literal("choice"),
    choiceId: z.string().min(1),
    text: z.string().optional(),
  }),
]);

export type FeedbackAnswer = z.infer<typeof feedbackAnswerSchema>;

export const feedbackAskInputSchema = z
  .object({
    title: z.string().min(1).optional(),
    prompt: z.string().min(1),
    form: z.enum(["text", "confirm", "choice"]),
    choices: z.array(interactionChoiceSchema).min(1).optional(),
    source: interactionSourceSchema.omit({ pluginId: true, feature: true }).default({}),
    timeoutMs: z.number().int().positive().max(86_400_000).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.choices &&
      new Set(value.choices.map(({ id }) => id)).size !== value.choices.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["choices"],
        message: "Feedback choice IDs must be unique",
      });
    }
    if (value.form === "choice" && !value.choices) {
      context.addIssue({
        code: "custom",
        path: ["choices"],
        message: "Choice feedback requires choices",
      });
    }
    if (value.form !== "choice" && value.choices) {
      context.addIssue({
        code: "custom",
        path: ["choices"],
        message: "Choices are only valid for choice feedback",
      });
    }
  });

export const feedbackAsk = defineCommand({
  id: "borg.feedback.ask",
  input: feedbackAskInputSchema,
  output: z.object({
    interactionId: z.string().uuid(),
    answer: feedbackAnswerSchema,
  }),
  timeoutMs: 86_405_000,
});

export const feedbackRequested = defineEvent({
  id: "borg.feedback.requested",
  payload: z.object({
    interactionId: z.string().uuid(),
    request: feedbackAskInputSchema,
  }),
});

export const feedbackResolved = defineEvent({
  id: "borg.feedback.resolved",
  payload: z.object({
    interactionId: z.string().uuid(),
    source: interactionSourceSchema,
    status: z.enum(["answered", "cancelled", "timed_out"]),
  }),
});

export const dataClassificationSchema = z.enum([
  "public",
  "internal",
  "confidential",
  "restricted",
]);

export type DataClassification = z.infer<typeof dataClassificationSchema>;

export const channelCapacitySchema = z.enum([
  "public",
  "internal",
  "private",
  "local-only",
]);

export type ChannelCapacity = z.infer<typeof channelCapacitySchema>;

export const executionIdSchema = z.string().uuid().brand<"ExecutionId">();

export type ExecutionId = z.infer<typeof executionIdSchema>;

export interface ParentExecutionGrant {
  readonly [Symbol.toStringTag]: "ParentExecutionGrant";
}

export const modelOperationKeySchema = z
  .string()
  .min(1)
  .max(240)
  .regex(/^[a-z0-9][a-z0-9./:_-]*$/)
  .brand<"ModelOperationKey">();

export type ModelOperationKey = z.infer<typeof modelOperationKeySchema>;

export const modelOperationPrefixSchema = z
  .string()
  .min(1)
  .max(220)
  .regex(/^[a-z0-9][a-z0-9./:_-]*$/)
  .brand<"ModelOperationPrefix">();

export type ModelOperationPrefix = z.infer<
  typeof modelOperationPrefixSchema
>;

export const executionSubjectSchema = z
  .object({
    kind: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[a-z][a-z0-9-]*$/),
    id: z.string().min(1).max(240),
  })
  .strict();

export type ExecutionSubject = z.infer<typeof executionSubjectSchema>;

export const executionResultFlowSchema = z.enum([
  "merge_to_parent",
  "detached",
]);

export type ExecutionResultFlow = z.infer<
  typeof executionResultFlowSchema
>;

export const providerEgressSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("local"),
      capacity: z.literal("local-only"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("remote"),
      capacity: channelCapacitySchema.exclude(["local-only"]),
      destination: z.string().url().startsWith("https://"),
    })
    .strict(),
]);

export type ProviderEgress = z.infer<typeof providerEgressSchema>;

export const provenanceSeedSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("user"),
      id: z.string().min(1).max(240),
    })
    .strict(),
  z
    .object({
      kind: z.literal("channel"),
      id: z.string().min(1).max(240),
      messageId: z.string().min(1).max(240),
    })
    .strict(),
  z
    .object({
      kind: z.literal("plugin"),
      id: z.string().min(1).max(240),
    })
    .strict(),
  z
    .object({
      kind: z.literal("legacy"),
      id: z.string().min(1).max(240),
    })
    .strict(),
  z
    .object({
      kind: z.literal("execution"),
      id: executionIdSchema,
      relation: z.enum(["parent", "child-result", "retry-of"]),
    })
    .strict(),
]);

export type ProvenanceSeed = z.infer<typeof provenanceSeedSchema>;

export const securityObservationSchema = z
  .object({
    id: z.string().uuid(),
    classification: dataClassificationSchema,
    source: provenanceSeedSchema,
    reason: z.string().min(1).max(512),
    observedAt: z.string().datetime(),
  })
  .strict();

export type SecurityObservation = z.infer<
  typeof securityObservationSchema
>;

export const boundedProvenanceSchema = z
  .object({
    recent: z.array(securityObservationSchema).max(64),
    overflow: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("complete") }).strict(),
      z
        .object({
          kind: z.literal("truncated"),
          omittedCount: z.number().int().positive(),
          digestSha256: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict(),
    ]),
  })
  .strict();

export type BoundedProvenance = z.infer<
  typeof boundedProvenanceSchema
>;

export const executionLifecycleSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("open") }).strict(),
  z
    .object({
      state: z.literal("closed"),
      outcome: z.enum([
        "completed",
        "failed",
        "cancelled",
        "interrupted",
        "deleted",
      ]),
      reason: z.string().min(1).max(512),
      closedAt: z.string().datetime(),
    })
    .strict(),
]);

export type ExecutionLifecycle = z.infer<
  typeof executionLifecycleSchema
>;

export const executionSecuritySummarySchema = z
  .object({
    id: executionIdSchema,
    rootExecutionId: executionIdSchema,
    ownerPluginId: z.string().min(1).max(200),
    subject: executionSubjectSchema,
    parentExecutionId: executionIdSchema.optional(),
    classification: dataClassificationSchema,
    classificationRevision: z.number().int().positive(),
    lifecycle: executionLifecycleSchema,
  })
  .strict();

export type ExecutionSecuritySummary = z.infer<
  typeof executionSecuritySummarySchema
>;

export const executionBindingFingerprintSchema =
  z.discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("root"),
        classification: dataClassificationSchema,
        provenance: provenanceSeedSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal("child"),
        parentExecutionId: executionIdSchema,
        rootExecutionId: executionIdSchema,
      })
      .strict(),
  ]);

export const executionSecurityContextSchema =
  executionSecuritySummarySchema.extend({
    version: z.literal(1),
    binding: executionBindingFingerprintSchema,
    resultFlow: executionResultFlowSchema,
    provenance: boundedProvenanceSchema,
    importedDetachedResultIds: z.array(executionIdSchema),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  });

export type ExecutionSecurityContext = z.infer<
  typeof executionSecurityContextSchema
>;

export const executionRootBindInputSchema = z
  .object({
    mode: z.literal("root"),
    subject: executionSubjectSchema,
    classification: dataClassificationSchema,
    provenance: provenanceSeedSchema,
  })
  .strict();

export type ExecutionRootBindInput = z.infer<
  typeof executionRootBindInputSchema
>;

export const executionResumeBindInputSchema = z
  .object({
    mode: z.literal("resume"),
    executionId: executionIdSchema,
  })
  .strict();

export type ExecutionResumeBindInput = z.infer<
  typeof executionResumeBindInputSchema
>;

export const executionObservationInputSchema = z
  .object({
    classification: dataClassificationSchema,
    provenance: provenanceSeedSchema,
    reason: z.string().min(1).max(512),
  })
  .strict();

export type ExecutionObservationInput = z.infer<
  typeof executionObservationInputSchema
>;

export const executionCloseInputSchema = z
  .object({
    outcome: z.enum([
      "completed",
      "failed",
      "cancelled",
      "interrupted",
      "deleted",
    ]),
    reason: z.string().min(1).max(512),
  })
  .strict();

export type ExecutionCloseInput = z.infer<
  typeof executionCloseInputSchema
>;

export type ContractJsonValue =
  | string
  | number
  | boolean
  | null
  | { readonly [key: string]: ContractJsonValue }
  | readonly ContractJsonValue[];

export const contractJsonValueSchema: z.ZodType<ContractJsonValue> =
  z.lazy(() =>
    z.union([
      z.string(),
      z.number(),
      z.boolean(),
      z.null(),
      z.array(contractJsonValueSchema).readonly(),
      z.record(z.string(), contractJsonValueSchema),
    ]),
  );

export const modelToolCallSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    input: contractJsonValueSchema,
  })
  .strict()
  .readonly();

export type ModelToolCall = z.infer<typeof modelToolCallSchema>;

export const modelMessageSchema = z
  .object({
    role: z.enum(["system", "user", "assistant", "tool"]),
    content: z.string(),
    toolCallId: z.string().min(1).optional(),
    toolCalls: z.array(modelToolCallSchema).readonly().optional(),
  })
  .strict()
  .readonly();

export type ModelMessage = z.infer<typeof modelMessageSchema>;

export const modelToolDefinitionSchema = z
  .object({
    id: z.string().min(1),
    description: z.string(),
    inputSchema: contractJsonValueSchema,
  })
  .strict()
  .readonly();

export type ModelToolDefinition = z.infer<
  typeof modelToolDefinitionSchema
>;

export const modelUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative().optional(),
    cacheWriteTokens: z.number().int().nonnegative().optional(),
    amount: z.number().nonnegative().optional(),
    currency: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.amount === undefined) !== (value.currency === undefined)) {
      context.addIssue({
        code: "custom",
        path: value.amount === undefined ? ["amount"] : ["currency"],
        message: "Usage amount and currency must be provided together",
      });
    }
    if (
      (value.cachedInputTokens ?? 0) +
        (value.cacheWriteTokens ?? 0) >
      value.inputTokens
    ) {
      context.addIssue({
        code: "custom",
        path: ["inputTokens"],
        message:
          "cachedInputTokens and cacheWriteTokens must not exceed inputTokens",
      });
    }
  })
  .readonly();

export type ModelUsage = z.infer<typeof modelUsageSchema>;

export const modelCompletionResultSchema = z
  .object({
    content: z.string().optional(),
    toolCalls: z.array(modelToolCallSchema).readonly().optional(),
    usage: modelUsageSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.content === undefined && !value.toolCalls?.length) {
      context.addIssue({
        code: "custom",
        message: "Model completion requires content or a tool call",
      });
    }
  })
  .readonly();

export type ModelCompletionResult = z.infer<
  typeof modelCompletionResultSchema
>;

export const modelCompletionRequestSchema = z
  .object({
    modelId: z.string().min(1),
    messages: z.array(modelMessageSchema).min(1).readonly(),
    tools: z.array(modelToolDefinitionSchema).readonly(),
  })
  .strict()
  .readonly();

export type ModelCompletionRequest = z.infer<
  typeof modelCompletionRequestSchema
>;

export const modelGatewayRequestSchema = z
  .object({
    executionId: executionIdSchema,
    operationKey: modelOperationKeySchema,
    providerId: z.string().min(1).optional(),
    modelId: z.string().min(1).optional(),
    messages: z.array(modelMessageSchema).min(1).readonly(),
    tools: z.array(modelToolDefinitionSchema).readonly().default([]),
  })
  .strict()
  .readonly();

export type ModelGatewayRequest = z.input<
  typeof modelGatewayRequestSchema
>;

export const releasedModelCompletionSchema = z
  .object({
    providerId: z.string().min(1),
    modelId: z.string().min(1),
    content: z.string().optional(),
    toolCalls: z.array(modelToolCallSchema).readonly().optional(),
    usage: modelUsageSchema,
    replayed: z.boolean(),
  })
  .strict()
  .readonly();

export type ReleasedModelCompletion = z.infer<
  typeof releasedModelCompletionSchema
>;

export const usageRecordSchema = z
  .object({
    providerId: z.string().min(1),
    modelId: z.string().min(1),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative().optional(),
    cacheWriteTokens: z.number().int().nonnegative().optional(),
    amount: z.number().nonnegative().optional(),
    currency: z.string().min(1).optional(),
    correlationId: z.string().min(1),
    runId: z.string().min(1).optional(),
    executionId: executionIdSchema.optional(),
    operationKey: modelOperationKeySchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.amount === undefined) !== (value.currency === undefined)) {
      context.addIssue({
        code: "custom",
        path: value.amount === undefined ? ["amount"] : ["currency"],
        message: "Usage amount and currency must be provided together",
      });
    }
    const cached = value.cachedInputTokens ?? 0;
    const written = value.cacheWriteTokens ?? 0;
    if (cached + written > value.inputTokens) {
      context.addIssue({
        code: "custom",
        path: ["inputTokens"],
        message:
          "cachedInputTokens and cacheWriteTokens must not exceed inputTokens",
      });
    }
  });

export type UsageRecord = z.infer<typeof usageRecordSchema>;

export const costSummarySchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative(),
    cacheWriteTokens: z.number().int().nonnegative(),
    amountsByCurrency: z.record(z.string().min(1), z.number().nonnegative()),
  })
  .strict();

export type CostSummary = z.infer<typeof costSummarySchema>;

export const chatUsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative(),
    cacheWriteTokens: z.number().int().nonnegative(),
    costsByCurrency: z.record(z.string().min(1), z.number().nonnegative()),
  })
  .strict();

export type ChatUsage = z.infer<typeof chatUsageSchema>;

export const emptyChatUsage: ChatUsage = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  costsByCurrency: Object.freeze({}),
});

export const loopRunStatusSchema = z.enum([
  "running",
  "waiting",
  "paused",
  "completed",
  "failed",
  "cancelled",
]);

export type LoopRunStatus = z.infer<typeof loopRunStatusSchema>;

export const loopSecurityInputSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("root"),
      subject: executionSubjectSchema,
      classification: dataClassificationSchema,
      provenance: provenanceSeedSchema,
      operationPrefix: modelOperationPrefixSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("bound"),
      executionId: executionIdSchema,
      operationPrefix: modelOperationPrefixSchema,
    })
    .strict(),
]);

export type LoopSecurityInput = z.infer<
  typeof loopSecurityInputSchema
>;

export const loopStartInputSchema = z
  .object({
    prompt: z.string().min(1),
    providerId: z.string().min(1).optional(),
    modelId: z.string().min(1).optional(),
    allowedTools: z.array(z.string().min(1)).optional(),
    personaId: z.string().min(1).optional(),
    sessionId: z.string().uuid().optional(),
    conversation: z
      .array(
        z
          .object({
            role: z.enum(["user", "assistant"]),
            content: z.string(),
          })
          .strict(),
      )
      .optional(),
    security: loopSecurityInputSchema,
  })
  .strict();

export const loopRunSnapshotSchema = z
  .object({
    id: z.string().uuid(),
    status: loopRunStatusSchema,
    prompt: z.string(),
    personaId: z.string().optional(),
    sessionId: z.string().uuid().optional(),
    executionId: executionIdSchema.optional(),
    providerId: z.string().optional(),
    modelId: z.string().optional(),
    output: z.string().optional(),
    error: z.string().optional(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative().default(0),
    cacheWriteTokens: z.number().int().nonnegative().default(0),
    costsByCurrency: z.record(z.string().min(1), z.number().nonnegative()),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type LoopStartInput = z.input<typeof loopStartInputSchema>;
export type LoopRunSnapshot = z.infer<typeof loopRunSnapshotSchema>;

const loopEventBaseSchema = z.object({
  runId: z.string().uuid(),
  timestamp: z.string().datetime(),
});

export const loopEventSchema = z.discriminatedUnion("type", [
  loopEventBaseSchema.extend({
    type: z.literal("state"),
    status: loopRunStatusSchema,
  }),
  loopEventBaseSchema.extend({
    type: z.literal("model_start"),
    providerId: z.string().optional(),
    modelId: z.string().optional(),
  }),
  loopEventBaseSchema.extend({
    type: z.literal("model_token"),
    token: z.string(),
  }),
  loopEventBaseSchema.extend({
    type: z.literal("model_end"),
    providerId: z.string(),
    modelId: z.string(),
  }),
  loopEventBaseSchema.extend({
    type: z.literal("tool_start"),
    toolId: z.string(),
    toolCallId: z.string(),
    input: z.unknown(),
  }),
  loopEventBaseSchema.extend({
    type: z.literal("tool_result"),
    toolId: z.string(),
    toolCallId: z.string(),
    output: z.unknown(),
  }),
  loopEventBaseSchema.extend({
    type: z.literal("interaction_wait"),
    interactionId: z.string().uuid(),
    kind: interactionKindSchema,
  }),
  loopEventBaseSchema.extend({
    type: z.literal("usage"),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative().default(0),
    cacheWriteTokens: z.number().int().nonnegative().default(0),
    costsByCurrency: z.record(z.string().min(1), z.number().nonnegative()),
  }),
  loopEventBaseSchema.extend({
    type: z.literal("final"),
    output: z.string(),
  }),
  loopEventBaseSchema.extend({
    type: z.literal("failed"),
    error: z.string(),
  }),
]);

export type LoopEvent = z.infer<typeof loopEventSchema>;

export const MCP_APP_RENDERER_ID = "borg.mcp-apps";
export const MCP_APP_BRIDGE_CHANNEL = "borg.mcp-apps.bridge.v1";
export const MCP_APP_MAX_MESSAGE_BYTES = 256 * 1024;

export const personaIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/);

const mcpServerIdSchema = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (value) =>
      value.trim() === value &&
      !/[\u0000-\u001f\u007f]/.test(value),
    "MCP server ID contains invalid characters",
  );

const mcpSecretRefSchema = z.string().min(1).max(256);

function isLoopbackMcpHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, "");
  return (
    normalized === "localhost" ||
    normalized === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/.test(normalized)
  );
}

const mcpServerCommonSchema = z.object({
  id: mcpServerIdSchema,
  enabled: z.boolean().default(true),
  channelClass: z
    .enum(["public", "internal", "private", "local-only"])
    .default("private"),
  reconnect: z.boolean().default(true),
  reactive: z.boolean().default(false),
  sandbox: z.record(z.string(), z.json()).optional(),
});

export const mcpServerConfigSchema = z.discriminatedUnion("transport", [
  mcpServerCommonSchema
    .extend({
      transport: z.literal("stdio"),
      command: z.string().min(1).max(4_096).refine(
        (value) => !value.includes("\0"),
        "MCP command contains a NUL byte",
      ),
      arguments: z
        .array(
          z
            .string()
            .max(32_768)
            .refine(
              (value) => !value.includes("\0"),
              "MCP argument contains a NUL byte",
            ),
        )
        .max(256)
        .default([]),
      environmentSecretRefs: z
        .record(
          z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(256),
          mcpSecretRefSchema,
        )
        .default({}),
    })
    .strict(),
  mcpServerCommonSchema
    .extend({
      transport: z.enum(["sse", "streamable-http"]),
      url: z
        .string()
        .max(4_096)
        .url()
        .refine((value) => {
          const url = new URL(value);
          return (
            (url.protocol === "http:" || url.protocol === "https:") &&
            url.username === "" &&
            url.password === ""
          );
        }, "MCP URL must be an HTTP(S) URL without credentials"),
      headerSecretRefs: z
        .record(
          z
            .string()
            .min(1)
            .max(256)
            .regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/),
          mcpSecretRefSchema,
        )
        .default({}),
    })
    .strict()
    .superRefine((config, context) => {
      if (Object.keys(config.headerSecretRefs).length === 0) {
        return;
      }
      const url = new URL(config.url);
      if (
        url.protocol === "https:" ||
        (url.protocol === "http:" &&
          isLoopbackMcpHostname(url.hostname))
      ) {
        return;
      }
      context.addIssue({
        code: "custom",
        path: ["url"],
        message:
          "MCP header secrets require HTTPS or a loopback HTTP URL",
      });
    }),
]);

export type McpServerConfig = z.infer<typeof mcpServerConfigSchema>;

export const personaSchema = z
  .object({
    id: personaIdSchema,
    name: z.string().min(1),
    description: z.string().optional(),
    instructions: z.string().min(1),
    preferredModels: z.array(z.string().min(1)).min(1),
    secondaryModels: z.array(z.string().min(1)).default([]),
    allowedTools: z.array(z.string().min(1)).default(["*"]),
    mcpServers: z.array(mcpServerConfigSchema).max(64).default([]),
    loopStrategy: z.enum(["react", "code-act"]).default("react"),
    toolExecutionMode: z
      .enum(["sequential-partial", "sequential-full", "parallel"])
      .default("sequential-partial"),
    skillIds: z.array(z.string().min(1)).default([]),
    contextMapStrategy: z
      .enum(["general", "code", "advanced"])
      .optional(),
    avatar: z.string().optional(),
    color: z.string().optional(),
    archived: z.boolean().default(false),
    bundled: z.boolean().default(false),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      new Set(value.mcpServers.map(({ id }) => id)).size !==
      value.mcpServers.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["mcpServers"],
        message: "MCP server IDs must be unique within a persona",
      });
    }
  });

export type Persona = z.infer<typeof personaSchema>;

export const modelDescriptorSchema = z
  .object({
    providerId: z.string().min(1),
    modelId: z.string().min(1),
    preferenceId: z.string().min(3),
  })
  .strict();

export type ModelDescriptor = z.infer<typeof modelDescriptorSchema>;

export const chatEntryRoleSchema = z.enum([
  "user",
  "assistant",
  "system",
  "tool",
  "event",
]);

export const chatEntrySchema = z
  .object({
    id: z.string().uuid(),
    role: chatEntryRoleSchema,
    content: z.string(),
    metadata: z.record(z.string(), z.json()).optional(),
    createdAt: z.string().datetime(),
  })
  .strict();

export type ChatEntry = z.infer<typeof chatEntrySchema>;

export const chatSessionSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string().min(1),
    personaId: personaIdSchema,
    parentSessionId: z.string().uuid().optional(),
    status: z.enum(["idle", "running", "waiting", "error"]),
    activeRunId: z.string().uuid().optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    usage: chatUsageSchema.default(emptyChatUsage),
  })
  .strict();

export type ChatSession = z.infer<typeof chatSessionSchema>;

export const chatDocumentSchema = z
  .object({
    session: chatSessionSchema,
    entries: z.array(chatEntrySchema),
  })
  .strict();

export const chatCreateSession = defineCommand({
  id: "borg.chat.createSession",
  input: z
    .object({
      personaId: personaIdSchema.optional(),
      title: z.string().min(1).optional(),
      parentSessionId: z.string().uuid().optional(),
      initialMessage: z.string().trim().min(1).optional(),
    })
    .strict(),
  output: z
    .object({
      sessionId: z.string().uuid(),
      startError: z.string().min(1).optional(),
    })
    .strict(),
});

export const chatListSessions = defineCommand({
  id: "borg.chat.listSessions",
  input: z
    .object({
      parentSessionId: z.string().uuid().optional(),
      includeChildren: z.boolean().default(true),
    })
    .strict(),
  output: z.object({ sessions: z.array(chatSessionSchema) }).strict(),
});

export const chatGetSession = defineCommand({
  id: "borg.chat.getSession",
  input: z.object({ sessionId: z.string().uuid() }).strict(),
  output: chatDocumentSchema,
});

export const chatSendMessage = defineCommand({
  id: "borg.chat.sendMessage",
  input: z
    .object({
      sessionId: z.string().uuid(),
      text: z.string().min(1),
    })
    .strict(),
  output: z.object({ runId: z.string().uuid() }).strict(),
});

export const chatAppend = defineCommand({
  id: "borg.chat.append",
  input: z
    .object({
      sessionId: z.string().uuid(),
      entry: z
        .object({
          role: z.enum(["assistant", "system", "tool", "event"]),
          content: z.string(),
          metadata: z.record(z.string(), z.json()).optional(),
        })
        .strict(),
    })
    .strict(),
  output: z.object({ messageId: z.string().uuid() }).strict(),
});

export const chatDeleteSession = defineCommand({
  id: "borg.chat.deleteSession",
  input: z.object({ sessionId: z.string().uuid() }).strict(),
  output: z.object({ deleted: z.boolean() }).strict(),
});

export const chatSpawnSubAgent = defineCommand({
  id: "borg.chat.spawnSubAgent",
  input: z
    .object({
      parentSessionId: z.string().uuid(),
      personaId: personaIdSchema.optional(),
      task: z.string().min(1),
    })
    .strict(),
  output: z
    .object({
      childSessionId: z.string().uuid(),
      runId: z.string().uuid(),
    })
    .strict(),
});

export const workspaceFileSchema = z
  .object({
    path: z.string().min(1),
    size: z.number().int().nonnegative(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type WorkspaceFile = z.infer<typeof workspaceFileSchema>;

export const chatListWorkspace = defineCommand({
  id: "borg.chat.listWorkspace",
  input: z.object({ sessionId: z.string().uuid() }).strict(),
  output: z.object({ files: z.array(workspaceFileSchema) }).strict(),
});

export const chatMessageAppended = defineEvent({
  id: "borg.chat.message.appended",
  payload: z
    .object({
      sessionId: z.string().uuid(),
      entry: chatEntrySchema,
    })
    .strict(),
});

export const chatTurnStarted = defineEvent({
  id: "borg.chat.turn.started",
  payload: z
    .object({
      sessionId: z.string().uuid(),
      runId: z.string().uuid(),
      personaId: personaIdSchema,
    })
    .strict(),
});

export const chatTurnCompleted = defineEvent({
  id: "borg.chat.turn.completed",
  payload: z
    .object({
      sessionId: z.string().uuid(),
      runId: z.string().uuid(),
      status: z.enum(["completed", "failed", "cancelled"]),
      output: z.string().optional(),
      error: z.string().optional(),
    })
    .strict(),
});

export const chatSessionUpdated = defineEvent({
  id: "borg.chat.session.updated",
  payload: z
    .object({
      session: chatSessionSchema,
    })
    .strict(),
});

export const chatSessionDeleted = defineEvent({
  id: "borg.chat.session.deleted",
  payload: z.object({ sessionId: z.string().uuid() }).strict(),
});

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

export const promptScanStageSchema = z.enum([
  "user_input",
  "inbound_message",
  "tool_result",
  "model_input",
  "model_output",
  "outbound_message",
]);

export type PromptScanStage = z.infer<typeof promptScanStageSchema>;

export const promptScanActionSchema = z.enum(["allow", "review", "block"]);

export type PromptScanAction = z.infer<typeof promptScanActionSchema>;

export const promptScanFindingSchema = z
  .object({
    code: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9._-]*$/),
    action: promptScanActionSchema,
    reason: z.string().min(1).max(1_000),
    evidence: z.string().max(512).optional(),
  })
  .strict();

export type PromptScanFinding = z.infer<typeof promptScanFindingSchema>;

export const channelAttachmentHandleSchema = z
  .object({
    id: z.string().min(1).max(256),
    name: z.string().min(1).max(512),
    mimeType: z.string().min(1).max(255),
    size: z.number().int().nonnegative().optional(),
  })
  .strict();

export type ChannelAttachmentHandle = z.infer<
  typeof channelAttachmentHandleSchema
>;

export const channelInboundMessage = defineEvent({
  id: "borg.channel.inboundMessage",
  payload: z
    .object({
      id: z.string().uuid(),
      channelId: z.string().min(1),
      text: z.string(),
      sender: z.string().optional(),
      externalId: z.string().min(1).max(256).optional(),
      adapterId: z.string().min(1).max(256).optional(),
      destinationId: z.string().min(1).max(256).optional(),
      classification: dataClassificationSchema.optional(),
      attachments: z.array(channelAttachmentHandleSchema).max(16).optional(),
      metadata: graphValueMapSchema.default({}),
      receivedAt: z.string().datetime(),
    })
    .strict(),
});

export type ChannelInboundMessage = EventPayload<typeof channelInboundMessage>;

export const KERNEL_ONLY_EVENT_IDS: ReadonlySet<string> = new Set([
  channelInboundMessage.id,
]);

export function isKernelOnlyEvent(eventId: string): boolean {
  return KERNEL_ONLY_EVENT_IDS.has(eventId);
}

export const mockChannelInject = defineCommand({
  id: "borg.channel.mock.inject",
  input: z
    .object({
      destinationId: z.string().min(1).max(256).default("default"),
      externalId: z.string().min(1).max(256).optional(),
      text: z.string().max(65_536),
      sender: z.string().min(1).max(256).optional(),
      classification: dataClassificationSchema.optional(),
    })
    .strict(),
  output: z.object({ accepted: z.literal(true), externalId: z.string() }).strict(),
});

export const mockChannelSend = defineCommand({
  id: "borg.channel.mock.send",
  input: z
    .object({
      destinationId: z.string().min(1).max(256).default("default"),
      text: z.string().max(65_536),
      classification: dataClassificationSchema.optional(),
      idempotencyKey: z.string().min(1).max(200),
    })
    .strict(),
  output: z.discriminatedUnion("status", [
    z
      .object({
        status: z.literal("sent"),
        messageId: z.string().uuid(),
        externalId: z.string().min(1),
        sentAt: z.string().datetime(),
      })
      .strict(),
    z
      .object({
        status: z.literal("duplicate"),
        messageId: z.string().uuid(),
        externalId: z.string().min(1).optional(),
      })
      .strict(),
    z
      .object({
        status: z.literal("denied"),
        reasons: z.array(z.string().min(1).max(1_000)).max(20),
      })
      .strict(),
  ]),
});

export const discordChannelStatusSchema = z
  .object({
    hasToken: z.boolean(),
    connected: z.boolean(),
    botUserId: z.string().optional(),
    gatewayState: z.enum([
      "idle",
      "connecting",
      "identifying",
      "resuming",
      "ready",
      "backoff",
      "fatal",
    ]),
    error: z.string().max(1_000).optional(),
  })
  .strict();

export type DiscordChannelStatus = z.infer<typeof discordChannelStatusSchema>;

export const discordChannelGetStatus = defineCommand({
  id: "borg.channel.discord.getStatus",
  input: z.object({}).strict(),
  output: discordChannelStatusSchema,
});

export const discordChannelVerify = defineCommand({
  id: "borg.channel.discord.verify",
  input: z.object({}).strict(),
  output: discordChannelStatusSchema,
  timeoutMs: 30_000,
});

export const discordChannelDisconnect = defineCommand({
  id: "borg.channel.discord.disconnect",
  input: z.object({}).strict(),
  output: discordChannelStatusSchema,
});

export const botStatusSchema = z.enum([
  "stopped",
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

export const botLogLevelSchema = z.enum(["debug", "info", "warn", "error"]);

export const botLogSchema = z
  .object({
    at: z.string().datetime(),
    level: botLogLevelSchema,
    message: z.string().min(1),
    eventType: z.string().min(1).optional(),
  })
  .strict();

export const botSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().min(1),
    personaId: z.string().min(1),
    launchPrompt: z.string().min(1),
    status: botStatusSchema,
    runId: z.string().uuid().optional(),
    error: z.string().optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    startedAt: z.string().datetime().optional(),
    completedAt: z.string().datetime().optional(),
  })
  .strict();

export type Bot = z.infer<typeof botSchema>;
export type BotLog = z.infer<typeof botLogSchema>;
export type BotStatus = z.infer<typeof botStatusSchema>;

export const botsCreate = defineCommand({
  id: "borg.bots.create",
  input: z
    .object({
      name: z.string().min(1).optional(),
      personaId: z.string().min(1).optional(),
      launchPrompt: z.string().min(1),
    })
    .strict(),
  output: z.object({ bot: botSchema }).strict(),
});

export const botsList = defineCommand({
  id: "borg.bots.list",
  input: z.object({}).strict(),
  output: z.object({ bots: z.array(botSchema) }).strict(),
});

export const botsGet = defineCommand({
  id: "borg.bots.get",
  input: z.object({ botId: z.string().uuid() }).strict(),
  output: z.object({ bot: botSchema.nullable() }).strict(),
});

export const botsStart = defineCommand({
  id: "borg.bots.start",
  input: z.object({ botId: z.string().uuid() }).strict(),
  output: z.object({ bot: botSchema }).strict(),
});

export const botsStop = defineCommand({
  id: "borg.bots.stop",
  input: z.object({ botId: z.string().uuid() }).strict(),
  output: z.object({ bot: botSchema }).strict(),
});

export const botsDelete = defineCommand({
  id: "borg.bots.delete",
  input: z.object({ botId: z.string().uuid() }).strict(),
  output: z.object({ deleted: z.boolean() }).strict(),
});

export const botsListLogs = defineCommand({
  id: "borg.bots.listLogs",
  input: z.object({ botId: z.string().uuid() }).strict(),
  output: z.object({ logs: z.array(botLogSchema) }).strict(),
});

export const botUpdated = defineEvent({
  id: "borg.bots.updated",
  payload: z.object({ bot: botSchema }).strict(),
});

export const botStarted = defineEvent({
  id: "borg.bots.started",
  payload: z.object({ bot: botSchema }).strict(),
});

export const botStopped = defineEvent({
  id: "borg.bots.stopped",
  payload: z.object({ bot: botSchema }).strict(),
});

export const botCompleted = defineEvent({
  id: "borg.bots.completed",
  payload: z.object({ bot: botSchema }).strict(),
});

export const botFailed = defineEvent({
  id: "borg.bots.failed",
  payload: z.object({ bot: botSchema }).strict(),
});

export const anthropicStatusSchema = z
  .object({
    hasKey: z.boolean(),
    connected: z.boolean(),
  })
  .strict();

export type AnthropicStatus = z.infer<typeof anthropicStatusSchema>;

export const anthropicGetStatus = defineCommand({
  id: "borg.anthropic.getStatus",
  input: z.object({}).strict(),
  output: anthropicStatusSchema,
});

export const anthropicConnect = defineCommand({
  id: "borg.anthropic.connect",
  input: z.object({}).strict(),
  output: anthropicStatusSchema,
});

export const anthropicDisconnect = defineCommand({
  id: "borg.anthropic.disconnect",
  input: z.object({}).strict(),
  output: anthropicStatusSchema,
});

export const mcpServerStatusSchema = z.enum([
  "idle",
  "connecting",
  "ready",
  "degraded",
  "failed",
  "closed",
]);

export type McpServerStatus = z.infer<typeof mcpServerStatusSchema>;

export const mcpServerSnapshotSchema = z
  .object({
    id: mcpServerIdSchema,
    status: mcpServerStatusSchema,
    toolCount: z.number().int().nonnegative(),
    toolIds: z
      .array(
        z
          .string()
          .min(1)
          .max(512)
          .regex(/^[a-z0-9]+(?:[.-][a-z0-9-]+)+$/),
      )
      .max(10_000)
      .default([]),
    error: z.string().min(1).max(1_000).optional(),
  })
  .strict();

export type McpServerSnapshot = z.infer<typeof mcpServerSnapshotSchema>;

export const mcpListServers = defineCommand({
  id: "borg.mcp.listServers",
  input: z
    .object({
      personaId: personaIdSchema.optional(),
    })
    .strict(),
  output: z
    .object({ servers: z.array(mcpServerSnapshotSchema).max(64) })
    .strict(),
});

export const mcpGetStatus = defineCommand({
  id: "borg.mcp.getStatus",
  input: z
    .object({
      serverId: mcpServerIdSchema,
      personaId: personaIdSchema.optional(),
    })
    .strict(),
  output: mcpServerSnapshotSchema,
});

export const mcpRefresh = defineCommand({
  id: "borg.mcp.refresh",
  input: z
    .object({
      serverId: mcpServerIdSchema.optional(),
      personaId: personaIdSchema.optional(),
    })
    .strict(),
  output: z
    .object({ servers: z.array(mcpServerSnapshotSchema).max(64) })
    .strict(),
});

export const mcpAppCspSchema = z
  .object({
    resourceDomains: z.array(z.string().min(1).max(2_048)).max(256).default([]),
    connectDomains: z.array(z.string().min(1).max(2_048)).max(256).default([]),
    frameDomains: z.array(z.string().min(1).max(2_048)).max(256).default([]),
    baseUriDomains: z.array(z.string().min(1).max(2_048)).max(256).default([]),
  })
  .strict();

export type McpAppCsp = z.infer<typeof mcpAppCspSchema>;

export const mcpAppPermissionsSchema = z
  .object({
    camera: z.boolean().default(false),
    microphone: z.boolean().default(false),
    geolocation: z.boolean().default(false),
    clipboardWrite: z.boolean().default(false),
  })
  .strict();

export type McpAppPermissions = z.infer<typeof mcpAppPermissionsSchema>;

export const mcpAppToolSchema = z
  .object({
    name: z.string().min(1).max(256),
    toolId: z
      .string()
      .max(512)
      .regex(/^[a-z0-9]+(?:[.-][a-z0-9-]+)+$/),
    description: z.string().max(10_000),
    inputSchema: z.json(),
  })
  .strict();

export type McpAppTool = z.infer<typeof mcpAppToolSchema>;

export const mcpAppDiscovered = defineEvent({
  id: "borg.mcp.appDiscovered",
  payload: z
    .object({
      sessionId: z.string().uuid(),
      personaId: personaIdSchema,
      appInstanceId: z.string().uuid(),
      serverId: mcpServerIdSchema,
      resourceUri: z.string().min(6).max(2_048).startsWith("ui://"),
      html: z.string().max(2 * 1024 * 1024),
      csp: mcpAppCspSchema,
      permissions: mcpAppPermissionsSchema,
      tools: z.array(mcpAppToolSchema).max(256),
      sourceToolId: z.string().min(1).max(512),
      sourceToolName: z.string().min(1).max(256),
      toolInput: z.json(),
      callResult: z.json(),
      startedAt: z.string().datetime(),
      completedAt: z.string().datetime(),
      discoveredAt: z.string().datetime(),
    })
    .strict()
    .superRefine((value, context) => {
      if (
        new TextEncoder().encode(value.html).byteLength >
        2 * 1024 * 1024
      ) {
        context.addIssue({
          code: "custom",
          path: ["html"],
          message: "MCP App HTML exceeds the size cap",
        });
      }
      const payloads = [
        {
          jsonrpc: "2.0",
          method: "ui/notifications/tool-input",
          params: { arguments: value.toolInput },
        },
        {
          jsonrpc: "2.0",
          method: "ui/notifications/tool-result",
          params: value.callResult,
        },
        {
          jsonrpc: "2.0",
          id: "x".repeat(256),
          result: {
            tools: value.tools.map(({ name, description, inputSchema }) => ({
              name,
              description,
              inputSchema,
            })),
          },
        },
      ];
      if (
        payloads.some(
          (payload) =>
            new TextEncoder().encode(JSON.stringify(payload)).byteLength >
            MCP_APP_MAX_MESSAGE_BYTES,
        )
      ) {
        context.addIssue({
          code: "custom",
          message: "MCP App bridge payload exceeds the size cap",
        });
      }
    }),
});

export type McpAppDiscovered = z.infer<typeof mcpAppDiscovered.payload>;

export const mcpAppSnapshotSchema = mcpAppDiscovered.payload
  .extend({
    version: z.literal(1),
  })
  .strict();

export type McpAppSnapshot = z.infer<typeof mcpAppSnapshotSchema>;

export const embeddedContentSnapshotSchema = z
  .object({
    instanceId: z.string().uuid(),
    rendererId: z.string().regex(/^[a-z0-9]+(?:[.-][a-z0-9-]+)+$/),
    title: z.string().trim().min(1).max(200),
    payload: z.json(),
    createdAt: z.string().datetime(),
  })
  .strict();

export type EmbeddedContentSnapshot = z.infer<
  typeof embeddedContentSnapshotSchema
>;

export const embeddedContentRegistered = defineEvent({
  id: "borg.embeddedContent.registered",
  payload: z
    .object({
      sessionId: z.string().uuid(),
      content: embeddedContentSnapshotSchema,
    })
    .strict(),
});

export const mcpAppRequestIdSchema = z.union([
  z.string().min(1).max(256),
  z.number().int().safe(),
]);

export type McpAppRequestId = z.infer<typeof mcpAppRequestIdSchema>;

const mcpAppBridgeJsonSchema = z.json().refine(
  (value) =>
    new TextEncoder().encode(JSON.stringify(value)).byteLength <=
    MCP_APP_MAX_MESSAGE_BYTES - 1_024,
  "MCP App bridge value exceeds the size cap",
);

export const mcpAppToolArgumentsSchema = z
  .record(z.string().min(1).max(256), z.json())
  .superRefine((value, context) => {
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 256 * 1024) {
      context.addIssue({
        code: "custom",
        message: "MCP App tool arguments exceed the size cap",
      });
    }
  });
export type McpAppToolArguments = z.infer<
  typeof mcpAppToolArgumentsSchema
>;

export const mcpAppsInvokeTool = defineCommand({
  id: "borg.mcpApps.invokeTool",
  input: z
    .object({
      appInstanceId: z.string().uuid(),
      invocationId: z.string().uuid(),
      requestId: mcpAppRequestIdSchema,
      toolName: z.string().min(1).max(256),
      arguments: mcpAppToolArgumentsSchema.default({}),
    })
    .strict(),
  output: z
    .object({
      requestId: mcpAppRequestIdSchema,
      result: mcpAppBridgeJsonSchema,
    })
    .strict(),
  timeoutMs: 300_000,
});

export const mcpAppsCancelTool = defineCommand({
  id: "borg.mcpApps.cancelTool",
  input: z
    .object({
      appInstanceId: z.string().uuid(),
      invocationId: z.string().uuid(),
    })
    .strict(),
  output: z.object({ cancelled: z.boolean() }).strict(),
});

export const mcpAppToolResponseSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("succeeded"),
      result: mcpAppBridgeJsonSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("failed"),
      error: commandErrorSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("cancelled"),
    })
    .strict(),
]);

export const mcpAppToolResponded = defineEvent({
  id: "borg.mcpApps.toolResponded",
  payload: z
    .object({
      appInstanceId: z.string().uuid(),
      invocationId: z.string().uuid(),
      requestId: mcpAppRequestIdSchema,
      response: mcpAppToolResponseSchema,
      respondedAt: z.string().datetime(),
    })
    .strict(),
});

export const toolApprovalSchema = z.enum(["auto", "ask", "deny"]);

export type ToolApproval = z.infer<typeof toolApprovalSchema>;

export type OutputProvenance = "trusted" | "external";

export interface ToolSecurityMetadata {
  readonly inputClassification?: DataClassification | undefined;
  readonly outputClassification?: DataClassification | undefined;
  readonly outputProvenance?: OutputProvenance | undefined;
  readonly channelCapacity?: ChannelCapacity | undefined;
}

export interface DynamicToolDefinition {
  readonly id: string;
  readonly description: string;
  readonly inputSchema: unknown;
  readonly outputSchema?: unknown | undefined;
  readonly approval: ToolApproval;
  readonly sideEffect: boolean;
  readonly modelVisible?: boolean | undefined;
  readonly security?: ToolSecurityMetadata | undefined;
}

export const webSearchHitSchema = z
  .object({
    title: z.string().min(1),
    url: z.string().url(),
    snippet: z.string(),
  })
  .strict();

export type WebSearchHit = z.infer<typeof webSearchHitSchema>;

export const webSearchInputSchema = z
  .object({
    query: z.string().min(1).max(2_000),
    maxResults: z.number().int().min(1).max(10).optional(),
  })
  .strict();

export type WebSearchInput = z.input<typeof webSearchInputSchema>;

export const webSearchOutputSchema = z
  .object({
    query: z.string(),
    hits: z.array(webSearchHitSchema),
  })
  .strict();

export type WebSearchOutput = z.infer<typeof webSearchOutputSchema>;

export const searchProviderStatusSchema = z
  .object({
    hasKey: z.boolean(),
    enabled: z.boolean(),
    connected: z.boolean(),
  })
  .strict();

export type SearchProviderStatus = z.infer<typeof searchProviderStatusSchema>;

export const tavilyGetStatus = defineCommand({
  id: "borg.search.tavily.getStatus",
  input: z.object({}).strict(),
  output: searchProviderStatusSchema,
});

export const tavilyConnect = defineCommand({
  id: "borg.search.tavily.connect",
  input: z.object({}).strict(),
  output: searchProviderStatusSchema,
});

export const tavilyDisconnect = defineCommand({
  id: "borg.search.tavily.disconnect",
  input: z.object({}).strict(),
  output: searchProviderStatusSchema,
});

export const braveGetStatus = defineCommand({
  id: "borg.search.brave.getStatus",
  input: z.object({}).strict(),
  output: searchProviderStatusSchema,
});

export const braveConnect = defineCommand({
  id: "borg.search.brave.connect",
  input: z.object({}).strict(),
  output: searchProviderStatusSchema,
});

export const braveDisconnect = defineCommand({
  id: "borg.search.brave.disconnect",
  input: z.object({}).strict(),
  output: searchProviderStatusSchema,
});

export const a2aConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    port: z.number().int().min(1).max(65_535).default(8_733),
    personaId: z.string().min(1).optional(),
  })
  .strict();

export type A2AConfig = z.infer<typeof a2aConfigSchema>;

export const a2aStatusSchema = z
  .object({
    enabled: z.boolean(),
    listening: z.boolean(),
    port: z.number().int().min(1).max(65_535),
    personaId: z.string().min(1).optional(),
  })
  .strict();

export type A2AStatus = z.infer<typeof a2aStatusSchema>;

export const a2aGetStatus = defineCommand({
  id: "borg.a2a.getStatus",
  input: z.object({}).strict(),
  output: a2aStatusSchema,
});

export const imapChannelInject = defineCommand({
  id: "borg.channel.imap.inject",
  input: z
    .object({
      destinationId: z.string().min(1).max(256).optional(),
      externalId: z.string().min(1).max(256).optional(),
      text: z.string().max(65_536),
      sender: z.string().min(1).max(256).optional(),
      classification: dataClassificationSchema.optional(),
    })
    .strict(),
  output: z
    .object({ accepted: z.literal(true), externalId: z.string() })
    .strict(),
});

