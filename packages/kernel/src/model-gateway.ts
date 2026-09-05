import {
  executionIdSchema,
  executionSecuritySummarySchema,
  modelCompletionResultSchema,
  modelGatewayRequestSchema,
  modelOperationKeySchema,
  modelUsageSchema,
  providerEgressSchema,
  releasedModelCompletionSchema,
  type ChannelCapacity,
  type DataClassification,
  type ExecutionId,
  type ExecutionObservationInput,
  type ExecutionSecuritySummary,
  type ModelCompletionResult,
  type ModelMessage,
  type ModelOperationKey,
  type ModelToolDefinition,
  type ModelUsage,
  type ProviderEgress,
  type ReleasedModelCompletion,
} from "@borg/contracts";
import {
  IndeterminateModelCallError,
  z,
  type Disposable,
  type JsonValue,
  type LlmProviderContribution,
  type ProviderDispatchPermit,
} from "@borg/plugin-sdk";
import { createHash, randomUUID } from "node:crypto";
import { CostLedger } from "./cost-ledger";
import { StoreFacade } from "./persistence";

export {
  modelOperationKeySchema,
  providerEgressSchema,
  type ProviderEgress,
};
export type {
  LlmProviderContribution,
  ProviderDispatchPermit,
} from "@borg/plugin-sdk";
export { IndeterminateModelCallError } from "@borg/plugin-sdk";

const STORE_NAMESPACE = "kernel.execution-security";
const MODEL_CALL_PREFIX = "model-calls/";
const DEFAULT_MAX_HELD_OUTPUT_BYTES = 1_048_576;
const pluginIdSchema = z.string().min(1).max(200);
const providerIdSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:[.-][a-z0-9-]+)+$/);
const providerRegistrationIdSchema = z.string().uuid();
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const modelScanStageSchema = z.enum(["model_input", "model_output"]);

const scanReportSchema = z
  .object({
    stage: modelScanStageSchema,
    findings: z.array(
      z
        .object({
          scannerId: z.string().min(1),
          code: z.string().min(1),
          action: z.enum(["allow", "review", "block"]),
          reason: z.string(),
        })
        .passthrough(),
    ),
    failures: z.array(
      z
        .object({
          scannerId: z.string().min(1),
          kind: z.enum(["timeout", "error", "invalid"]),
          message: z.string(),
        })
        .strict(),
    ),
    coverage: z.enum(["complete", "partial", "none"]),
    truncated: z.boolean(),
    unavailableAction: z.literal("review"),
  })
  .passthrough();

export type ModelScanReport = z.infer<typeof scanReportSchema>;

const authorizationResultSchema = z
  .object({
    allowed: z.boolean(),
    interactionUsed: z.boolean(),
    reasons: z.array(z.string()),
  })
  .passthrough();

export type ProviderComplete = LlmProviderContribution["complete"];

const providerCompleteSchema = z.custom<ProviderComplete>(
  (value) => typeof value === "function",
  "Provider completion callback is required",
);

const providerMetadataSchema = z
  .object({
    id: providerIdSchema,
    models: z.array(z.string().min(1)).min(1),
    egress: providerEgressSchema,
    complete: providerCompleteSchema,
  })
  .strict();

const modelCallBaseSchema = z
  .object({
    executionId: executionIdSchema,
    operationKey: modelOperationKeySchema,
    requestDigest: digestSchema,
    providerId: providerIdSchema,
    providerRegistrationId: providerRegistrationIdSchema,
    modelId: z.string().min(1),
    egress: providerEgressSchema,
  })
  .strict();

const preparedModelCallSchema = modelCallBaseSchema.extend({
  phase: z.literal("prepared"),
  preparedAt: z.string().datetime(),
});

const dispatchedModelCallSchema = modelCallBaseSchema.extend({
  phase: z.literal("dispatched"),
  classification: z.enum([
    "public",
    "internal",
    "confidential",
    "restricted",
  ]),
  classificationRevision: z.number().int().positive(),
  dispatchedAt: z.string().datetime(),
});

const outputPendingModelCallSchema = modelCallBaseSchema.extend({
  phase: z.literal("output-pending"),
  classification: z.enum([
    "public",
    "internal",
    "confidential",
    "restricted",
  ]),
  classificationRevision: z.number().int().positive(),
  dispatchedAt: z.string().datetime(),
  outputDigest: digestSchema,
  usage: modelUsageSchema,
});

const releasedModelCallSchema = modelCallBaseSchema.extend({
  phase: z.literal("released"),
  classification: z.enum([
    "public",
    "internal",
    "confidential",
    "restricted",
  ]),
  classificationRevision: z.number().int().positive(),
  dispatchedAt: z.string().datetime(),
  outputDigest: digestSchema,
  result: modelCompletionResultSchema,
  releasedAt: z.string().datetime(),
});

const deniedModelCallSchema = modelCallBaseSchema.extend({
  phase: z.literal("denied"),
  stage: modelScanStageSchema,
  deniedAt: z.string().datetime(),
  usage: modelUsageSchema.optional(),
});

