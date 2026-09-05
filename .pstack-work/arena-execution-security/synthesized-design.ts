import { z } from "zod";

export const executionIdSchema = z.string().uuid().brand<"ExecutionId">();
export type ExecutionId = z.infer<typeof executionIdSchema>;

export const modelOperationKeySchema = z
  .string()
  .min(1)
  .max(240)
  .regex(/^[a-z0-9][a-z0-9./:_-]*$/)
  .brand<"ModelOperationKey">();
export type ModelOperationKey = z.infer<typeof modelOperationKeySchema>;

export const executionSubjectSchema = z
  .object({
    kind: z.string().regex(/^[a-z][a-z0-9-]*$/).max(80),
    id: z.string().min(1).max(240),
  })
  .strict();
export type ExecutionSubject = z.infer<typeof executionSubjectSchema>;

export const dataClassificationSchema = z.enum([
  "public",
  "internal",
  "confidential",
  "restricted",
]);
export type DataClassification = z.infer<typeof dataClassificationSchema>;

export const egressCapacitySchema = z.enum([
  "public",
  "internal",
  "private",
  "local-only",
]);
export type EgressCapacity = z.infer<typeof egressCapacitySchema>;

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
      capacity: egressCapacitySchema.exclude(["local-only"]),
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
]);
export type ProvenanceSeed = z.infer<typeof provenanceSeedSchema>;

export const executionCloseSchema = z.discriminatedUnion("state", [
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
      closedAt: z.string().datetime(),
    })
    .strict(),
]);

export const executionSecuritySummarySchema = z
  .object({
    id: executionIdSchema,
    ownerPluginId: z.string().min(1),
    subject: executionSubjectSchema,
    parentExecutionId: executionIdSchema.optional(),
    classification: dataClassificationSchema,
    classificationRevision: z.number().int().positive(),
    lifecycle: executionCloseSchema,
  })
  .strict();
export type ExecutionSecuritySummary = z.infer<
  typeof executionSecuritySummarySchema
>;

declare const parentExecutionGrantBrand: unique symbol;

export interface ParentExecutionGrant {
  readonly [parentExecutionGrantBrand]: true;
}

export type ExecutionBindIntent =
  | {
      readonly mode: "root";
      readonly subject: ExecutionSubject;
      readonly classification: DataClassification;
      readonly provenance: ProvenanceSeed;
    }
  | {
      readonly mode: "child";
      readonly subject: ExecutionSubject;
      readonly parent: ParentExecutionGrant;
    }
  | {
      readonly mode: "resume";
      readonly executionId: ExecutionId;
    };

export interface ExecutionBinding {
  readonly id: ExecutionId;
  observe(input: {
    readonly classification: DataClassification;
    readonly provenance: ProvenanceSeed;
    readonly reason: string;
  }): Promise<ExecutionSecuritySummary>;
  importDetachedResult(childExecutionId: ExecutionId): Promise<
    ExecutionSecuritySummary
  >;
  summary(): Promise<ExecutionSecuritySummary>;
  close(input: {
    readonly outcome:
      | "completed"
      | "failed"
      | "cancelled"
      | "interrupted"
      | "deleted";
    readonly reason: string;
  }): Promise<ExecutionSecuritySummary>;
}

export interface PluginExecutions {
  bind(intent: ExecutionBindIntent): Promise<ExecutionBinding>;
}

export type LoopSecurityInput =
  | {
      readonly kind: "root";
      readonly classification: DataClassification;
      readonly provenance: ProvenanceSeed;
    }
  | {
      readonly kind: "child";
      readonly parent: ParentExecutionGrant;
    };

export interface SecuredLoopStartInput {
  readonly prompt: string;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly allowedTools?: readonly string[];
  readonly personaId?: string;
  readonly sessionId?: string;
  readonly conversation?: readonly {
    readonly role: "user" | "assistant";
    readonly content: string;
  }[];
  readonly security: LoopSecurityInput;
}

export interface ModelMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
}

export interface ModelToolDefinition {
  readonly id: string;
  readonly description: string;
  readonly inputSchema: unknown;
}

export interface PluginModelCompletionRequest {
  readonly executionId: ExecutionId;
  readonly operationKey: ModelOperationKey;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly messages: readonly ModelMessage[];
}

export interface ReleasedModelCompletion {
  readonly providerId: string;
  readonly modelId: string;
  readonly content?: string;
  readonly toolCalls?: readonly {
    readonly id: string;
    readonly name: string;
    readonly input: unknown;
  }[];
  readonly replayed: boolean;
}

export interface ProviderDispatchPermit {
  commit(): Promise<void>;
}

