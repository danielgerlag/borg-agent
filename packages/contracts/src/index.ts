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
    duration: z.enum(["once", "session", "always"]).optional(),
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

export const workspaceFileSchema = z
  .object({
    path: z.string().min(1),
    size: z.number().int().nonnegative(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type WorkspaceFile = z.infer<typeof workspaceFileSchema>;

export const workspacePreviewSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("text"),
      path: z.string().min(1),
      size: z.number().int().nonnegative(),
      content: z.string(),
      truncated: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("image"),
      path: z.string().min(1),
      size: z.number().int().nonnegative(),
      mimeType: z.string().min(1),
      content: z.string(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("binary"),
      path: z.string().min(1),
      size: z.number().int().nonnegative(),
    })
    .strict(),
]);

export type WorkspacePreview = z.infer<typeof workspacePreviewSchema>;

export const workspaceImportResultSchema = z
  .object({
    files: z.array(workspaceFileSchema),
    imported: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
  })
  .strict();

export type WorkspaceImportResult = z.infer<typeof workspaceImportResultSchema>;

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
      metadata: z.record(z.string(), z.json()).default({}),
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

export const DEFAULT_CONNECTOR_ACCOUNT_ID = "default";
export const CONNECTOR_ACCOUNT_ID_MAX = 32;
export const CONNECTOR_ACCOUNT_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const connectorAccountIdSchema = z
  .string()
  .min(1)
  .max(CONNECTOR_ACCOUNT_ID_MAX)
  .regex(CONNECTOR_ACCOUNT_ID_PATTERN);

function isUnprefixedConnectorAccountId(
  accountId: string | undefined,
): accountId is undefined | "" | typeof DEFAULT_CONNECTOR_ACCOUNT_ID {
  return (
    accountId === undefined ||
    accountId.length === 0 ||
    accountId === DEFAULT_CONNECTOR_ACCOUNT_ID
  );
}

function parsedConnectorAccountId(accountId: string): string {
  const parsed = connectorAccountIdSchema.safeParse(accountId);
  if (!parsed.success) {
    throw new Error("Connector account id is invalid");
  }
  return parsed.data;
}

export function connectorAdapterId(
  pluginId: string,
  accountId: string,
): string {
  if (isUnprefixedConnectorAccountId(accountId)) {
    return pluginId;
  }
  return `${pluginId}.${parsedConnectorAccountId(accountId)}`;
}

export function connectorSecretKey(accountId: string, leaf: string): string {
  if (isUnprefixedConnectorAccountId(accountId)) {
    return leaf;
  }
  return `${parsedConnectorAccountId(accountId)}.${leaf}`;
}

export function connectorStoreKey(accountId: string, leaf: string): string {
  if (isUnprefixedConnectorAccountId(accountId)) {
    return leaf;
  }
  return `${parsedConnectorAccountId(accountId)}/${leaf}`;
}

export function oauthGrantKey(pluginId: string, accountId?: string): string {
  if (isUnprefixedConnectorAccountId(accountId)) {
    return pluginId;
  }
  return `${pluginId}.${parsedConnectorAccountId(accountId)}`;
}

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

export {
  MCP_APP_CSP_QUERY_MAX_CHARS,
  buildAllowAttribute,
  buildAppCsp,
  buildPermissionsPolicy,
  buildProxyCsp,
  encodeMcpAppCspQuery,
  encodeMcpAppPermissionsQuery,
  grantFromProxyUrl,
  mcpAppRequestAllowed,
  originMatchesGrant,
  parseMcpAppNetworkGrant,
  permissionsFromProxyUrl,
  type McpAppNetworkGrant,
} from "./mcp-app-csp";

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

export const a2aConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    port: z.number().int().min(1).max(65_535).default(8_733),
    personaId: z.string().optional(),
  })
  .strict()
  .transform((value) => {
    const personaId = value.personaId?.trim();
    return {
      enabled: value.enabled,
      port: value.port,
      ...(personaId !== undefined && personaId.length > 0
        ? { personaId }
        : {}),
    };
  });

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