const failedModelCallSchema = modelCallBaseSchema.extend({
  phase: z.literal("failed"),
  failedAt: z.string().datetime(),
  errorCode: z.string().min(1).max(80),
  usage: modelUsageSchema.optional(),
});

export const modelCallRecordSchema = z.discriminatedUnion("phase", [
  preparedModelCallSchema,
  dispatchedModelCallSchema,
  outputPendingModelCallSchema,
  releasedModelCallSchema,
  deniedModelCallSchema,
  failedModelCallSchema,
]);

export type ModelCallRecord = z.infer<typeof modelCallRecordSchema>;
type DispatchedModelCall = z.infer<typeof dispatchedModelCallSchema>;
type OutputPendingModelCall = z.infer<
  typeof outputPendingModelCallSchema
>;

interface PreparedModelCall {
  readonly executionId: ExecutionId;
  readonly operationKey: ModelOperationKey;
  readonly requestDigest: string;
  readonly providerId: string;
  readonly providerRegistrationId: string;
  readonly modelId: string;
  readonly egress: ProviderEgress;
}

interface DispatchPermitState {
  value: "ready" | "committing" | "dispatched";
}

export class DurableModelCallJournal {
  constructor(readonly store: StoreFacade) {}

  async load(
    executionIdCandidate: unknown,
    operationKeyCandidate: unknown,
  ): Promise<ModelCallRecord | undefined> {
    const executionId = executionIdSchema.parse(executionIdCandidate);
    const operationKey = modelOperationKeySchema.parse(
      operationKeyCandidate,
    );
    const value = await this.store.get(
      STORE_NAMESPACE,
      this.#key(executionId, operationKey),
    );
    return value === undefined
      ? undefined
      : modelCallRecordSchema.parse(value);
  }

  async prepare(input: PreparedModelCall): Promise<ModelCallRecord> {
    const existing = await this.load(
      input.executionId,
      input.operationKey,
    );
    if (existing) {
      return existing;
    }
    return await this.save({
      ...input,
      phase: "prepared",
      preparedAt: new Date().toISOString(),
    });
  }

  async save(candidate: unknown): Promise<ModelCallRecord> {
    const record = modelCallRecordSchema.parse(candidate);
    await this.store.set(
      STORE_NAMESPACE,
      this.#key(record.executionId, record.operationKey),
      z.json().parse(record),
    );
    return record;
  }

  #key(
    executionId: ExecutionId,
    operationKey: ModelOperationKey,
  ): string {
    return `${MODEL_CALL_PREFIX}${executionId}/${encodeURIComponent(operationKey)}`;
  }
}

export interface ModelGatewayExecutionPort {
  summary(
    ownerPluginId: string,
    executionId: ExecutionId,
  ): Promise<unknown>;
  observe(
    ownerPluginId: string,
    executionId: ExecutionId,
    input: ExecutionObservationInput,
  ): Promise<unknown>;
  commitIfCurrent<T>(
    ownerPluginId: string,
    executionId: ExecutionId,
    expectedRevision: number,
    operation: (
      summary: ExecutionSecuritySummary,
    ) => Promise<T>,
  ): Promise<
    | { readonly committed: true; readonly value: T }
    | { readonly committed: false }
  >;
}

export interface ModelGatewayScannerPort {
  scan(request: {
    readonly stage: "model_input" | "model_output";
    readonly text: string;
    readonly source: {
      readonly kind: "user" | "channel" | "tool" | "model";
      readonly id: string;
    };
    readonly executionId: ExecutionId;
    readonly runId: string;
    readonly signal: AbortSignal;
  }): Promise<unknown>;
}

export interface ModelGatewayAuthorizerPort {
  authorize(request: {
    readonly pluginId: string;
    readonly feature: "model_input" | "model_output";
    readonly title: string;
    readonly approval: "auto";
    readonly runId: string;
    readonly payloadClassification: DataClassification;
    readonly classificationRevision: number;
    readonly capacity: ChannelCapacity;
    readonly toolCallId: string;
    readonly scanReport: ModelScanReport;
    readonly signal: AbortSignal;
    readonly interactionUsed?: boolean | undefined;
    onInteraction?(interactionId: string): void;
  }): Promise<unknown>;
}

export interface ModelGatewayOptions {
  readonly fallbackPreferences?: readonly string[];
  readonly maxHeldOutputBytes?: number;
}

export interface ModelGatewayDependencies {
  readonly journal: DurableModelCallJournal;
  readonly executions: ModelGatewayExecutionPort;
  readonly scanners: ModelGatewayScannerPort;
  readonly authorizer: ModelGatewayAuthorizerPort;
  readonly costs: CostLedger;
  readonly options?: ModelGatewayOptions;
}

export interface ModelGatewayPrincipal {
  readonly ownerPluginId: string;
  readonly feature: string;
  readonly runId?: string | undefined;
}

export interface ModelGatewayObserver {
  onPolicyWait?(interactionId: string): void;
  onApprovedToken?(token: string): void | Promise<void>;
}

