import {
  feedbackAsk,
  graphDefinitionSaved,
  graphDefinitionSchema,
  graphInstanceCompleted,
  graphInstanceFailed,
  graphInstanceStarted,
  graphInstanceUpdated,
  graphStepCompleted,
  type ExecutionId,
  type GraphDefinition,
  type ModelCompletionResult,
} from "@borg/contracts";
import {
  z,
  type JsonValue,
  type LlmProviderContribution,
  type PluginContext,
  type PluginExecutions,
  type PluginModels,
  type ProviderEgress,
} from "@borg/plugin-sdk";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSecurityRuntime } from "../../../packages/kernel/test/security-runtime";
import {
  HiveMindGraphEngine,
  validateGraphDefinition,
} from "../src/executor";
import {
  createGraphHarness as createBaseGraphHarness,
  linearDefinition,
} from "./harness";

const GRAPH_LAUNCH_SECURITY = {
  kind: "root",
  classification: "internal",
  provenance: {
    kind: "plugin",
    id: "graph-executor-test",
  },
} satisfies Parameters<HiveMindGraphEngine["launch"]>[0]["security"];

const MODEL_PROVIDER_ID = "borg.mock-llm";
const MODEL_ID = "mock:scripted";
const GRAPH_PLUGIN_ID = "borg.graphs";
const MODEL_PRINCIPAL = {
  ownerPluginId: GRAPH_PLUGIN_ID,
  feature: "graph_prompt",
};
const LOCAL_MODEL_EGRESS = {
  kind: "local",
  capacity: "local-only",
} satisfies ProviderEgress;

function modelNodeSegment(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const prefix = normalized.slice(0, 48) || "node";
  return `${prefix}-${createHash("sha256")
    .update(value)
    .digest("hex")
    .slice(0, 12)}`;
}

let securityRuntime = createSecurityRuntime();
const executionIdsBySubject = new Map<string, ExecutionId>();

function executionSubjectKey(kind: string, id: string): string {
  return `${kind}\u0000${id}`;
}

const bindExecution = vi.fn(
  async (intent: Parameters<PluginExecutions["bind"]>[0]) => {
    const binding = await securityRuntime.executions.bind(
      GRAPH_PLUGIN_ID,
      intent,
      intent.mode === "resume" ? "detached" : "merge_to_parent",
    );
    if (intent.mode !== "resume") {
      executionIdsBySubject.set(
        executionSubjectKey(intent.subject.kind, intent.subject.id),
        binding.id,
      );
    }
    return binding;
  },
);

const grantExecution = vi.fn(async (executionId: ExecutionId) => {
  await securityRuntime.executions.snapshot(
    GRAPH_PLUGIN_ID,
    executionId,
  );
  return securityRuntime.executions.createParentGrant({
    parentExecutionId: executionId,
    granteePluginId: GRAPH_PLUGIN_ID,
  });
});

const testExecutions: PluginExecutions = {
  bind: bindExecution,
  grant: grantExecution,
};

async function executionFor(kind: string, id: string) {
  const executionId = executionIdsBySubject.get(
    executionSubjectKey(kind, id),
  );
  if (!executionId) {
    throw new Error(`Execution ${kind}/${id} is unavailable`);
  }
  return securityRuntime.executions.summary(
    GRAPH_PLUGIN_ID,
    executionId,
  );
}

function resetSecurityRuntime(): void {
  securityRuntime = createSecurityRuntime();
  executionIdsBySubject.clear();
  bindExecution.mockClear();
  grantExecution.mockClear();
}

const defaultModelComplete: PluginModels["complete"] = async (request) => {
  if (!request.providerId || !request.modelId) {
    throw new Error("Test model requests require an explicit target");
  }
  return {
    providerId: request.providerId,
    modelId: request.modelId,
    content: "model response",
    usage: { inputTokens: 1, outputTokens: 1 },
    replayed: false,
  };
};

function createGraphHarness(
  initialStoredValues?: Parameters<typeof createBaseGraphHarness>[0],
  graphContributions?: Parameters<typeof createBaseGraphHarness>[1],
) {
  const fixture = createBaseGraphHarness(
    initialStoredValues,
    graphContributions,
  );
  const modelsComplete = vi.fn(defaultModelComplete);
  const registerExecutionScope = vi.fn(
    fixture.context.tools.registerExecutionScope,
  );
  const context: PluginContext = {
    ...fixture.context,
    executions: testExecutions,
    tools: {
      ...fixture.context.tools,
      registerExecutionScope,
    },
    models: {
      ...fixture.context.models,
      complete: modelsComplete,
    },
  };
  return {
    ...fixture,
    context,
    modelsComplete,
    registerExecutionScope,
    executionFor,
  };
}

function registerRestartableModelProvider(
  complete: LlmProviderContribution["complete"],
) {
  const providerComplete = vi.fn(complete);
  securityRuntime.models.registerProvider(MODEL_PROVIDER_ID, {
    id: MODEL_PROVIDER_ID,
    models: [MODEL_ID],
    egress: LOCAL_MODEL_EGRESS,
    complete: providerComplete,
  });
  const gatewayComplete: PluginModels["complete"] = async (request) =>
    securityRuntime.models.complete(
      MODEL_PRINCIPAL,
      {
        ...request,
        tools: [],
      },
      new AbortController().signal,
    );
  return { complete: gatewayComplete, providerComplete };
}

function deferred<T>() {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value: T): void => {
      const resolve = resolvePromise;
      if (!resolve) {
        throw new Error("Deferred promise is unavailable");
      }
      resolvePromise = undefined;
      resolve(value);
    },
  };
}

