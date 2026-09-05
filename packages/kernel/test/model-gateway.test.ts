import type { DataClassification } from "@borg/contracts";
import type {
  ConfigStoreProvider,
  JsonValue,
  StoreEntry,
  StoreTransactionOperation,
} from "@borg/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { CostLedger } from "../src/cost-ledger";
import { executionIdSchema } from "../src/execution-security";
import {
  DurableModelCallJournal,
  IndeterminateModelCallError,
  ModelGateway,
  type ModelGatewayExecutionPort,
  ModelOperationConflictError,
  ModelOutputDeniedError,
  ModelProviderFailedError,
  modelOperationKeySchema,
  providerEgressSchema,
  type ProviderDispatchPermit,
  type ProviderEgress,
} from "../src/model-gateway";
import { PersistenceRegistry, StoreFacade } from "../src/persistence";

type ModelScanStage = "model_input" | "model_output";

interface ModelToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: JsonValue;
}

interface ModelMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  readonly toolCallId?: string;
  readonly toolCalls?: readonly ModelToolCall[];
}

interface ModelToolDefinition {
  readonly id: string;
  readonly description: string;
  readonly inputSchema: JsonValue;
}

interface ModelUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly amount?: number;
  readonly currency?: string;
}

interface ProviderCompletionRequest {
  readonly modelId: string;
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ModelToolDefinition[];
}

interface ProviderCompletionResult {
  readonly content?: string;
  readonly toolCalls?: readonly ModelToolCall[];
  readonly usage: ModelUsage;
}

type ProviderComplete = (
  request: ProviderCompletionRequest,
  permit: ProviderDispatchPermit,
  signal: AbortSignal,
  onRawToken?: (token: string) => void | Promise<void>,
  onUsage?: (usage: ModelUsage) => void | Promise<void>,
) => Promise<ProviderCompletionResult>;

interface ScanRequest {
  readonly stage: ModelScanStage;
  readonly text: string;
  readonly source: {
    readonly kind: "user" | "channel" | "tool" | "model";
    readonly id: string;
  };
  readonly executionId?: string;
  readonly runId?: string;
  readonly sessionId?: string;
  readonly signal?: AbortSignal;
}

interface ScanReport {
  readonly stage: ModelScanStage;
  readonly findings: readonly {
    readonly scannerId: string;
    readonly code: string;
    readonly action: "allow" | "review" | "block";
    readonly reason: string;
  }[];
  readonly failures: readonly {
    readonly scannerId: string;
    readonly kind: "timeout" | "error" | "invalid";
    readonly message: string;
  }[];
  readonly coverage: "complete" | "partial" | "none";
  readonly truncated: boolean;
  readonly unavailableAction: "review";
}

interface AuthorizationRequest {
  readonly pluginId: string;
  readonly feature: ModelScanStage;
  readonly title: string;
  readonly approval: "auto";
  readonly runId: string;
  readonly payloadClassification: DataClassification;
  readonly classificationRevision: number;
  readonly capacity?: ProviderEgress["capacity"];
  readonly toolCallId: string;
  readonly scanReport: ScanReport;
  readonly signal: AbortSignal;
  onInteraction?(interactionId: string): void;
}

interface AuthorizationResult {
  readonly allowed: boolean;
  readonly interactionUsed: boolean;
  readonly reasons: readonly string[];
}

interface SecurityState {
  classification: DataClassification;
  classificationRevision: number;
}

interface HarnessOptions {
  readonly backend?: MemoryConfigStore;
  readonly security?: SecurityState;
  readonly costs?: CostLedger;
  readonly scan?: (request: ScanRequest) => Promise<ScanReport>;
  readonly authorize?: (
    request: AuthorizationRequest,
  ) => Promise<AuthorizationResult>;
}

const EXECUTION_ID = executionIdSchema.parse(
  "10000000-0000-4000-8000-000000000001",
);
const OPERATION_KEY = modelOperationKeySchema.parse(
  "graph/node-a/attempt/1/prompt",
);
const SECOND_OPERATION_KEY = modelOperationKeySchema.parse(
  "graph/node-a/attempt/2/prompt",
);
const PROVIDER_ID = "borg.test-provider";
const MODEL_ID = "test:model";
const PRINCIPAL = {
  ownerPluginId: "borg.graphs",
  feature: "graph_prompt",
} as const;
const REMOTE_EGRESS = {
  kind: "remote",
  capacity: "internal",
  destination: "https://provider.example/v1/generate",
} satisfies ProviderEgress;
const USAGE = {
  inputTokens: 8,
  outputTokens: 3,
  cachedInputTokens: 2,
  amount: 0.02,
  currency: "USD",
} satisfies ModelUsage;

class MemoryConfigStore implements ConfigStoreProvider {
  readonly configs = new Map<string, JsonValue>();
  readonly values = new Map<string, Map<string, JsonValue>>();

  async readConfig(namespace: string): Promise<unknown | undefined> {
    return this.configs.get(namespace);
  }