interface RegisteredProvider {
  readonly ownerPluginId: string;
  readonly registrationId: string;
  readonly provider: Readonly<LlmProviderContribution>;
  readonly ownerSignal?: AbortSignal | undefined;
  trackOperation?<T>(operation: Promise<T>): Promise<T>;
}

export interface ProviderRegistrationOptions {
  readonly ownerSignal?: AbortSignal | undefined;
  trackOperation?<T>(operation: Promise<T>): Promise<T>;
}

export class ModelOperationConflictError extends Error {
  constructor(
    readonly executionId: ExecutionId,
    readonly operationKey: ModelOperationKey,
  ) {
    super(
      `Model operation ${operationKey} was reused with a different request`,
    );
    this.name = "ModelOperationConflictError";
  }
}

export class ModelInputDeniedError extends Error {
  constructor() {
    super("Model input was denied");
    this.name = "ModelInputDeniedError";
  }
}

export class ModelOutputDeniedError extends Error {
  constructor() {
    super("Model output was denied");
    this.name = "ModelOutputDeniedError";
  }
}

export class ModelProviderFailedError extends Error {
  constructor(
    readonly providerId: string,
    readonly reason: "cancelled" | "failed" | "unavailable",
  ) {
    super(
      reason === "cancelled"
        ? "Model call was cancelled"
        : reason === "unavailable"
          ? `LLM provider ${providerId} is no longer available`
          : `LLM provider ${providerId} failed`,
    );
    this.name = "ModelProviderFailedError";
  }
}

export class ModelGateway {
  readonly #providers = new Map<string, RegisteredProvider>();
  readonly #revokedRegistrationIds = new Set<string>();
  readonly #fallbackPreferences: readonly string[];
  readonly #maxHeldOutputBytes: number;

