import {
  feedbackAsk,
  graphDefinitionSaved,
  graphInstanceCompleted,
  graphInstanceFailed,
  graphInstanceStarted,
  graphInstanceUpdated,
  graphStepCompleted,
  type GraphDefinition,
} from "@borg/contracts";
import { z, type JsonValue } from "@borg/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HiveMindGraphEngine,
  validateGraphDefinition,
} from "../src/executor";
import { createGraphHarness, linearDefinition } from "./harness";

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
  await Promise.allSettled(
    engines.splice(0).map(async (engine) => engine.dispose()),
  );
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

    const firstPersistedVersion = fixture.storedValues.get(
      "definitions/versions/manual-fixture/1.0.0",
    ) as unknown as { definition: GraphDefinition };
    const secondPersistedVersion = fixture.storedValues.get(
      "definitions/versions/manual-fixture/1.0.1",
    ) as unknown as { definition: GraphDefinition };
    const currentDefinition = fixture.storedValues.get(
      "definitions/current/manual-fixture",
    ) as unknown as { definition: GraphDefinition };
    const persistedInstance = fixture.storedValues.get(
      `instances/${instanceId}`,
    ) as unknown as {
      instance: { definitionVersion: string; output: unknown };
      definition: GraphDefinition;
    };

    expect(firstPersistedVersion.definition.version).toBe("1.0.0");
    expect(firstPersistedVersion.definition.nodes[1]?.config.value).toBe(
      "fixture-result",
    );
    expect(secondPersistedVersion.definition.version).toBe("1.0.1");
    expect(currentDefinition.definition.version).toBe("1.0.1");
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

    const instanceId = await engine.launch({ graphId: definition.id });
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

    const instanceId = await engine.launch({ graphId: definition.id });
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

    const instanceId = await engine.launch({ graphId: definition.id });
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
    });
    await fixture.flush();

    expect(fixture.registerExecutionScope).toHaveBeenCalledWith({
      runId: instanceId,
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

    const instanceId = await engine.launch({ graphId: definition.id });
    await vi.waitFor(() => expect(fixture.startLoop).toHaveBeenCalledOnce());

    expect(fixture.startLoop).toHaveBeenCalledWith(
      expect.objectContaining({
        allowedTools: ["filesystem.read"],
        sessionId: instanceId,
      }),
    );
    const runId = fixture.startLoop.mock.results[0]?.value
      ? (await fixture.startLoop.mock.results[0].value).id
      : "";
    await fixture.finishLoop(runId, "done");
    await fixture.flush();
    expect(engine.getInstance(instanceId)?.status).toBe("completed");
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
      }),
    ).rejects.toThrow(/input\.name must be string/i);

    const instanceId = await engine.launch({
      graphId: definition.id,
      input: { name: "valid" },
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
    const instanceId = await engine.launch({ graphId: definition.id });
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
    const instanceId = await engine.launch({ graphId: definition.id });
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
    const instanceId = await engine.launch({ graphId: definition.id });
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
    const instanceId = await engine.launch({ graphId: definition.id });
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

    const instanceId = await engine.launch({ graphId: definition.id });
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
    const instanceId = await engine.launch({ graphId: definition.id });
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