  async writeConfig(namespace: string, value: JsonValue): Promise<void> {
    this.configs.set(namespace, value);
  }

  async getStore(
    namespace: string,
    key: string,
  ): Promise<JsonValue | undefined> {
    return this.values.get(namespace)?.get(key);
  }

  async listStore(
    namespace: string,
    prefix: string,
  ): Promise<readonly StoreEntry[]> {
    return [...(this.values.get(namespace) ?? new Map()).entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({ key, value }));
  }

  async applyStoreTransaction(
    namespace: string,
    operations: readonly StoreTransactionOperation[],
  ): Promise<void> {
    const next = new Map(this.values.get(namespace));
    for (const operation of operations) {
      if (operation.type === "set") {
        next.set(operation.key, operation.value);
      } else {
        next.delete(operation.key);
      }
    }
    this.values.set(namespace, next);
  }
}

function deferred<T>() {
  let resolveValue: (value: T) => void = () => {
    throw new Error("Deferred promise was not initialized");
  };
  const promise = new Promise<T>((resolve) => {
    resolveValue = resolve;
  });
  return { promise, resolve: resolveValue };
}

function latch() {
  let releaseLatch: () => void = () => {
    throw new Error("Latch was not initialized");
  };
  const promise = new Promise<void>((resolve) => {
    releaseLatch = resolve;
  });
  return { promise, release: releaseLatch };
}

function scanReport(
  stage: ModelScanStage,
  action: "allow" | "review" | "block" = "allow",
): ScanReport {
  return {
    stage,
    findings:
      action === "allow"
        ? []
        : [
            {
              scannerId: "borg.security.model",
              code: `model.${action}`,
              action,
              reason: `Model ${stage} requires ${action}`,
            },
          ],
    failures: [],
    coverage: "complete",
    truncated: false,
    unavailableAction: "review",
  };
}

function authorization(allowed: boolean): AuthorizationResult {
  return {
    allowed,
    interactionUsed: false,
    reasons: allowed ? [] : ["Model policy denied the request."],
  };
}

function modelRequest(
  overrides: {
    readonly operationKey?: typeof OPERATION_KEY;
    readonly messages?: readonly ModelMessage[];
    readonly tools?: readonly ModelToolDefinition[];
  } = {},
) {
  return {
    executionId: EXECUTION_ID,
    operationKey: overrides.operationKey ?? OPERATION_KEY,
    providerId: PROVIDER_ID,
    modelId: MODEL_ID,
    messages:
      overrides.messages ??
      ([
        {
          role: "user",
          content: "hello",
        },
      ] satisfies readonly ModelMessage[]),
    tools: overrides.tools ?? [],
  };
}

function providerResult(content = "approved answer"): ProviderCompletionResult {
  return {
    content,
    usage: USAGE,
  };
}

function successfulProvider(content?: string): ProviderComplete {
  return async (_request, permit) => {
    await permit.commit();
    return providerResult(content);
  };
}

function registerProvider(
  gateway: ModelGateway,
  complete: ProviderComplete,
  egress: ProviderEgress = REMOTE_EGRESS,
) {
  return gateway.registerProvider(PROVIDER_ID, {
    id: PROVIDER_ID,
    models: [MODEL_ID],
    egress,
    complete,
  });
}

function createHarness(options: HarnessOptions = {}) {
  const backend = options.backend ?? new MemoryConfigStore();
  const registry = new PersistenceRegistry();
  registry.registerConfigStore("borg.test-config", backend);
  const store = new StoreFacade(registry);
  const journal = new DurableModelCallJournal(store);
  const security = options.security ?? {
    classification: "internal",
    classificationRevision: 1,
  };
  const summary = () => ({
    id: EXECUTION_ID,
    rootExecutionId: EXECUTION_ID,
    ownerPluginId: PRINCIPAL.ownerPluginId,
    subject: {
      kind: "graph-instance",
      id: "graph-instance-1",
    },
    classification: security.classification,
    classificationRevision: security.classificationRevision,
    lifecycle: { state: "open" as const },
  });
  const snapshot = vi.fn(
    async (ownerPluginId: string, _executionId: string) => {
      if (ownerPluginId !== PRINCIPAL.ownerPluginId) {
        throw new Error(
          `Execution ${EXECUTION_ID} does not belong to ${ownerPluginId}`,
        );
      }
      return summary();
    },
  );
  const observe = vi.fn(
    async (
      _ownerPluginId: string,
      _executionId: string,
      _input: unknown,
    ) => summary(),
  );
  const commitIfCurrent: ModelGatewayExecutionPort["commitIfCurrent"] =
    async (_ownerPluginId, _executionId, expectedRevision, operation) => {
      const current = summary();
      if (current.classificationRevision !== expectedRevision) {
        return { committed: false };
      }
      return {
        committed: true,
        value: await operation(current),
      };
    };
  const scan = vi.fn(
    options.scan ??
      (async (request: ScanRequest) => scanReport(request.stage)),
  );
  const authorize = vi.fn(
    options.authorize ??
      (async (_request: AuthorizationRequest) => authorization(true)),
  );
  const costs = options.costs ?? new CostLedger();
  const gateway = new ModelGateway({
    journal,
    executions: { summary: snapshot, observe, commitIfCurrent },
    scanners: { scan },
    authorizer: { authorize },
    costs,
  });

  return {
    authorize,
    backend,
    costs,
    gateway,
    journal,
    observe,
    scan,
    security,
    snapshot,
  };
}