  constructor(readonly dependencies: ModelGatewayDependencies) {
    this.#fallbackPreferences = Object.freeze([
      ...(dependencies.options?.fallbackPreferences ?? []),
    ]);
    this.#maxHeldOutputBytes =
      dependencies.options?.maxHeldOutputBytes ??
      DEFAULT_MAX_HELD_OUTPUT_BYTES;
  }

  registerProvider(
    ownerPluginIdCandidate: unknown,
    candidate: unknown,
    options: ProviderRegistrationOptions = {},
  ): Disposable {
    const ownerPluginId = pluginIdSchema.parse(ownerPluginIdCandidate);
    const parsed = providerMetadataSchema.parse(candidate);
    if (this.#providers.has(parsed.id)) {
      throw new Error(`LLM provider ${parsed.id} is already registered`);
    }
    const registration: RegisteredProvider = {
      ownerPluginId,
      registrationId: randomUUID(),
      provider: Object.freeze({
        id: parsed.id,
        models: Object.freeze([...parsed.models]),
        egress: Object.freeze(parsed.egress),
        complete: parsed.complete.bind(candidate),
      }),
      ...(options.ownerSignal === undefined
        ? {}
        : { ownerSignal: options.ownerSignal }),
      ...(options.trackOperation === undefined
        ? {}
        : { trackOperation: options.trackOperation }),
    };
    this.#providers.set(parsed.id, registration);
    return {
      dispose: () => {
        if (this.#providers.get(parsed.id) === registration) {
          this.#revokedRegistrationIds.add(
            registration.registrationId,
          );
          this.#providers.delete(parsed.id);
        }
      },
    };
  }

  removePlugin(ownerPluginId: string): void {
    for (const [providerId, registration] of this.#providers) {
      if (registration.ownerPluginId === ownerPluginId) {
        this.#revokedRegistrationIds.add(
          registration.registrationId,
        );
        this.#providers.delete(providerId);
      }
    }
  }

  listModels(): readonly {
    readonly providerId: string;
    readonly modelId: string;
    readonly preferenceId: string;
    readonly egress: ProviderEgress;
  }[] {
    return Object.freeze(
      [...this.#providers.values()]
        .flatMap((registration) =>
          registration.provider.models.map((modelId) =>
            Object.freeze({
              providerId: registration.provider.id,
              modelId,
              preferenceId: `${registration.provider.id}:${modelId}`,
              egress: registration.provider.egress,
            }),
          ),
        )
        .sort((left, right) =>
          left.preferenceId.localeCompare(right.preferenceId),
        ),
    );
  }

  resolvePreferences(
    preferences: readonly string[],
  ):
    | {
        readonly providerId: string;
        readonly modelId: string;
      }
    | undefined {
    for (const preference of preferences) {
      const separator = preference.indexOf(":");
      const providerPattern =
        separator > 0 ? preference.slice(0, separator) : "*";
      const modelPattern =
        separator > 0
          ? preference.slice(separator + 1)
          : preference;
      for (const registration of this.#providers.values()) {
        if (!matches(registration.provider.id, providerPattern)) {
          continue;
        }
        const modelId = registration.provider.models.find((candidate) =>
          matches(candidate, modelPattern),
        );
        if (modelId) {
          return {
            providerId: registration.provider.id,
            modelId,
          };
        }
      }
    }
    return undefined;
  }

  async complete(
    principalCandidate: unknown,
    requestCandidate: unknown,
    signal: AbortSignal,
    observer: ModelGatewayObserver = {},
  ): Promise<ReleasedModelCompletion> {
    signal.throwIfAborted();
    const principal = z
      .object({
        ownerPluginId: pluginIdSchema,
        feature: z.string().min(1).max(200),
        runId: z.string().min(1).optional(),
      })
      .strict()
      .parse(principalCandidate);
    const request = modelGatewayRequestSchema.parse(requestCandidate);
    const initialSecurity = executionSecuritySummarySchema.parse(
      await this.dependencies.executions.summary(
        principal.ownerPluginId,
        request.executionId,
      ),
    );
    ensureExecutionOpen(initialSecurity);
    let existing = await this.dependencies.journal.load(
      request.executionId,
      request.operationKey,
    );
    if (
      existing &&
      ((request.providerId !== undefined &&
        request.providerId !== existing.providerId) ||
        (request.modelId !== undefined &&
          request.modelId !== existing.modelId))
    ) {
      throw new ModelOperationConflictError(
        request.executionId,
        request.operationKey,
      );
    }
    const target = existing
      ? {
          providerId: existing.providerId,
          modelId: existing.modelId,
        }
      : this.#resolveTarget(request.providerId, request.modelId);
    const canonicalInput = stableJson({
      messages: request.messages,
      modelId: target.modelId,
      tools: request.tools,
    });
    const inputScanText = modelInputScanText({
      modelId: target.modelId,
      messages: request.messages,
      tools: request.tools,
    });
    const requestDigest = hashText(
      stableJson({
        input: canonicalInput,
        providerId: target.providerId,
      }),
    );
    if (existing && existing.requestDigest !== requestDigest) {
      throw new ModelOperationConflictError(
        request.executionId,
        request.operationKey,
      );
    }
    if (existing?.phase === "released") {
      const replayed = releasedModelCompletionSchema.parse({
        providerId: existing.providerId,
        modelId: existing.modelId,
        ...existing.result,
        replayed: true,
      });
      if (replayed.content && observer.onApprovedToken) {
        await observer.onApprovedToken(replayed.content);
      }
      return replayed;
    }
    if (existing?.phase === "denied") {
      throw existing.stage === "model_output"
        ? new ModelOutputDeniedError()
        : new ModelInputDeniedError();
    }
    if (
      existing?.phase === "dispatched" ||
      existing?.phase === "output-pending"
    ) {
      throw new IndeterminateModelCallError(
        request.executionId,
        request.operationKey,
        existing.phase,
      );
    }
    if (existing?.phase === "failed") {
      throw new Error(
        `Model operation ${request.operationKey} already failed`,
      );
    }
    const registration = this.#providers.get(target.providerId);
    if (!registration) {
      throw new Error(`LLM provider ${target.providerId} is unavailable`);
    }
    if (!registration.provider.models.includes(target.modelId)) {
      throw new Error(
        `Model ${target.modelId} is unavailable from ${target.providerId}`,
      );
    }
    if (
      existing?.phase === "prepared" &&
      existing.providerRegistrationId !== registration.registrationId
    ) {
      if (
        this.#revokedRegistrationIds.has(
          existing.providerRegistrationId,
        ) ||
        stableJson(existing.egress) !==
          stableJson(registration.provider.egress)
      ) {
        throw new Error(
          `LLM provider ${target.providerId} registration changed`,
        );
      }
      existing = await this.dependencies.journal.save({
        ...existing,
        providerRegistrationId: registration.registrationId,
      });
    }
    const call: PreparedModelCall = {
      executionId: request.executionId,
      operationKey: request.operationKey,
      requestDigest,
      providerId: target.providerId,
      providerRegistrationId: registration.registrationId,
      modelId: target.modelId,
      egress: registration.provider.egress,
    };
    const prepared = await this.dependencies.journal.prepare(call);
    if (prepared.phase !== "prepared") {
      throw new Error(
        `Model operation ${request.operationKey} cannot resume from ${prepared.phase}`,
      );
    }
    const inputScan = scanReportSchema.parse(
      await this.dependencies.scanners.scan({
        stage: "model_input",
        text: inputScanText,
        source: {
          kind: "user",
          id: principal.ownerPluginId,
        },
        executionId: request.executionId,
        runId: request.executionId,
        signal,
      }),
    );
    const inputAuthorization = await this.#authorize({
      principal,
      executionId: request.executionId,
      stage: "model_input",
      security: initialSecurity,
      capacity: registration.provider.egress.capacity,
      scanReport: inputScan,
      signal,
      observer,
      toolCallId: `${request.operationKey}:${registration.provider.id}`,
    });
    if (!inputAuthorization.allowed) {
      await this.dependencies.journal.save({
        ...call,
        phase: "denied",
        stage: "model_input",
        deniedAt: new Date().toISOString(),
      });
      throw new ModelInputDeniedError();
    }

    const permitState: DispatchPermitState = { value: "ready" };
    let dispatched: DispatchedModelCall | undefined;
    const permit: ProviderDispatchPermit = Object.freeze({
      commit: async () => {
        if (permitState.value !== "ready") {
          throw new Error("Provider dispatch permit is already consumed");
        }
        permitState.value = "committing";
        let currentSecurity = executionSecuritySummarySchema.parse(
          await this.dependencies.executions.summary(
            principal.ownerPluginId,
            request.executionId,
          ),
        );
        let authorizedRevision =
          initialSecurity.classificationRevision;
        let interactionUsed = inputAuthorization.interactionUsed;
        while (true) {
          ensureExecutionOpen(currentSecurity);
          if (
            currentSecurity.classificationRevision !==
            authorizedRevision
          ) {
            const authorization = await this.#authorize({
              principal,
              executionId: request.executionId,
              stage: "model_input",
              security: currentSecurity,
              capacity: registration.provider.egress.capacity,
              scanReport: inputScan,
              signal,
              observer,
              interactionUsed,
              toolCallId: `${request.operationKey}:${registration.provider.id}`,
            });
            interactionUsed = authorization.interactionUsed;
            if (!authorization.allowed) {
              await this.dependencies.journal.save({
                ...call,
                phase: "denied",
                stage: "model_input",
                deniedAt: new Date().toISOString(),
              });
              throw new ModelInputDeniedError();
            }
            authorizedRevision =
              currentSecurity.classificationRevision;
          }
          const commit =
            await this.dependencies.executions.commitIfCurrent(
              principal.ownerPluginId,
              request.executionId,
              currentSecurity.classificationRevision,
              async (committedSecurity) => {
                if (
                  this.#providers.get(registration.provider.id) !==
                  registration
                ) {
                  throw new Error(
                    `LLM provider ${registration.provider.id} registration was revoked`,
                  );
                }
                const currentRecord =
                  await this.dependencies.journal.load(
                    request.executionId,
                    request.operationKey,
                  );
                if (
                  currentRecord?.phase !== "prepared" ||
                  currentRecord.providerRegistrationId !==
                    registration.registrationId
                ) {
                  throw new Error(
                    `Model operation ${request.operationKey} is no longer prepared`,
                  );
                }
                const record = dispatchedModelCallSchema.parse({
                  ...call,
                  phase: "dispatched",
                  classification:
                    committedSecurity.classification,
                  classificationRevision:
                    committedSecurity.classificationRevision,
                  dispatchedAt: new Date().toISOString(),
                });
                await this.dependencies.journal.save(record);
                return record;
              },
            );
          if (commit.committed) {
            dispatched = commit.value;
            permitState.value = "dispatched";
            return;
          }
          currentSecurity = executionSecuritySummarySchema.parse(
            await this.dependencies.executions.summary(
              principal.ownerPluginId,
              request.executionId,
            ),
          );
        }
      },
    });

    const heldTokens: string[] = [];
    let heldBytes = 0;
    let latestPartialUsage: ModelUsage | undefined;
    let resultCandidate: ModelCompletionResult;
    const providerSignal = registration.ownerSignal
      ? AbortSignal.any([signal, registration.ownerSignal])
      : signal;
    const providerOperation = Promise.resolve().then(() =>
      registration.provider.complete(
        {
          modelId: target.modelId,
          messages: request.messages,
          tools: request.tools,
        },
        permit,
        providerSignal,
        async (token) => {
          signal.throwIfAborted();
          if (permitState.value !== "dispatched") {
            throw new Error(
              "Provider emitted output before committing its dispatch permit",
            );
          }
          if (typeof token !== "string" || token.length === 0) {
            throw new Error(
              `Provider ${registration.provider.id} emitted an invalid token`,
            );
          }
          heldBytes += Buffer.byteLength(token);
          if (heldBytes > this.#maxHeldOutputBytes) {
            throw new Error(
              `Provider ${registration.provider.id} output exceeded the in-memory hold limit`,
            );
          }
          heldTokens.push(token);
        },
        (usage) => {
          latestPartialUsage = modelUsageSchema.parse(usage);
        },
      ),
    );
    const trackedProviderOperation = registration.trackOperation
      ? registration.trackOperation(providerOperation)
      : providerOperation;
    resultCandidate = await trackedProviderOperation.then(
      (result) => result,
      async (error: unknown) => {
        if (permitState.value === "dispatched") {
          if (latestPartialUsage) {
            this.#recordUsage({
              executionId: request.executionId,
              operationKey: request.operationKey,
              providerId: target.providerId,
              modelId: target.modelId,
              usage: latestPartialUsage,
              ...(principal.runId === undefined
                ? {}
                : { runId: principal.runId }),
            });
          }
          await this.dependencies.journal.save({
            ...call,
            phase: "failed",
            errorCode: signal.aborted
              ? "aborted"
              : "provider_failed",
            failedAt: new Date().toISOString(),
            ...(latestPartialUsage === undefined
              ? {}
              : { usage: latestPartialUsage }),
          });
        }
        if (error instanceof ModelInputDeniedError) {
          throw error;
        }
        throw new ModelProviderFailedError(
          registration.provider.id,
          signal.aborted
            ? "cancelled"
            : this.#providers.get(registration.provider.id) !==
                registration
              ? "unavailable"
              : "failed",
        );
      },
    );
    if (permitState.value !== "dispatched" || !dispatched) {
      throw new Error(
        `Provider ${registration.provider.id} returned without committing its dispatch permit`,
      );
    }
    const committedDispatch = dispatched;
    const result = modelCompletionResultSchema.parse(resultCandidate);
    const resultBytes = Buffer.byteLength(
      stableJson({
        content: result.content,
        toolCalls: result.toolCalls,
      }),
    );
    if (resultBytes > this.#maxHeldOutputBytes) {
      await this.dependencies.journal.save({
        ...call,
        phase: "failed",
        errorCode: "output_too_large",
        failedAt: new Date().toISOString(),
        usage: result.usage,
      });
      this.#recordUsage({
        executionId: request.executionId,
        operationKey: request.operationKey,
        providerId: target.providerId,
        modelId: target.modelId,
        usage: result.usage,
        ...(principal.runId === undefined
          ? {}
          : { runId: principal.runId }),
      });
      throw new Error(
        `Provider ${registration.provider.id} output exceeded the in-memory hold limit`,
      );
    }
    if (
      signal.aborted ||
      this.#providers.get(registration.provider.id) !== registration
    ) {
      this.#recordUsage({
        executionId: request.executionId,
        operationKey: request.operationKey,
        providerId: target.providerId,
        modelId: target.modelId,
        usage: result.usage,
        ...(principal.runId === undefined
          ? {}
          : { runId: principal.runId }),
      });
      await this.dependencies.journal.save({
        ...call,
        phase: "failed",
        errorCode: signal.aborted
          ? "aborted"
          : "provider_unavailable",
        failedAt: new Date().toISOString(),
        usage: result.usage,
      });
      throw new ModelProviderFailedError(
        registration.provider.id,
        signal.aborted ? "cancelled" : "unavailable",
      );
    }
    const heldContent = heldTokens.join("");
    if (
      heldTokens.length > 0 &&
      heldContent !== (result.content ?? "")
    ) {
      await this.dependencies.journal.save({
        ...call,
        phase: "failed",
        errorCode: "stream_mismatch",
        failedAt: new Date().toISOString(),
        usage: result.usage,
      });
      this.#recordUsage({
        executionId: request.executionId,
        operationKey: request.operationKey,
        providerId: target.providerId,
        modelId: target.modelId,
        usage: result.usage,
        ...(principal.runId === undefined
          ? {}
          : { runId: principal.runId }),
      });
      throw new Error(
        `Provider ${registration.provider.id} streamed content that did not match its final result`,
      );
    }
    const canonicalOutput = stableJson({
      content: result.content,
      toolCalls: result.toolCalls,
    });
    const outputScanText = modelOutputScanText(result);
    const outputPending: OutputPendingModelCall =
      outputPendingModelCallSchema.parse({
        ...call,
        phase: "output-pending",
        classification: committedDispatch.classification,
        classificationRevision:
          committedDispatch.classificationRevision,
        dispatchedAt: committedDispatch.dispatchedAt,
        outputDigest: hashText(canonicalOutput),
        usage: result.usage,
      });
    await this.dependencies.journal.save(outputPending);
    this.#recordUsage({
      executionId: request.executionId,
      operationKey: request.operationKey,
      providerId: target.providerId,
      modelId: target.modelId,
      usage: result.usage,
      ...(principal.runId === undefined
        ? {}
        : { runId: principal.runId }),
    });
    const outputScan = scanReportSchema.parse(
      await this.dependencies.scanners.scan({
        stage: "model_output",
        text: outputScanText,
        source: {
          kind: "model",
          id: registration.provider.id,
        },
        executionId: request.executionId,
        runId: request.executionId,
        signal: providerSignal,
      }),
    );
    let outputSecurity = executionSecuritySummarySchema.parse(
      await this.dependencies.executions.summary(
        principal.ownerPluginId,
        request.executionId,
      ),
    );
    let outputInteractionUsed = false;
    while (true) {
      ensureExecutionOpen(outputSecurity);
      const outputAuthorization = await this.#authorize({
        principal,
        executionId: request.executionId,
        stage: "model_output",
        security: outputSecurity,
        capacity: registration.provider.egress.capacity,
        scanReport: outputScan,
        signal: providerSignal,
        observer,
        interactionUsed: outputInteractionUsed,
        toolCallId: `${request.operationKey}:${registration.provider.id}`,
      });
      outputInteractionUsed = outputAuthorization.interactionUsed;
      if (!outputAuthorization.allowed) {
        await this.dependencies.journal.save({
          ...call,
          phase: "denied",
          stage: "model_output",
          deniedAt: new Date().toISOString(),
          usage: result.usage,
        });
        heldTokens.length = 0;
        throw new ModelOutputDeniedError();
      }
      const authorizedSecurity = outputSecurity;
      outputSecurity = executionSecuritySummarySchema.parse(
        await this.dependencies.executions.observe(
          principal.ownerPluginId,
          request.executionId,
          {
            classification: outputSecurity.classification,
            provenance: {
              kind: "plugin",
              id: `model:${registration.provider.id}`,
            },
            reason: `Approved model output from ${registration.provider.id}`,
          },
        ),
      );
      if (
        outputSecurity.classificationRevision !==
          authorizedSecurity.classificationRevision ||
        outputSecurity.classification !==
          authorizedSecurity.classification
      ) {
        continue;
      }
      const release = await this.dependencies.executions.commitIfCurrent(
        principal.ownerPluginId,
        request.executionId,
        outputSecurity.classificationRevision,
        async (currentSecurity) => {
          const blocked = this.#releaseBlockReason(
            registration,
            providerSignal,
          );
          if (blocked) {
            return {
              released: false as const,
              reason: blocked,
            };
          }
          const record = releasedModelCallSchema.parse({
            ...call,
            phase: "released",
            classification: currentSecurity.classification,
            classificationRevision:
              currentSecurity.classificationRevision,
            dispatchedAt: committedDispatch.dispatchedAt,
            outputDigest: outputPending.outputDigest,
            result,
            releasedAt: new Date().toISOString(),
          });
          await this.dependencies.journal.save(record);
          const blockedAfterSave = this.#releaseBlockReason(
            registration,
            providerSignal,
          );
          return blockedAfterSave
            ? {
                released: false as const,
                reason: blockedAfterSave,
              }
            : {
                released: true as const,
                classification: currentSecurity.classification,
              };
        },
      );
      if (release.committed) {
        if (!release.value.released) {
          await this.#failReleasedOutput(
            call,
            result.usage,
            release.value.reason,
          );
          throw new ModelProviderFailedError(
            registration.provider.id,
            release.value.reason,
          );
        }
        break;
      }
      outputSecurity = executionSecuritySummarySchema.parse(
        await this.dependencies.executions.summary(
          principal.ownerPluginId,
          request.executionId,
        ),
      );
    }
    const blockedBeforeDelivery = this.#releaseBlockReason(
      registration,
      providerSignal,
    );
    if (blockedBeforeDelivery) {
      await this.#failReleasedOutput(
        call,
        result.usage,
        blockedBeforeDelivery,
      );
      throw new ModelProviderFailedError(
        registration.provider.id,
        blockedBeforeDelivery,
      );
    }
    if (observer.onApprovedToken) {
      if (heldTokens.length > 0) {
        for (const token of heldTokens) {
          await observer.onApprovedToken(token);
        }
      } else if (result.content) {
        await observer.onApprovedToken(result.content);
      }
    }
    return releasedModelCompletionSchema.parse({
      providerId: target.providerId,
      modelId: target.modelId,
      content: result.content,
      toolCalls: result.toolCalls,
      usage: result.usage,
      replayed: false,
    });
  }

  async #authorize(input: {
    readonly principal: ModelGatewayPrincipal;
    readonly executionId: ExecutionId;
    readonly stage: "model_input" | "model_output";
    readonly security: ExecutionSecuritySummary;
    readonly capacity: ChannelCapacity;
    readonly scanReport: ModelScanReport;
    readonly signal: AbortSignal;
    readonly observer: ModelGatewayObserver;
    readonly interactionUsed?: boolean | undefined;
    readonly toolCallId: string;
  }): Promise<z.infer<typeof authorizationResultSchema>> {
    return authorizationResultSchema.parse(
      await this.dependencies.authorizer.authorize({
        pluginId: input.principal.ownerPluginId,
        feature: input.stage,
        title:
          input.stage === "model_input"
            ? "Review model input safety"
            : "Review model output safety",
        approval: "auto",
        runId: input.executionId,
        payloadClassification: input.security.classification,
        classificationRevision:
          input.security.classificationRevision,
        capacity: input.capacity,
        toolCallId: input.toolCallId,
        scanReport: input.scanReport,
        signal: input.signal,
        ...(input.interactionUsed === undefined
          ? {}
          : { interactionUsed: input.interactionUsed }),
        ...(input.observer.onPolicyWait === undefined
          ? {}
          : { onInteraction: input.observer.onPolicyWait }),
      }),
    );
  }

  #resolveTarget(
    providerId: string | undefined,
    modelId: string | undefined,
  ): { readonly providerId: string; readonly modelId: string } {
    if (providerId) {
      const registration = this.#providers.get(providerId);
      if (!registration) {
        throw new Error(`LLM provider ${providerId} is unavailable`);
      }
      const resolvedModelId = modelId ?? registration.provider.models[0];
      if (
        !resolvedModelId ||
        !registration.provider.models.includes(resolvedModelId)
      ) {
        throw new Error(
          `Model ${modelId ?? "(default)"} is unavailable from ${providerId}`,
        );
      }
      return { providerId, modelId: resolvedModelId };
    }
    if (modelId) {
      const registration = [...this.#providers.values()].find(
        ({ provider }) => provider.models.includes(modelId),
      );
      if (!registration) {
        throw new Error(`Model ${modelId} is unavailable`);
      }
      return {
        providerId: registration.provider.id,
        modelId,
      };
    }
    const fallback = this.resolvePreferences(
      this.#fallbackPreferences,
    );
    if (fallback) {
      return fallback;
    }
    const registration = this.#providers.values().next().value;
    const fallbackModelId = registration?.provider.models[0];
    if (!registration || !fallbackModelId) {
      throw new Error("No LLM provider is available");
    }
    return {
      providerId: registration.provider.id,
      modelId: fallbackModelId,
    };
  }

  #recordUsage(input: {
    readonly executionId: ExecutionId;
    readonly operationKey: ModelOperationKey;
    readonly providerId: string;
    readonly modelId: string;
    readonly usage: ModelUsage;
    readonly runId?: string;
  }): void {
    this.dependencies.costs.record({
      providerId: input.providerId,
      modelId: input.modelId,
      ...input.usage,
      correlationId: input.runId ?? input.executionId,
      ...(input.runId === undefined ? {} : { runId: input.runId }),
      executionId: input.executionId,
      operationKey: input.operationKey,
    });
  }

  #releaseBlockReason(
    registration: RegisteredProvider,
    signal: AbortSignal,
  ): "cancelled" | "unavailable" | undefined {
    if (signal.aborted) {
      return "cancelled";
    }
    return this.#providers.get(registration.provider.id) === registration
      ? undefined
      : "unavailable";
  }

  async #failReleasedOutput(
    call: PreparedModelCall,
    usage: ModelUsage,
    reason: "cancelled" | "unavailable",
  ): Promise<void> {
    await this.dependencies.journal.save({
      ...call,
      phase: "failed",
      errorCode:
        reason === "cancelled"
          ? "aborted"
          : "provider_unavailable",
      failedAt: new Date().toISOString(),
      usage,
    });
  }
}