function isJsonObject(
  value: JsonValue | undefined,
): value is Readonly<Record<string, JsonValue>> {
  return (
    value !== undefined &&
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

function isJsonArray(
  value: JsonValue | undefined,
): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function storedObject(
  storedValues: ReadonlyMap<string, JsonValue>,
  key: string,
): Readonly<Record<string, JsonValue>> {
  const value = storedValues.get(key);
  if (!isJsonObject(value)) {
    throw new Error(`Stored value ${key} is unavailable`);
  }
  return value;
}

function storedDefinition(
  storedValues: ReadonlyMap<string, JsonValue>,
  key: string,
): GraphDefinition {
  return graphDefinitionSchema.parse(
    storedObject(storedValues, key).definition,
  );
}

function storedInstance(
  storedValues: ReadonlyMap<string, JsonValue>,
  instanceId: string,
) {
  const value = storedObject(storedValues, `instances/${instanceId}`);
  const instance = value.instance;
  if (
    !isJsonObject(instance) ||
    typeof instance.definitionVersion !== "string"
  ) {
    throw new Error(`Stored instance ${instanceId} is invalid`);
  }
  return {
    instance: {
      definitionVersion: instance.definitionVersion,
      output: instance.output,
    },
    definition: graphDefinitionSchema.parse(value.definition),
  };
}

function replacePersistedPrompt(
  storedValues: Map<string, JsonValue>,
  instanceId: string,
  prompt: string,
): void {
  const key = `instances/${instanceId}`;
  const persisted = storedValues.get(key);
  if (!isJsonObject(persisted)) {
    throw new Error(`Persisted graph ${instanceId} is unavailable`);
  }
  const definition = persisted.definition;
  if (!isJsonObject(definition) || !isJsonArray(definition.nodes)) {
    throw new Error(`Persisted graph ${instanceId} has no definition`);
  }
  let updatedWorkNode = false;
  const nodes = definition.nodes.map((node) => {
    if (!isJsonObject(node) || node.id !== "work") {
      return node;
    }
    if (!isJsonObject(node.config)) {
      throw new Error(`Persisted graph ${instanceId} has invalid work config`);
    }
    updatedWorkNode = true;
    return {
      ...node,
      config: {
        ...node.config,
        prompt,
      },
    };
  });
  if (!updatedWorkNode) {
    throw new Error(`Persisted graph ${instanceId} has no work node`);
  }
  storedValues.set(key, {
    ...persisted,
    definition: {
      ...definition,
      nodes,
    },
  });
}

const engines: HiveMindGraphEngine[] = [];

async function initializedEngine(
  fixture: ReturnType<typeof createGraphHarness>,
): Promise<HiveMindGraphEngine> {
  const engine = new HiveMindGraphEngine(fixture.context);
  engines.push(engine);
  await engine.initialize();
  return engine;
}

afterEach(async () => {
  const disposals = engines.splice(0).map(async (engine) => engine.dispose());
  try {
    await Promise.all(disposals);
  } finally {
    resetSecurityRuntime();
  }
});

describe("HiveMindGraphEngine", () => {
  it("completes a manual fixture and preserves versioned definition snapshots", async () => {
    const fixture = createGraphHarness();
    const engine = await initializedEngine(fixture);
    const definition = linearDefinition({
      id: "manual-fixture",
      output: { result: "$vars.result" },
    });

    await engine.saveDefinition(definition);
    const instanceId = await engine.launch({
      graphId: definition.id,
      input: { request: "run fixture" },
      security: GRAPH_LAUNCH_SECURITY,
    });
    await fixture.flush();

    expect(engine.getInstance(instanceId)).toMatchObject({
      id: instanceId,
      graphId: definition.id,
      definitionVersion: "1.0.0",
      trigger: "manual",
      status: "completed",
      input: { request: "run fixture" },
      variables: { result: "fixture-result" },
      output: { result: "fixture-result" },
    });

    const changed = linearDefinition({
      id: definition.id,
      taskConfig: { name: "result", value: "second-version-result" },
      output: { result: "$vars.result" },
    });
    const secondVersion = await engine.saveDefinition(changed);
    expect(secondVersion.version).toBe("1.0.1");

    const firstPersistedVersion = storedDefinition(
      fixture.storedValues,
      "definitions/versions/manual-fixture/1.0.0",
    );
    const secondPersistedVersion = storedDefinition(
      fixture.storedValues,
      "definitions/versions/manual-fixture/1.0.1",
    );
    const currentDefinition = storedDefinition(
      fixture.storedValues,
      "definitions/current/manual-fixture",
    );
    const persistedInstance = storedInstance(
      fixture.storedValues,
      instanceId,
    );

    expect(firstPersistedVersion.version).toBe("1.0.0");
    expect(firstPersistedVersion.nodes[1]?.config.value).toBe(
      "fixture-result",
    );
    expect(secondPersistedVersion.version).toBe("1.0.1");
    expect(currentDefinition.version).toBe("1.0.1");
    expect(persistedInstance).toMatchObject({
      instance: {
        definitionVersion: "1.0.0",
        output: { result: "fixture-result" },
      },
      definition: {
        id: "manual-fixture",
        version: "1.0.0",
      },
    });
    expect(persistedInstance.definition.nodes[1]?.config.value).toBe(
      "fixture-result",
    );

    const eventIds = fixture.emittedEvents.map(({ id }) => id);
    expect(eventIds).toContain(graphDefinitionSaved.id);
    expect(eventIds).toContain(graphInstanceStarted.id);
    expect(eventIds).toContain(graphInstanceUpdated.id);
    expect(eventIds).toContain(graphInstanceCompleted.id);
    expect(
      fixture.emittedEvents
        .filter(({ id }) => id === graphStepCompleted.id)
        .map(({ payload }) => (payload as { stepId: string }).stepId),
    ).toEqual(["start", "work", "end"]);
    expect(eventIds.indexOf(graphInstanceStarted.id)).toBeLessThan(
      eventIds.indexOf(graphInstanceCompleted.id),
    );
  });

  it("suspends a delay at its persisted deadline and resumes from the scheduler", async () => {
    const fixture = createGraphHarness();
    const engine = await initializedEngine(fixture);
    const definition = linearDefinition({
      id: "delayed-fixture",
      taskKind: "delay",
      taskConfig: { durationMs: 60_000 },
      endConfig: { output: "$steps.work" },
    });
    await engine.saveDefinition(definition);

    const instanceId = await engine.launch({
      graphId: definition.id,
      security: GRAPH_LAUNCH_SECURITY,
    });
    await fixture.flush();

    const waiting = engine.getInstance(instanceId)!;
    const scheduleId = `delay:${instanceId}:work`;
    const scheduled = fixture.scheduledTasks.get(scheduleId);
    expect(waiting.status).toBe("waiting");
    expect(scheduled?.runAt).toMatch(/Z$/);

    await fixture.runScheduled(scheduleId);

    expect(engine.getInstance(instanceId)).toMatchObject({
      status: "completed",
      nodeStates: expect.arrayContaining([
        expect.objectContaining({
          nodeId: "work",
          status: "completed",
        }),
      ]),
    });
  });

  it("waits for borg.feedback.ask with graph source IDs, then completes", async () => {
    const fixture = createGraphHarness();
    const engine = await initializedEngine(fixture);
    type FeedbackResponse = {
      interactionId: string;
      answer: { kind: "text"; text: string };
    };
    let answerFeedback!: (response: FeedbackResponse) => void;
    const response = new Promise<FeedbackResponse>((resolve) => {
      answerFeedback = resolve;
    });
    const feedbackHandler = vi.fn(async () => response);
    fixture.handleCommand(feedbackAsk.id, feedbackHandler);
    const definition = linearDefinition({
      id: "feedback-fixture",
      taskKind: "feedback_gate",
      taskConfig: { prompt: "Approve this graph?", form: "text" },
      endConfig: { output: { accepted: true } },
    });
    await engine.saveDefinition(definition);

    const instanceId = await engine.launch({
      graphId: definition.id,
      security: GRAPH_LAUNCH_SECURITY,
    });
    await vi.waitFor(() => expect(feedbackHandler).toHaveBeenCalledOnce());

    expect(engine.getInstance(instanceId)).toMatchObject({
      status: "waiting",
    });
    expect(feedbackHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "Approve this graph?",
        form: "text",
        source: {
          instanceId,
          stepId: "work",
        },
      }),
      expect.any(AbortSignal),
    );

    answerFeedback({
      interactionId: crypto.randomUUID(),
      answer: { kind: "text", text: "approved" },
    });
    await fixture.flush();

    expect(engine.getInstance(instanceId)).toMatchObject({
      status: "completed",
      output: { accepted: true },
    });
  });

  it("fails a feedback gate when borg.feedback.ask is unavailable", async () => {
    const fixture = createGraphHarness();
    const engine = await initializedEngine(fixture);
    const definition = linearDefinition({
      id: "missing-feedback",
      taskKind: "feedback_gate",
      taskConfig: { prompt: "This needs a handler", form: "confirm" },
    });
    await engine.saveDefinition(definition);

    const instanceId = await engine.launch({
      graphId: definition.id,
      security: GRAPH_LAUNCH_SECURITY,
    });
    await fixture.flush();

    expect(engine.getInstance(instanceId)).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/unavailable/i),
    });
    expect(
      fixture.emittedEvents.some(({ id }) => id === graphInstanceFailed.id),
    ).toBe(true);
  });

  it("invokes call_tool inside the instance execution scope", async () => {
    const fixture = createGraphHarness();
    const engine = await initializedEngine(fixture);
    const toolHandler = vi.fn(async (input: unknown) => ({
      echoed: input as never,
    }));
    fixture.registerToolHandler("fixture.echo", toolHandler);
    const definition = linearDefinition({
      id: "tool-fixture",
      taskKind: "call_tool",
      taskConfig: {
        toolId: "fixture.echo",
        input: { value: "$input.value" },
      },
      endConfig: { output: { invoked: true } },
      permissions: ["fixture.echo"],
    });
    await engine.saveDefinition(definition);

    const instanceId = await engine.launch({
      graphId: definition.id,
      input: { value: 7 },
      security: GRAPH_LAUNCH_SECURITY,
    });
    await fixture.flush();

    const graphExecution = await fixture.executionFor(
      "graph-instance",
      instanceId,
    );
    expect(fixture.registerExecutionScope).toHaveBeenCalledWith({
      runId: instanceId,
      executionId: graphExecution.id,
      sessionId: instanceId,
      allowedTools: ["fixture.echo"],
    });
    expect(fixture.invokeTool).toHaveBeenCalledWith(
      "fixture.echo",
      { value: 7 },
      expect.objectContaining({ runId: instanceId }),
    );
    expect(
      fixture.registerExecutionScope.mock.invocationCallOrder[0],
    ).toBeLessThan(fixture.invokeTool.mock.invocationCallOrder[0]!);
    expect(toolHandler).toHaveBeenCalledWith(
      { value: 7 },
      expect.objectContaining({ runId: instanceId }),
    );
    expect(fixture.toolScopes).toEqual([
      expect.objectContaining({
        runId: instanceId,
        sessionId: instanceId,
        allowedTools: ["fixture.echo"],
        disposed: true,
      }),
    ]);
    expect(engine.getInstance(instanceId)).toMatchObject({
      status: "completed",
      output: { invoked: true },
    });
  });

  it("binds prompt completion to the graph execution operation", async () => {
    const fixture = createGraphHarness();
    const engine = await initializedEngine(fixture);
    const definition = linearDefinition({
      id: "prompt-security",
      taskKind: "invoke_prompt",
      taskConfig: {
        prompt: "Return the fixture response",
        providerId: MODEL_PROVIDER_ID,
        modelId: MODEL_ID,
      },
      endConfig: { output: "$steps.work" },
    });
    await engine.saveDefinition(definition);

    const instanceId = await engine.launch({
      graphId: definition.id,
      security: GRAPH_LAUNCH_SECURITY,
    });
    await fixture.flush();

    const graphExecution = await fixture.executionFor(
      "graph-instance",
      instanceId,
    );
    expect(fixture.modelsComplete).toHaveBeenCalledWith(
      {
        executionId: graphExecution.id,
        operationKey: `graph/${instanceId}/node/${modelNodeSegment("work")}/attempt/1/prompt`,
        providerId: MODEL_PROVIDER_ID,
        modelId: MODEL_ID,
        messages: [
          { role: "user", content: "Return the fixture response" },
        ],
      },
      expect.any(AbortSignal),
    );
    expect(engine.getInstance(instanceId)).toMatchObject({
      status: "completed",
      output: {
        content: "model response",
        providerId: MODEL_PROVIDER_ID,
        modelId: MODEL_ID,
      },
    });
  });

  it("encodes uppercase node IDs in model operation keys", async () => {
    const fixture = createGraphHarness();
    const engine = await initializedEngine(fixture);
    const base = linearDefinition({
      id: "uppercase-prompt-node",
      taskKind: "invoke_prompt",
      taskConfig: {
        prompt: "Return the fixture response",
        providerId: MODEL_PROVIDER_ID,
        modelId: MODEL_ID,
      },
    });
    const definition = {
      ...base,
      nodes: base.nodes.map((node) =>
        node.id === "work" ? { ...node, id: "WorkStep" } : node,
      ),
      edges: base.edges.map((edge) => ({
        ...edge,
        source: edge.source === "work" ? "WorkStep" : edge.source,
        target: edge.target === "work" ? "WorkStep" : edge.target,
      })),
    };
    await engine.saveDefinition(definition);

    const instanceId = await engine.launch({
      graphId: definition.id,
      security: GRAPH_LAUNCH_SECURITY,
    });
    await fixture.flush();

    expect(fixture.modelsComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        operationKey: `graph/${instanceId}/node/${modelNodeSegment("WorkStep")}/attempt/1/prompt`,
      }),
      expect.any(AbortSignal),
    );
  });

  it("replays a released prompt result after graph recovery", async () => {
    const released = deferred<ModelCompletionResult>();
    const dispatched = deferred<void>();
    const durableModel = registerRestartableModelProvider(
      async (_request, permit) => {
        await permit.commit();
        dispatched.resolve();
        return released.promise;
      },
    );
    const fixture = createGraphHarness();
    fixture.modelsComplete.mockImplementation(durableModel.complete);
    const engine = await initializedEngine(fixture);
    const definition = linearDefinition({
      id: "prompt-released-replay",
      taskKind: "invoke_prompt",
      taskConfig: {
        prompt: "Release this result",
        providerId: MODEL_PROVIDER_ID,
        modelId: MODEL_ID,
      },
      endConfig: { output: "$steps.work" },
    });
    await engine.saveDefinition(definition);

    const instanceId = await engine.launch({
      graphId: definition.id,
      security: GRAPH_LAUNCH_SECURITY,
    });
    await dispatched.promise;
    const graphExecution = await fixture.executionFor(
      "graph-instance",
      instanceId,
    );
    const operationKey =
      `graph/${instanceId}/node/${modelNodeSegment("work")}/attempt/1/prompt`;
    expect(fixture.modelsComplete).toHaveBeenCalledWith(
      {
        executionId: graphExecution.id,
        operationKey,
        providerId: MODEL_PROVIDER_ID,
        modelId: MODEL_ID,
        messages: [{ role: "user", content: "Release this result" }],
      },
      expect.any(AbortSignal),
    );

    await engine.dispose();
    released.resolve({
      content: "released result",
      usage: { inputTokens: 2, outputTokens: 2 },
    });
    await fixture.flush();

    const restored = createGraphHarness(fixture.storedValues);
    restored.modelsComplete.mockImplementation(durableModel.complete);
    const restoredEngine = await initializedEngine(restored);
    await restored.flush();

    expect(restored.modelsComplete).toHaveBeenCalledWith(
      {
        executionId: graphExecution.id,
        operationKey,
        providerId: MODEL_PROVIDER_ID,
        modelId: MODEL_ID,
        messages: [{ role: "user", content: "Release this result" }],
      },
      expect.any(AbortSignal),
    );
    expect(durableModel.providerComplete).toHaveBeenCalledOnce();
    const [replayResult] = restored.modelsComplete.mock.results;
    if (!replayResult) {
      throw new Error("Recovered model completion was not invoked");
    }
    await expect(replayResult.value).resolves.toMatchObject({
      content: "released result",
      replayed: true,
    });
    expect(restoredEngine.getInstance(instanceId)).toMatchObject({
      status: "completed",
      output: {
        content: "released result",
        providerId: MODEL_PROVIDER_ID,
        modelId: MODEL_ID,
      },
    });
  });

  it("fails recovered prompts when an operation request digest changes", async () => {
    const released = deferred<ModelCompletionResult>();
    const dispatched = deferred<void>();
    const durableModel = registerRestartableModelProvider(
      async (_request, permit) => {
        await permit.commit();
        dispatched.resolve();
        return released.promise;
      },
    );
    const fixture = createGraphHarness();
    fixture.modelsComplete.mockImplementation(durableModel.complete);
    const engine = await initializedEngine(fixture);
    const definition = linearDefinition({
      id: "prompt-digest-mismatch",
      taskKind: "invoke_prompt",
      taskConfig: {
        prompt: "Original request",
        providerId: MODEL_PROVIDER_ID,
        modelId: MODEL_ID,
      },
      endConfig: { output: "$steps.work" },
    });
    await engine.saveDefinition(definition);

    const instanceId = await engine.launch({
      graphId: definition.id,
      security: GRAPH_LAUNCH_SECURITY,
    });
    await dispatched.promise;
    const graphExecution = await fixture.executionFor(
      "graph-instance",
      instanceId,
    );
    const operationKey =
      `graph/${instanceId}/node/${modelNodeSegment("work")}/attempt/1/prompt`;

    await engine.dispose();
    released.resolve({
      content: "original result",
      usage: { inputTokens: 2, outputTokens: 2 },
    });
    await fixture.flush();
    replacePersistedPrompt(
      fixture.storedValues,
      instanceId,
      "Changed request",
    );

    const restored = createGraphHarness(fixture.storedValues);
    restored.modelsComplete.mockImplementation(durableModel.complete);
    const restoredEngine = await initializedEngine(restored);
    await restored.flush();

    expect(restored.modelsComplete).toHaveBeenCalledWith(
      {
        executionId: graphExecution.id,
        operationKey,
        providerId: MODEL_PROVIDER_ID,
        modelId: MODEL_ID,
        messages: [{ role: "user", content: "Changed request" }],
      },
      expect.any(AbortSignal),
    );
    expect(durableModel.providerComplete).toHaveBeenCalledOnce();
    const [conflict] = restored.modelsComplete.mock.results;
    if (!conflict) {
      throw new Error("Recovered model completion was not invoked");
    }
    await expect(conflict.value).rejects.toThrow(
      /reused with a different request/i,
    );
    expect(restoredEngine.getInstance(instanceId)).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/reused with a different request/i),
    });
  });

  it("intersects child-agent tools with graph permissions", async () => {
    const fixture = createGraphHarness();
    const engine = await initializedEngine(fixture);
    const definition = linearDefinition({
      id: "agent-permissions",
      taskKind: "invoke_agent",
      taskConfig: {
        prompt: "Use only graph-approved tools",
        allowedTools: ["*"],
      },
      permissions: ["filesystem.read"],
    });
    await engine.saveDefinition(definition);

    const instanceId = await engine.launch({
      graphId: definition.id,
      security: GRAPH_LAUNCH_SECURITY,
    });
    await vi.waitFor(() => expect(fixture.startLoop).toHaveBeenCalledOnce());

    const graphExecution = await fixture.executionFor(
      "graph-instance",
      instanceId,
    );
    const agentExecution = await fixture.executionFor(
      "graph-agent",
      `${instanceId}/work/1`,
    );
    expect(agentExecution.parentExecutionId).toBe(graphExecution.id);
    expect(fixture.startLoop).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedTools: ["filesystem.read"],
        sessionId: instanceId,
        security: {
          kind: "bound",
          executionId: agentExecution.id,
          operationPrefix: `graph/${instanceId}/node/${modelNodeSegment("work")}/attempt/1/agent`,
        },
      }),
    );
    const runId = fixture.startLoop.mock.results[0]?.value
      ? (await fixture.startLoop.mock.results[0].value).id
      : "";
    await fixture.finishLoop(runId, "done");
    await fixture.flush();
    expect(engine.getInstance(instanceId)?.status).toBe("completed");
  });

  it("recovers an indeterminate agent whose child already closed", async () => {
    const fixture = createGraphHarness();
    const engine = await initializedEngine(fixture);
    const definition = linearDefinition({
      id: "agent-closed-before-checkpoint",
      taskKind: "invoke_agent",
      taskConfig: { prompt: "Finish before the parent checkpoint" },
    });
    await engine.saveDefinition(definition);
    const instanceId = await engine.launch({
      graphId: definition.id,
      security: GRAPH_LAUNCH_SECURITY,
    });
    await vi.waitFor(() => expect(fixture.startLoop).toHaveBeenCalledOnce());
    const agentExecutionId = (
      await fixture.executionFor(
        "graph-agent",
        `${instanceId}/work/1`,
      )
    ).id;
    const child = await securityRuntime.executions.bind(
      GRAPH_PLUGIN_ID,
      { mode: "resume", executionId: agentExecutionId },
      "merge_to_parent",
    );
    await child.close({
      outcome: "completed",
      reason: "Agent completed before the parent checkpoint",
    });
    await engine.dispose();

    const restored = createGraphHarness(fixture.storedValues);
    const restoredEngine = await initializedEngine(restored);
    expect(restoredEngine.getInstance(instanceId)).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/indeterminate result/i),
    });
  });

  it("serializes concurrent definition version assignment", async () => {
    const fixture = createGraphHarness();
    const engine = await initializedEngine(fixture);
    const base = linearDefinition({ id: "concurrent-save" });
    await engine.saveDefinition(base);

    const [first, second] = await Promise.all([
      engine.saveDefinition(
        linearDefinition({
          id: base.id,
          taskConfig: { name: "result", value: "first" },
        }),
      ),
      engine.saveDefinition(
        linearDefinition({
          id: base.id,
          taskConfig: { name: "result", value: "second" },
        }),
      ),
    ]);

    expect([first.version, second.version]).toEqual(["1.0.1", "1.0.2"]);
    expect(
      fixture.storedValues.has(
        "definitions/versions/concurrent-save/1.0.1",
      ),
    ).toBe(true);
    expect(
      fixture.storedValues.has(
        "definitions/versions/concurrent-save/1.0.2",
      ),
    ).toBe(true);
    await expect(
      engine.saveDefinition(
        linearDefinition({
          id: base.id,
          taskConfig: { name: "result", value: "stale overwrite" },
        }),
      ),
    ).rejects.toThrow(/version 1\.0\.0 is stale/i);
  });

  it("orders prerelease versions that contain hyphens", async () => {
    const fixture = createGraphHarness();
    const engine = await initializedEngine(fixture);
    await engine.saveDefinition(
      linearDefinition({
        id: "prerelease-version",
        version: "1.0.0-alpha-beta",
      }),
    );

    const saved = await engine.saveDefinition(
      linearDefinition({
        id: "prerelease-version",
        version: "1.0.0-alpha-zeta",
      }),
    );

    expect(saved.version).toBe("1.0.0-alpha-zeta");
  });

  it("enforces input and variable schemas", async () => {
    const fixture = createGraphHarness();
    const engine = await initializedEngine(fixture);
    const definition: GraphDefinition = {
      ...linearDefinition({
        id: "schema-enforcement",
        taskConfig: { name: "result", value: 42 },
      }),
      inputSchema: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string" },
        },
        additionalProperties: false,
      },
      variablesSchema: {
        type: "object",
        properties: {
          result: { type: "string" },
        },
      },
    };
    await engine.saveDefinition(definition);

    await expect(
      engine.launch({
        graphId: definition.id,
        input: { name: 42 },
        security: GRAPH_LAUNCH_SECURITY,
      }),
    ).rejects.toThrow(/input\.name must be string/i);

    const instanceId = await engine.launch({
      graphId: definition.id,
      input: { name: "valid" },
      security: GRAPH_LAUNCH_SECURITY,
    });
    await fixture.flush();
    expect(engine.getInstance(instanceId)).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/variables\.result must be string/i),
    });

    const closedInput: GraphDefinition = {
      ...linearDefinition({ id: "closed-input-schema" }),
      inputSchema: {
        type: "object",
        additionalProperties: false,
      },
    };
    await engine.saveDefinition(closedInput);
    await expect(
      engine.launch({
        graphId: closedInput.id,
        input: { unexpected: true },
        security: GRAPH_LAUNCH_SECURITY,
      }),
    ).rejects.toThrow(/input\.unexpected is not allowed/i);
  });

  it("does not replay an indeterminate side-effecting step after restart", async () => {
    const fixture = createGraphHarness();
    const engine = await initializedEngine(fixture);
    let finishTool!: (value: { ok: boolean }) => void;
    const toolResult = new Promise<{ ok: boolean }>((resolve) => {
      finishTool = resolve;
    });
    const toolHandler = vi.fn(async () => toolResult);
    fixture.registerToolHandler("fixture.write", toolHandler);
    const definition = linearDefinition({
      id: "indeterminate-tool",
      taskKind: "call_tool",
      taskConfig: { toolId: "fixture.write", input: { value: "once" } },
      permissions: ["fixture.write"],
    });
    await engine.saveDefinition(definition);
    const instanceId = await engine.launch({
      graphId: definition.id,
      security: GRAPH_LAUNCH_SECURITY,
    });
    await vi.waitFor(() => expect(toolHandler).toHaveBeenCalledOnce());

    await engine.dispose();
    finishTool({ ok: true });
    await fixture.flush();
    const restored = createGraphHarness(fixture.storedValues);
    const restoredEngine = await initializedEngine(restored);

    expect(restoredEngine.getInstance(instanceId)).toMatchObject({
      status: "failed",
      error: expect.stringMatching(/indeterminate result/i),
    });
    expect(restored.invokeTool).not.toHaveBeenCalled();
  });

  it("does not replay contributed steps unless they opt into replay safety", async () => {
    let finish!: () => void;
    const execute = vi.fn(
      async () =>
        new Promise<string>((resolve) => {
          finish = () => resolve("done");
        }),
    );
    const contribution = {
      kind: "side_effect",
      type: "task" as const,
      label: "Side effect",
      configSchema: z.object({}).strict(),
      execute,
    };
    const fixture = createGraphHarness(undefined, {
      steps: [contribution],
    });
    const engine = await initializedEngine(fixture);
    const definition = linearDefinition({
      id: "contributed-recovery",
      taskKind: contribution.kind,
      taskConfig: {},
    });
    await engine.saveDefinition(definition);
    const instanceId = await engine.launch({
      graphId: definition.id,
      security: GRAPH_LAUNCH_SECURITY,
    });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    await engine.dispose();
    finish();
    await fixture.flush();

    const restored = createGraphHarness(fixture.storedValues, {
      steps: [contribution],
    });
    const restoredEngine = await initializedEngine(restored);

    expect(restoredEngine.getInstance(instanceId)?.status).toBe("failed");
    expect(execute).toHaveBeenCalledOnce();
  });

  it("continues independent branches while another branch waits", async () => {
    const fixture = createGraphHarness();
    const engine = await initializedEngine(fixture);
    let answerFeedback!: (response: {
      interactionId: string;
      answer: { kind: "confirm"; confirmed: boolean };
    }) => void;
    const feedback = new Promise<{
      interactionId: string;
      answer: { kind: "confirm"; confirmed: boolean };
    }>((resolve) => {
      answerFeedback = resolve;
    });
    fixture.handleCommand(feedbackAsk.id, async () => feedback);
    const definition: GraphDefinition = {
      ...linearDefinition({ id: "parallel-wait" }),
      nodes: [
        {
          id: "start",
          type: "trigger",
          kind: "manual",
          config: {},
          onError: { action: "fail" },
        },
        {
          id: "gate",
          type: "task",
          kind: "feedback_gate",
          config: { prompt: "Continue?", form: "confirm" },
          onError: { action: "fail" },
        },
        {
          id: "independent",
          type: "task",
          kind: "set_variable",
          config: { name: "progressed", value: true },
          onError: { action: "fail" },
        },
        {
          id: "end",
          type: "control",
          kind: "end",
          config: { output: "$vars.progressed" },
          onError: { action: "fail" },
        },
      ],
      edges: [
        { id: "start-gate", source: "start", target: "gate" },
        {
          id: "start-independent",
          source: "start",
          target: "independent",
        },
        { id: "gate-end", source: "gate", target: "end" },
        {
          id: "independent-end",
          source: "independent",
          target: "end",
        },
      ],
    };
    await engine.saveDefinition(definition);
    const instanceId = await engine.launch({
      graphId: definition.id,
      security: GRAPH_LAUNCH_SECURITY,
    });
    await vi.waitFor(() =>
      expect(engine.getInstance(instanceId)).toMatchObject({
        status: "waiting",
        variables: { progressed: true },
        nodeStates: expect.arrayContaining([
          expect.objectContaining({
            nodeId: "independent",
            status: "completed",
          }),
        ]),
      }),
    );

    answerFeedback({
      interactionId: crypto.randomUUID(),
      answer: { kind: "confirm", confirmed: true },
    });
    await fixture.flush();
    expect(engine.getInstance(instanceId)?.status).toBe("completed");
  });

  it("keeps a failed run terminal when a slower sibling completes", async () => {
    const fixture = createGraphHarness();
    const engine = await initializedEngine(fixture);
    let finishSlow!: () => void;
    let slowSignal: AbortSignal | undefined;
    fixture.registerToolHandler(
      "fixture.slow",
      async (_input, options) =>
        new Promise<{ ok: boolean }>((resolve) => {
          slowSignal = options.signal;
          finishSlow = () => resolve({ ok: true });
        }),
    );
    const base = linearDefinition({ id: "parallel-failure" });
    const definition: GraphDefinition = {
      ...base,
      permissions: ["*"],
      nodes: [
        base.nodes[0]!,
        {
          id: "slow",
          type: "task",
          kind: "call_tool",
          config: { toolId: "fixture.slow", input: {} },
          onError: { action: "fail" },
        },
        {
          id: "fail",
          type: "task",
          kind: "call_tool",
          config: { toolId: "fixture.unavailable", input: {} },
          onError: { action: "fail" },
        },
        base.nodes[2]!,
      ],
      edges: [
        { id: "start-slow", source: "start", target: "slow" },
        { id: "start-fail", source: "start", target: "fail" },
        { id: "slow-end", source: "slow", target: "end" },
        { id: "fail-end", source: "fail", target: "end" },
      ],
    };
    await engine.saveDefinition(definition);
    const instanceId = await engine.launch({
      graphId: definition.id,
      security: GRAPH_LAUNCH_SECURITY,
    });
    await vi.waitFor(() =>
      expect(engine.getInstance(instanceId)?.status).toBe("failed"),
    );
    expect(slowSignal?.aborted).toBe(true);

    finishSlow();
    await fixture.flush();

    expect(engine.getInstance(instanceId)?.status).toBe("failed");
  });

  it("evaluates for_each collection expressions for every item", async () => {
    const fixture = createGraphHarness();
    const engine = await initializedEngine(fixture);
    const baseDefinition = linearDefinition({
      id: "for-each",
      taskKind: "for_each",
      taskConfig: {
        items: "$input.items",
        itemVariable: "item",
        collect: "$vars.item",
        resultVariable: "results",
      },
      endConfig: { output: "$vars.results" },
    });
    const definition: GraphDefinition = {
      ...baseDefinition,
      nodes: baseDefinition.nodes.map((node) =>
        node.id === "work" ? { ...node, type: "control" as const } : node,
      ),
    };
    await engine.saveDefinition(definition);

    const instanceId = await engine.launch({
      graphId: definition.id,
      input: { items: ["one", "two", "three"] },
      security: GRAPH_LAUNCH_SECURITY,
    });
    await fixture.flush();

    expect(engine.getInstance(instanceId)).toMatchObject({
      status: "completed",
      variables: {
        item: "three",
        results: ["one", "two", "three"],
      },
      output: ["one", "two", "three"],
    });
  });

  it("validates and executes contributed graph steps", async () => {
    const fixture = createGraphHarness(undefined, {
      steps: [
        {
          kind: "custom_upper",
          type: "task",
          label: "Uppercase",
          configSchema: z.object({ text: z.string() }).strict(),
          execute: (config) =>
            (config as { readonly text: string }).text.toUpperCase(),
        },
      ],
    });
    const engine = await initializedEngine(fixture);
    const definition = linearDefinition({
      id: "contributed-step",
      taskKind: "custom_upper",
      taskConfig: { text: "from a child plugin" },
      endConfig: { output: "$steps.work" },
    });
    await engine.saveDefinition(definition);

    const instanceId = await engine.launch({
      graphId: definition.id,
      security: GRAPH_LAUNCH_SECURITY,
    });
    await fixture.flush();

    expect(engine.getInstance(instanceId)).toMatchObject({
      status: "completed",
      output: "FROM A CHILD PLUGIN",
    });
  });

  it("launches graphs from contributed triggers", async () => {
    let fire!: (
      input?: Readonly<Record<string, JsonValue>>,
    ) => void | Promise<void>;
    const fixture = createGraphHarness(undefined, {
      triggers: [
        {
          kind: "custom_trigger",
          label: "Custom trigger",
          configSchema: z.object({}).strict(),
          subscribe: (_config, trigger) => {
            fire = trigger;
            return { dispose: () => undefined };
          },
        },
      ],
    });
    const engine = await initializedEngine(fixture);
    const definition = linearDefinition({
      id: "contributed-trigger",
      triggerKind: "custom_trigger",
      taskConfig: { name: "value", value: "$input.value" },
      output: { value: "$vars.value" },
    });
    await engine.saveDefinition(definition);

    await fire({ value: "launched" });
    await fixture.flush();

    expect(engine.listInstances(definition.id)).toEqual([
      expect.objectContaining({
        trigger: "custom_trigger",
        status: "completed",
        output: { value: "launched" },
      }),
    ]);
  });

  it("keeps a saved graph usable when its custom trigger cannot subscribe", async () => {
    const fixture = createGraphHarness(undefined, {
      triggers: [
        {
          kind: "broken_trigger",
          label: "Broken trigger",
          configSchema: z.object({}).strict(),
          subscribe: () => {
            throw new Error("subscriber unavailable");
          },
        },
      ],
    });
    const engine = await initializedEngine(fixture);
    const definition = linearDefinition({
      id: "broken-trigger",
      triggerKind: "broken_trigger",
    });

    await expect(engine.saveDefinition(definition)).resolves.toMatchObject({
      id: definition.id,
    });
    const instanceId = await engine.launch({
      graphId: definition.id,
      security: GRAPH_LAUNCH_SECURITY,
    });
    await fixture.flush();
    expect(engine.getInstance(instanceId)?.status).toBe("completed");
  });

  it("isolates stored definitions whose contribution is unavailable", async () => {
    const contribution = {
      kind: "temporary_step",
      type: "task" as const,
      label: "Temporary step",
      configSchema: z.object({}).strict(),
      execute: () => "done",
    };
    const fixture = createGraphHarness(undefined, {
      steps: [contribution],
    });
    const engine = await initializedEngine(fixture);
    await engine.saveDefinition(
      linearDefinition({
        id: "missing-contribution",
        taskKind: contribution.kind,
        taskConfig: {},
      }),
    );
    await engine.dispose();

    const restoredSteps: (typeof contribution)[] = [];
    const restored = createGraphHarness(fixture.storedValues, {
      steps: restoredSteps,
    });
    const restoredEngine = await initializedEngine(restored);

    expect(
      restoredEngine
        .listDefinitions()
        .some(({ id }) => id === "missing-contribution"),
    ).toBe(false);
    expect(
      restoredEngine.listDefinitions().some(({ id }) => id === "quick-start"),
    ).toBe(true);

    restoredSteps.push(contribution);
    await restoredEngine.refreshContributions();
    expect(
      restoredEngine
        .listDefinitions()
        .some(({ id }) => id === "missing-contribution"),
    ).toBe(true);
  });

  it("rejects unsupported, unreachable, and cyclic graph definitions", () => {
    expect(() =>
      validateGraphDefinition(
        linearDefinition({
          id: "unsupported-graph",
          taskKind: "langgraph_node",
        }),
      ),
    ).toThrow(/invalid task kind langgraph_node/i);
    expect(() =>
      validateGraphDefinition(
        linearDefinition({
          id: "unbound-incoming-message",
          triggerKind: "incoming_message",
          triggerConfig: {},
        }),
      ),
    ).toThrow(/requires a channel binding/i);

    const base = linearDefinition({ id: "unreachable-graph" });
    const unreachable: GraphDefinition = {
      ...base,
      nodes: [
        ...base.nodes,
        {
          id: "orphan-a",
          type: "task",
          kind: "set_variable",
          config: { name: "a", value: true },
          onError: { action: "fail" },
        },
        {
          id: "orphan-b",
          type: "task",
          kind: "set_variable",
          config: { name: "b", value: true },
          onError: { action: "fail" },
        },
      ],
      edges: [
        ...base.edges,
        { id: "orphan-a-b", source: "orphan-a", target: "orphan-b" },
        { id: "orphan-b-a", source: "orphan-b", target: "orphan-a" },
      ],
    };
    expect(() => validateGraphDefinition(unreachable)).toThrow(
      /unreachable nodes: orphan-a, orphan-b/i,
    );

    const cyclicBase = linearDefinition({ id: "cyclic-graph" });
    const cyclic: GraphDefinition = {
      ...cyclicBase,
      nodes: [
        cyclicBase.nodes[0]!,
        cyclicBase.nodes[1]!,
        {
          id: "loop",
          type: "task",
          kind: "set_variable",
          config: { name: "looped", value: true },
          onError: { action: "fail" },
        },
        cyclicBase.nodes[2]!,
      ],
      edges: [
        { id: "start-work", source: "start", target: "work" },
        { id: "work-loop", source: "work", target: "loop" },
        { id: "loop-work", source: "loop", target: "work" },
        { id: "loop-end", source: "loop", target: "end" },
      ],
    };
    expect(() => validateGraphDefinition(cyclic)).toThrow(/contains a cycle/i);
  });
});