function durableSnapshot(backend: MemoryConfigStore): string {
  return JSON.stringify(
    [...backend.values.entries()].flatMap(([namespace, values]) =>
      [...values.entries()].map(([key, value]) => ({
        namespace,
        key,
        value,
      })),
    ),
  );
}

async function rejectionOf<T>(promise: Promise<T>): Promise<unknown> {
  return await promise.then<unknown, unknown>(
    (_value) => {
      throw new Error("Expected promise to reject");
    },
    (error: unknown) => error,
  );
}

function ownErrorSnapshot(error: Error): string {
  return (
    JSON.stringify(
      Object.fromEntries(
        Object.getOwnPropertyNames(error).map((name) => [
          name,
          Reflect.get(error, name),
        ]),
      ),
    ) ?? ""
  );
}

async function waitForAbort(signal: AbortSignal): Promise<never> {
  if (signal.aborted) {
    throw new Error("Provider aborted");
  }
  return await new Promise<never>((_resolve, reject) => {
    signal.addEventListener(
      "abort",
      () => reject(new Error("Provider aborted")),
      { once: true },
    );
  });
}

describe("ModelGateway provider boundary", () => {
  it("requires coherent explicit egress metadata for provider registration", () => {
    expect(providerEgressSchema.safeParse(undefined).success).toBe(false);
    expect(
      providerEgressSchema.safeParse({
        kind: "local",
        capacity: "internal",
      }).success,
    ).toBe(false);
    expect(
      providerEgressSchema.safeParse({
        kind: "remote",
        capacity: "local-only",
        destination: "https://provider.example",
      }).success,
    ).toBe(false);
    expect(
      providerEgressSchema.safeParse({
        kind: "remote",
        capacity: "internal",
        destination: "http://provider.example",
      }).success,
    ).toBe(false);

    const { gateway } = createHarness();
    expect(() =>
      Reflect.apply(gateway.registerProvider, gateway, [
        PROVIDER_ID,
        {
          id: PROVIDER_ID,
          models: [MODEL_ID],
          complete: successfulProvider(),
        },
      ]),
    ).toThrow(/egress|invalid/i);
    expect(() =>
      registerProvider(gateway, successfulProvider()),
    ).not.toThrow();
  });

  it("denies provider capacity before provider code runs", async () => {
    const security: SecurityState = {
      classification: "restricted",
      classificationRevision: 4,
    };
    const harness = createHarness({
      security,
      authorize: async (request) =>
        authorization(
          !(
            request.feature === "model_input" &&
            request.payloadClassification === "restricted" &&
            request.capacity === "internal"
          ),
        ),
    });
    const complete = vi.fn(successfulProvider());
    registerProvider(harness.gateway, complete);

    await expect(
      harness.gateway.complete(
        PRINCIPAL,
        modelRequest(),
        new AbortController().signal,
      ),
    ).rejects.toThrow(/authoriz|capacity|denied/i);

    expect(complete).not.toHaveBeenCalled();
    expect(harness.authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        feature: "model_input",
        payloadClassification: "restricted",
        classificationRevision: 4,
        capacity: "internal",
      }),
    );
    await expect(
      harness.journal.load(EXECUTION_ID, OPERATION_KEY),
    ).resolves.toMatchObject({
      phase: "denied",
      stage: "model_input",
    });
  });

  it("checks execution ownership before journal access", async () => {
    const backend = new MemoryConfigStore();
    const first = createHarness({ backend });
    registerProvider(
      first.gateway,
      successfulProvider("owner-only result"),
    );
    await first.gateway.complete(
      PRINCIPAL,
      modelRequest(),
      new AbortController().signal,
    );
    const restarted = createHarness({ backend });
    registerProvider(
      restarted.gateway,
      successfulProvider("must not run"),
    );
    const wrongPrincipal = {
      ownerPluginId: "borg.other",
      feature: "graph_prompt",
    };

    await expect(
      restarted.gateway.complete(
        wrongPrincipal,
        modelRequest(),
        new AbortController().signal,
      ),
    ).rejects.toThrow(/does not belong/i);
    await expect(
      restarted.gateway.complete(
        wrongPrincipal,
        modelRequest({ operationKey: SECOND_OPERATION_KEY }),
        new AbortController().signal,
      ),
    ).rejects.toThrow(/does not belong/i);
    await expect(
      restarted.journal.load(EXECUTION_ID, SECOND_OPERATION_KEY),
    ).resolves.toBeUndefined();
  });

  it("scans the canonical full provider input", async () => {
    const messages = [
      {
        role: "system",
        content: "guardrails",
      },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "call-1",
            name: "tools.lookup",
            input: { zeta: 2, alpha: "first" },
          },
        ],
      },
      {
        role: "tool",
        content: "{\"ok\":true}",
        toolCallId: "call-1",
      },
      {
        role: "user",
        content: "answer",
      },
    ] satisfies readonly ModelMessage[];
    const tools = [
      {
        id: "tools.lookup",
        description: "Look up a value",
        inputSchema: {
          required: ["query"],
          type: "object",
          properties: {
            query: { type: "string" },
            limit: { type: "integer", minimum: 1 },
          },
          additionalProperties: false,
        },
      },
    ] satisfies readonly ModelToolDefinition[];
    const providerRequests: ProviderCompletionRequest[] = [];
    const harness = createHarness();
    const complete = vi.fn(
      async (
        request: ProviderCompletionRequest,
        permit: ProviderDispatchPermit,
      ): Promise<ProviderCompletionResult> => {
        providerRequests.push(request);
        await permit.commit();
        return providerResult();
      },
    );
    registerProvider(harness.gateway, complete);

    await harness.gateway.complete(
      PRINCIPAL,
      modelRequest({ messages, tools }),
      new AbortController().signal,
    );

    const inputScan = harness.scan.mock.calls
      .map(([request]) => request)
      .find(({ stage }) => stage === "model_input");
    expect(inputScan?.text).toContain("model.id:10\ntest:model");
    expect(inputScan?.text).toContain(
      "message.0.content:10\nguardrails",
    );
    expect(inputScan?.text).toContain(
      'message.1.toolCall.0.input:26\n{"alpha":"first","zeta":2}',
    );
    expect(inputScan?.text).toContain(
      "message.2.content:11\n{\"ok\":true}",
    );
    expect(inputScan?.text).toContain(
      "tool.0.description:15\nLook up a value",
    );
    expect(providerRequests).toEqual([
      {
        modelId: MODEL_ID,
        messages,
        tools,
      },
    ]);
  });

  it("consumes a one-shot dispatch permit immediately before generation", async () => {
    const harness = createHarness();
    const events: string[] = [];
    let capturedPermit: ProviderDispatchPermit | undefined;
    const complete = vi.fn(
      async (
        _request: ProviderCompletionRequest,
        permit: ProviderDispatchPermit,
      ): Promise<ProviderCompletionResult> => {
        capturedPermit = permit;
        events.push("provider-prepared");
        await expect(
          harness.journal.load(EXECUTION_ID, OPERATION_KEY),
        ).resolves.toMatchObject({ phase: "prepared" });
        await permit.commit();
        events.push("dispatch-committed");
        events.push("provider-generated");
        return providerResult();
      },
    );
    registerProvider(harness.gateway, complete);

    await harness.gateway.complete(
      PRINCIPAL,
      modelRequest(),
      new AbortController().signal,
    );

    expect(events).toEqual([
      "provider-prepared",
      "dispatch-committed",
      "provider-generated",
    ]);
    if (!capturedPermit) {
      throw new Error("Provider did not receive a dispatch permit");
    }
    await expect(capturedPermit.commit()).rejects.toThrow(
      /already|consumed|one-shot/i,
    );
  });

  it("rechecks classification when the provider commits its dispatch", async () => {
    const security: SecurityState = {
      classification: "internal",
      classificationRevision: 1,
    };
    const harness = createHarness({
      security,
      authorize: async (request) =>
        authorization(
          !(
            request.feature === "model_input" &&
            request.payloadClassification === "restricted" &&
            request.capacity === "internal"
          ),
        ),
    });
    const generated = vi.fn();
    const complete = vi.fn(
      async (
        _request: ProviderCompletionRequest,
        permit: ProviderDispatchPermit,
      ): Promise<ProviderCompletionResult> => {
        security.classification = "restricted";
        security.classificationRevision = 2;
        await permit.commit();
        generated();
        return providerResult();
      },
    );
    registerProvider(harness.gateway, complete);

    await expect(
      harness.gateway.complete(
        PRINCIPAL,
        modelRequest(),
        new AbortController().signal,
      ),
    ).rejects.toThrow(/authoriz|capacity|classification|denied/i);

    expect(generated).not.toHaveBeenCalled();
    expect(harness.snapshot.mock.calls.length).toBeGreaterThanOrEqual(2);
    const record = await harness.journal.load(EXECUTION_ID, OPERATION_KEY);
    expect(record?.phase).not.toBe("dispatched");
    expect(record?.phase).not.toBe("released");
  });

  it("does not let a new provider registration satisfy an old prepared call", async () => {
    const harness = createHarness();
    const providerEntered = latch();
    const continueDispatch = latch();
    const firstGenerated = vi.fn();
    const firstComplete = vi.fn(
      async (
        _request: ProviderCompletionRequest,
        permit: ProviderDispatchPermit,
      ): Promise<ProviderCompletionResult> => {
        providerEntered.release();
        await continueDispatch.promise;
        await permit.commit();
        firstGenerated();
        return providerResult("old registration");
      },
    );
    const firstRegistration = registerProvider(
      harness.gateway,
      firstComplete,
    );
    const firstCall = harness.gateway.complete(
      PRINCIPAL,
      modelRequest(),
      new AbortController().signal,
    );
    await providerEntered.promise;

    const firstRecord = await harness.journal.load(
      EXECUTION_ID,
      OPERATION_KEY,
    );
    if (!firstRecord) {
      throw new Error("Prepared call was not journaled");
    }
    const firstRegistrationId = firstRecord.providerRegistrationId;

    await firstRegistration.dispose();
    const secondComplete = vi.fn(successfulProvider("new registration"));
    registerProvider(harness.gateway, secondComplete);
    continueDispatch.release();

    await expect(firstCall).rejects.toThrow(
      /provider|registration|revoked|available/i,
    );
    expect(firstGenerated).not.toHaveBeenCalled();
    expect(secondComplete).not.toHaveBeenCalled();

    await harness.gateway.complete(
      PRINCIPAL,
      modelRequest({ operationKey: SECOND_OPERATION_KEY }),
      new AbortController().signal,
    );
    const secondRecord = await harness.journal.load(
      EXECUTION_ID,
      SECOND_OPERATION_KEY,
    );
    expect(secondRecord?.providerRegistrationId).not.toBe(
      firstRegistrationId,
    );
    expect(secondComplete).toHaveBeenCalledTimes(1);
  });
});