function matches(candidate: string, pattern: string): boolean {
  if (pattern === "*") {
    return true;
  }
  if (pattern.endsWith("*")) {
    return candidate.startsWith(pattern.slice(0, -1));
  }
  return candidate === pattern;
}

function ensureExecutionOpen(
  execution: ExecutionSecuritySummary,
): void {
  if (execution.lifecycle.state !== "open") {
    throw new Error(`Execution ${execution.id} is closed`);
  }
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableJsonValue(value));
}

function modelInputScanText(input: {
  readonly modelId: string;
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ModelToolDefinition[];
}): string {
  const fields = [scanField("model.id", input.modelId)];
  input.messages.forEach((message, messageIndex) => {
    const prefix = `message.${messageIndex}`;
    fields.push(scanField(`${prefix}.role`, message.role));
    fields.push(scanField(`${prefix}.content`, message.content));
    if (message.toolCallId) {
      fields.push(
        scanField(`${prefix}.toolCallId`, message.toolCallId),
      );
    }
    message.toolCalls?.forEach((toolCall, toolCallIndex) => {
      const callPrefix = `${prefix}.toolCall.${toolCallIndex}`;
      fields.push(scanField(`${callPrefix}.id`, toolCall.id));
      fields.push(scanField(`${callPrefix}.name`, toolCall.name));
      fields.push(
        scanField(
          `${callPrefix}.input`,
          stableJson(toolCall.input),
        ),
      );
    });
  });
  input.tools.forEach((tool, toolIndex) => {
    const prefix = `tool.${toolIndex}`;
    fields.push(scanField(`${prefix}.id`, tool.id));
    fields.push(scanField(`${prefix}.description`, tool.description));
    fields.push(
      scanField(`${prefix}.inputSchema`, stableJson(tool.inputSchema)),
    );
  });
  return fields.join("\n");
}

function modelOutputScanText(result: ModelCompletionResult): string {
  const fields: string[] = [];
  if (result.content !== undefined) {
    fields.push(scanField("output.content", result.content));
  }
  result.toolCalls?.forEach((toolCall, toolCallIndex) => {
    const prefix = `output.toolCall.${toolCallIndex}`;
    fields.push(scanField(`${prefix}.id`, toolCall.id));
    fields.push(scanField(`${prefix}.name`, toolCall.name));
    fields.push(
      scanField(`${prefix}.input`, stableJson(toolCall.input)),
    );
  });
  return fields.join("\n");
}

function scanField(label: string, value: string): string {
  return `${label}:${Buffer.byteLength(value)}\n${value}`;
}

function stableJsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(stableJsonValue);
  }
  if (typeof value === "object") {
    const result: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort()) {
      const entry = Reflect.get(value, key);
      if (entry !== undefined) {
        result[key] = stableJsonValue(entry);
      }
    }
    return result;
  }
  throw new Error("Model input contains a non-JSON value");
}