export interface LlmProviderContribution {
  readonly id: string;
  readonly models: readonly string[];
  readonly egress: ProviderEgress;
  complete(
    request: {
      readonly modelId: string;
      readonly messages: readonly ModelMessage[];
      readonly tools: readonly ModelToolDefinition[];
    },
    permit: ProviderDispatchPermit,
    signal: AbortSignal,
    onRawToken?: (token: string) => void | Promise<void>,
  ): Promise<ReleasedModelCompletion>;
}

export interface PluginModels {
  registerProvider(provider: LlmProviderContribution): {
    dispose(): void | Promise<void>;
  };
  complete(
    request: PluginModelCompletionRequest,
    signal?: AbortSignal,
  ): Promise<ReleasedModelCompletion>;
}

export interface KernelModelGateway {
  complete(
    principal: {
      readonly ownerPluginId: string;
      readonly feature: string;
    },
    request: PluginModelCompletionRequest & {
      readonly tools: readonly ModelToolDefinition[];
    },
    signal: AbortSignal,
    observer?: {
      onPolicyWait?(interactionId: string): void;
      onApprovedToken?(token: string): void | Promise<void>;
    },
  ): Promise<ReleasedModelCompletion>;
}

export const modelCallRecordSchema = z.discriminatedUnion("phase", [
  z
    .object({
      phase: z.literal("prepared"),
      executionId: executionIdSchema,
      operationKey: modelOperationKeySchema,
      requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
      providerId: z.string().min(1),
      providerRegistrationId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      phase: z.literal("dispatched"),
      executionId: executionIdSchema,
      operationKey: modelOperationKeySchema,
      requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
      providerId: z.string().min(1),
      providerRegistrationId: z.string().uuid(),
      classification: dataClassificationSchema,
      classificationRevision: z.number().int().positive(),
      dispatchedAt: z.string().datetime(),
    })
    .strict(),
  z
    .object({
      phase: z.literal("released"),
      executionId: executionIdSchema,
      operationKey: modelOperationKeySchema,
      requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
      providerId: z.string().min(1),
      providerRegistrationId: z.string().uuid(),
      result: z.json(),
      releasedAt: z.string().datetime(),
    })
    .strict(),
  z
    .object({
      phase: z.literal("denied"),
      executionId: executionIdSchema,
      operationKey: modelOperationKeySchema,
      requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
      providerId: z.string().min(1),
      providerRegistrationId: z.string().uuid(),
      stage: z.enum(["model_input", "model_output"]),
      deniedAt: z.string().datetime(),
    })
    .strict(),
]);

export interface ExecutionSecurityStore {
  bind(
    ownerPluginId: string,
    intent: ExecutionBindIntent,
    resultFlow: "merge_to_parent" | "detached",
  ): Promise<ExecutionBinding>;
  loadModelCall(
    executionId: ExecutionId,
    operationKey: ModelOperationKey,
  ): Promise<z.infer<typeof modelCallRecordSchema> | undefined>;
}

export const moduleMap = {
  "packages/kernel/src/execution-security.ts":
    "Durable subject binding, classification, bounded provenance, parent grants, child merge, and recovery.",
  "packages/kernel/src/model-gateway.ts":
    "Provider registry, canonical request digest, scans, egress authorization, permit, usage, output hold, and release.",
  "packages/kernel/src/loop-manager.ts":
    "Requires explicit security input and emits only approved tokens.",
  "packages/kernel/src/plugin-manager.ts":
    "Injects principals, grants, and secured model and execution facades.",
  "packages/kernel/src/command-event-bus.ts":
    "Carries the runtime-only parent grant through a nested active command chain.",
  "plugins/chat/src/main.ts":
    "Persists a turn identity before loop start and keeps detached child sessions separate.",
  "plugins/graphs/src/executor.ts":
    "Persists one instance binding and derives stable prompt keys from node attempts.",
  "plugins/bots/src/runtime.ts":
    "Persists attempt identity before loop start and marks missing loops interrupted.",
  "plugins/mock-llm/src/main.ts":
    "Declares local-only egress and commits the permit before generation.",
  "plugins/anthropic/src/runtime.ts":
    "Declares internal remote egress and commits the permit immediately before fetch.",
} as const;

export const firstWaveRules = [
  "No plugin-owned loop may create an implicit internal root.",
  "Only ToolService and PluginManager may mint or carry ParentExecutionGrant.",
  "The host chooses merge_to_parent or detached from the operation type.",
  "Raw provider output stays in memory until completed-output approval.",
  "Denied output reaches no event, return value, log, or durable body.",
  "Released graph results persist and replay once by operation key and digest.",
  "Prepared calls may retry. Dispatched calls never retry automatically.",
  "Provider disposal invalidates its immutable registration ID.",
  "Anthropic starts at internal capacity. Mock remains local-only.",
  "Legacy durable records seed restricted classification and legacy provenance.",
] as const;