describe("ModelGateway output release", () => {
  it("quarantines raw tokens until output approval is durable", async () => {
    const policyStarted = latch();
    const decision = deferred<AuthorizationResult>();
    const harness = createHarness({
      scan: async (request) =>
        scanReport(
          request.stage,
          request.stage === "model_output" ? "review" : "allow",
        ),
      authorize: async (request) => {
        if (request.feature !== "model_output") {
          return authorization(true);
        }
        request.onInteraction?.("interaction-output");
        policyStarted.release();
        return await decision.promise;
      },
    });
    const complete = vi.fn(
      async (
        _request: ProviderCompletionRequest,
        permit: ProviderDispatchPermit,
        _signal: AbortSignal,
        onRawToken?: (token: string) => void | Promise<void>,
      ): Promise<ProviderCompletionResult> => {
        await permit.commit();
        await onRawToken?.("approved ");
        await onRawToken?.("answer");
        return providerResult();
      },
    );
    registerProvider(harness.gateway, complete);
    const approvedTokens: string[] = [];
    const releasePhases: (string | undefined)[] = [];
    const policyWaits: string[] = [];

    const pending = harness.gateway.complete(
      PRINCIPAL,
      modelRequest(),
      new AbortController().signal,
      {
        onPolicyWait: (interactionId: string) => {
          policyWaits.push(interactionId);
        },
        onApprovedToken: async (token: string) => {
          const record = await harness.journal.load(
            EXECUTION_ID,
            OPERATION_KEY,
          );
          releasePhases.push(record?.phase);
          approvedTokens.push(token);
        },
      },
    );

    await policyStarted.promise;
    expect(policyWaits).toEqual(["interaction-output"]);
    expect(approvedTokens).toEqual([]);
    await expect(
      harness.journal.load(EXECUTION_ID, OPERATION_KEY),
    ).resolves.toMatchObject({ phase: "output-pending" });
    expect(durableSnapshot(harness.backend)).not.toContain(
      "approved answer",
    );

    decision.resolve(authorization(true));
    await expect(pending).resolves.toMatchObject({
      providerId: PROVIDER_ID,
      modelId: MODEL_ID,
      content: "approved answer",
      replayed: false,
    });
    expect(approvedTokens).toEqual(["approved ", "answer"]);
    expect(releasePhases).toEqual(["released", "released"]);
  });

  it("denies output without exposing raw content anywhere", async () => {
    const raw = "RAW-MODEL-CONTENT-MUST-NOT-ESCAPE";
    const harness = createHarness({
      authorize: async (request) =>
        authorization(request.feature !== "model_output"),
    });
    const complete = vi.fn(
      async (
        _request: ProviderCompletionRequest,
        permit: ProviderDispatchPermit,
        _signal: AbortSignal,
        onRawToken?: (token: string) => void | Promise<void>,
      ): Promise<ProviderCompletionResult> => {
        await permit.commit();
        await onRawToken?.(raw);
        return providerResult(raw);
      },
    );
    registerProvider(harness.gateway, complete);
    const approvedTokens: string[] = [];

    const error = await rejectionOf(
      harness.gateway.complete(
        PRINCIPAL,
        modelRequest(),
        new AbortController().signal,
        {
          onApprovedToken: (token: string) => {
            approvedTokens.push(token);
          },
        },
      ),
    );

    expect(error).toBeInstanceOf(ModelOutputDeniedError);
    if (!(error instanceof Error)) {
      throw new Error("Expected a sanitized model output denial");
    }
    expect(String(error)).not.toContain(raw);
    expect(ownErrorSnapshot(error)).not.toContain(raw);
    expect(approvedTokens).toEqual([]);
    const record = await harness.journal.load(EXECUTION_ID, OPERATION_KEY);
    expect(record).toMatchObject({
      phase: "denied",
      stage: "model_output",
    });
    expect(JSON.stringify(record)).not.toContain(raw);
    expect(durableSnapshot(harness.backend)).not.toContain(raw);
  });

  it("sanitizes provider failures after raw output starts", async () => {
    const raw = "QUARANTINED_PROVIDER_SECRET";
    const harness = createHarness();
    registerProvider(
      harness.gateway,
      async (_request, permit, _signal, onRawToken) => {
        await permit.commit();
        await onRawToken?.(raw);
        throw new Error(`provider failed after ${raw}`);
      },
    );

    const error = await rejectionOf(
      harness.gateway.complete(
        PRINCIPAL,
        modelRequest(),
        new AbortController().signal,
      ),
    );
    expect(error).toBeInstanceOf(ModelProviderFailedError);
    expect(String(error)).not.toContain(raw);
    expect(ownErrorSnapshot(error as Error)).not.toContain(raw);
    expect(durableSnapshot(harness.backend)).not.toContain(raw);
  });

  it("blocks release when the call is cancelled during output review", async () => {
    const policyStarted = latch();
    const decision = deferred<AuthorizationResult>();
    const harness = createHarness({
      authorize: async (request) => {
        if (request.feature !== "model_output") {
          return authorization(true);
        }
        policyStarted.release();
        return await decision.promise;
      },
    });
    registerProvider(
      harness.gateway,
      successfulProvider("held output"),
    );
    const controller = new AbortController();
    const tokens: string[] = [];
    const pending = harness.gateway.complete(
      PRINCIPAL,
      modelRequest(),
      controller.signal,
      {
        onApprovedToken: (token) => {
          tokens.push(token);
        },
      },
    );
    await policyStarted.promise;
    controller.abort(new Error("cancelled"));
    decision.resolve(authorization(true));

    await expect(pending).rejects.toMatchObject({
      name: "ModelProviderFailedError",
      reason: "cancelled",
    });
    expect(tokens).toEqual([]);
    await expect(
      harness.journal.load(EXECUTION_ID, OPERATION_KEY),
    ).resolves.toMatchObject({
      phase: "failed",
      errorCode: "aborted",
    });
  });

  it("blocks release when the provider is revoked during output review", async () => {
    const policyStarted = latch();
    const decision = deferred<AuthorizationResult>();
    const harness = createHarness({
      authorize: async (request) => {
        if (request.feature !== "model_output") {
          return authorization(true);
        }
        policyStarted.release();
        return await decision.promise;
      },
    });
    const registration = registerProvider(
      harness.gateway,
      successfulProvider("held output"),
    );
    const tokens: string[] = [];
    const pending = harness.gateway.complete(
      PRINCIPAL,
      modelRequest(),
      new AbortController().signal,
      {
        onApprovedToken: (token) => {
          tokens.push(token);
        },
      },
    );
    await policyStarted.promise;
    await registration.dispose();
    decision.resolve(authorization(true));

    await expect(pending).rejects.toMatchObject({
      name: "ModelProviderFailedError",
      reason: "unavailable",
    });
    expect(tokens).toEqual([]);
    await expect(
      harness.journal.load(EXECUTION_ID, OPERATION_KEY),
    ).resolves.toMatchObject({
      phase: "failed",
      errorCode: "provider_unavailable",
    });
  });

  it("reauthorizes output when classification changes before release", async () => {
    const security: SecurityState = {
      classification: "internal",
      classificationRevision: 1,
    };
    let outputAuthorizations = 0;
    const harness = createHarness({
      security,
      authorize: async (request) => {
        if (request.feature !== "model_output") {
          return authorization(true);
        }
        outputAuthorizations += 1;
        if (outputAuthorizations === 1) {
          security.classification = "restricted";
          security.classificationRevision = 2;
          return authorization(true);
        }
        return authorization(false);
      },
    });
    registerProvider(
      harness.gateway,
      successfulProvider("held output"),
    );
    const tokens: string[] = [];

    await expect(
      harness.gateway.complete(
        PRINCIPAL,
        modelRequest(),
        new AbortController().signal,
        {
          onApprovedToken: (token) => {
            tokens.push(token);
          },
        },
      ),
    ).rejects.toBeInstanceOf(ModelOutputDeniedError);
    expect(outputAuthorizations).toBe(2);
    expect(tokens).toEqual([]);
    await expect(
      harness.journal.load(EXECUTION_ID, OPERATION_KEY),
    ).resolves.toMatchObject({
      phase: "denied",
      stage: "model_output",
    });
  });

  it("collects successful usage exactly once", async () => {
    const harness = createHarness();
    const recordUsage = vi.spyOn(harness.costs, "record");
    const complete = vi.fn(
      async (
        _request: ProviderCompletionRequest,
        permit: ProviderDispatchPermit,
        _signal: AbortSignal,
        _onRawToken?: (token: string) => void | Promise<void>,
        onUsage?: (usage: ModelUsage) => void | Promise<void>,
      ): Promise<ProviderCompletionResult> => {
        await permit.commit();
        await onUsage?.({ inputTokens: 3, outputTokens: 0 });
        await onUsage?.({ inputTokens: 6, outputTokens: 2 });
        return providerResult();
      },
    );
    registerProvider(harness.gateway, complete);

    await harness.gateway.complete(
      PRINCIPAL,
      modelRequest(),
      new AbortController().signal,
    );

    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining(USAGE),
    );
  });

  it("rejects oversized non-streamed output before scanning or release", async () => {
    const backend = new MemoryConfigStore();
    const base = createHarness({ backend });
    const gateway = new ModelGateway({
      journal: base.journal,
      executions: {
        summary: base.snapshot,
        observe: base.observe,
        commitIfCurrent: async (
          _ownerPluginId,
          _executionId,
          expectedRevision,
          operation,
        ) => {
          const current = await base.snapshot(
            PRINCIPAL.ownerPluginId,
            EXECUTION_ID,
          );
          if (
            current.classificationRevision !== expectedRevision
          ) {
            return { committed: false };
          }
          return {
            committed: true,
            value: await operation(current),
          };
        },
      },
      scanners: { scan: base.scan },
      authorizer: { authorize: base.authorize },
      costs: base.costs,
      options: { maxHeldOutputBytes: 16 },
    });
    registerProvider(
      gateway,
      successfulProvider("content larger than sixteen bytes"),
    );

    await expect(
      gateway.complete(
        PRINCIPAL,
        modelRequest(),
        new AbortController().signal,
      ),
    ).rejects.toThrow(/hold limit/i);
    expect(
      base.scan.mock.calls.some(
        ([request]) => request.stage === "model_output",
      ),
    ).toBe(false);
    await expect(
      base.journal.load(EXECUTION_ID, OPERATION_KEY),
    ).resolves.toMatchObject({
      phase: "failed",
      errorCode: "output_too_large",
    });
  });
});

describe("ModelGateway durable call recovery", () => {
  it("replays a released result without a second provider call", async () => {
    const backend = new MemoryConfigStore();
    const costs = new CostLedger();
    const recordUsage = vi.spyOn(costs, "record");
    const first = createHarness({ backend, costs });
    const firstComplete = vi.fn(successfulProvider("released result"));
    registerProvider(first.gateway, firstComplete);

    await expect(
      first.gateway.complete(
        PRINCIPAL,
        modelRequest(),
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      content: "released result",
      replayed: false,
    });

    const restarted = createHarness({ backend, costs });
    const secondComplete = vi.fn(successfulProvider("wrong second result"));
    registerProvider(restarted.gateway, secondComplete);
    const replayedTokens: string[] = [];

    await expect(
      restarted.gateway.complete(
        PRINCIPAL,
        modelRequest(),
        new AbortController().signal,
        {
          onApprovedToken: (token: string) => {
            replayedTokens.push(token);
          },
        },
      ),
    ).resolves.toMatchObject({
      providerId: PROVIDER_ID,
      modelId: MODEL_ID,
      content: "released result",
      replayed: true,
    });
    expect(firstComplete).toHaveBeenCalledTimes(1);
    expect(secondComplete).not.toHaveBeenCalled();
    expect(recordUsage).toHaveBeenCalledTimes(1);
    expect(replayedTokens).toEqual(["released result"]);
  });

  it("rejects operation-key reuse when the request digest changes", async () => {
    const harness = createHarness();
    const complete = vi.fn(successfulProvider());
    registerProvider(harness.gateway, complete);
    await harness.gateway.complete(
      PRINCIPAL,
      modelRequest(),
      new AbortController().signal,
    );

    await expect(
      harness.gateway.complete(
        PRINCIPAL,
        modelRequest({
          messages: [{ role: "user", content: "different request" }],
        }),
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(ModelOperationConflictError);
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("rejects a prepared retry that requests a different provider", async () => {
    const harness = createHarness({
      scan: async (request) => {
        if (request.stage === "model_input") {
          throw new Error("scanner unavailable");
        }
        return scanReport(request.stage);
      },
    });
    registerProvider(harness.gateway, successfulProvider(), REMOTE_EGRESS);
    harness.gateway.registerProvider("borg.other-owner", {
      id: "borg.other-provider",
      models: ["other:model"],
      egress: REMOTE_EGRESS,
      complete: successfulProvider("wrong provider"),
    });
    await expect(
      harness.gateway.complete(
        PRINCIPAL,
        modelRequest(),
        new AbortController().signal,
      ),
    ).rejects.toThrow("scanner unavailable");

    await expect(
      harness.gateway.complete(
        PRINCIPAL,
        {
          ...modelRequest(),
          providerId: "borg.other-provider",
          modelId: "other:model",
        },
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(ModelOperationConflictError);
  });

  it("retries a prepared call", async () => {
    let inputAttempts = 0;
    const harness = createHarness({
      scan: async (request) => {
        if (request.stage === "model_input" && inputAttempts === 0) {
          inputAttempts += 1;
          throw new Error("scanner transport failed");
        }
        return scanReport(request.stage);
      },
    });
    const complete = vi.fn(successfulProvider());
    registerProvider(harness.gateway, complete);

    await expect(
      harness.gateway.complete(
        PRINCIPAL,
        modelRequest(),
        new AbortController().signal,
      ),
    ).rejects.toThrow("scanner transport failed");
    await expect(
      harness.journal.load(EXECUTION_ID, OPERATION_KEY),
    ).resolves.toMatchObject({ phase: "prepared" });

    await expect(
      harness.gateway.complete(
        PRINCIPAL,
        modelRequest(),
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ replayed: false });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("rebinds a prepared call to the provider after restart", async () => {
    const backend = new MemoryConfigStore();
    const first = createHarness({
      backend,
      scan: async (request) => {
        if (request.stage === "model_input") {
          throw new Error("scanner unavailable");
        }
        return scanReport(request.stage);
      },
    });
    registerProvider(first.gateway, successfulProvider("unused"));
    await expect(
      first.gateway.complete(
        PRINCIPAL,
        modelRequest(),
        new AbortController().signal,
      ),
    ).rejects.toThrow("scanner unavailable");
    await expect(
      first.journal.load(EXECUTION_ID, OPERATION_KEY),
    ).resolves.toMatchObject({ phase: "prepared" });

    const restarted = createHarness({ backend });
    const complete = vi.fn(successfulProvider("recovered"));
    registerProvider(restarted.gateway, complete);
    await expect(
      restarted.gateway.complete(
        PRINCIPAL,
        modelRequest(),
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      content: "recovered",
      replayed: false,
    });
    expect(complete).toHaveBeenCalledOnce();
  });

  it("fails a recovered dispatched call as indeterminate", async () => {
    const backend = new MemoryConfigStore();
    const first = createHarness({ backend });
    const dispatched = latch();
    const controller = new AbortController();
    const firstComplete = vi.fn(
      async (
        _request: ProviderCompletionRequest,
        permit: ProviderDispatchPermit,
        signal: AbortSignal,
      ): Promise<ProviderCompletionResult> => {
        await permit.commit();
        dispatched.release();
        return await waitForAbort(signal);
      },
    );
    registerProvider(first.gateway, firstComplete);
    const firstCall = first.gateway.complete(
      PRINCIPAL,
      modelRequest(),
      controller.signal,
    );
    await dispatched.promise;
    await expect(
      first.journal.load(EXECUTION_ID, OPERATION_KEY),
    ).resolves.toMatchObject({ phase: "dispatched" });

    const restarted = createHarness({ backend });
    const secondComplete = vi.fn(successfulProvider("must not run"));
    registerProvider(restarted.gateway, secondComplete);
    const error = await rejectionOf(
      restarted.gateway.complete(
        PRINCIPAL,
        modelRequest(),
        new AbortController().signal,
      ),
    );

    expect(error).toBeInstanceOf(IndeterminateModelCallError);
    expect(error).toMatchObject({ phase: "dispatched" });
    expect(secondComplete).not.toHaveBeenCalled();

    controller.abort();
    await expect(firstCall).rejects.toThrow("Provider aborted");
  });

  it("fails a recovered output-pending call as indeterminate", async () => {
    const backend = new MemoryConfigStore();
    const outputScanStarted = latch();
    const continueOutputScan = latch();
    const first = createHarness({
      backend,
      scan: async (request) => {
        if (request.stage === "model_output") {
          outputScanStarted.release();
          await continueOutputScan.promise;
        }
        return scanReport(request.stage);
      },
    });
    const firstComplete = vi.fn(successfulProvider("held output"));
    registerProvider(first.gateway, firstComplete);
    const firstCall = first.gateway.complete(
      PRINCIPAL,
      modelRequest(),
      new AbortController().signal,
    );
    await outputScanStarted.promise;
    await expect(
      first.journal.load(EXECUTION_ID, OPERATION_KEY),
    ).resolves.toMatchObject({ phase: "output-pending" });
    expect(durableSnapshot(backend)).not.toContain("held output");

    const restarted = createHarness({ backend });
    const secondComplete = vi.fn(successfulProvider("must not run"));
    registerProvider(restarted.gateway, secondComplete);
    const error = await rejectionOf(
      restarted.gateway.complete(
        PRINCIPAL,
        modelRequest(),
        new AbortController().signal,
      ),
    );

    expect(error).toBeInstanceOf(IndeterminateModelCallError);
    expect(error).toMatchObject({ phase: "output-pending" });
    expect(secondComplete).not.toHaveBeenCalled();

    continueOutputScan.release();
    await expect(firstCall).resolves.toMatchObject({
      content: "held output",
      replayed: false,
    });
  });
});
