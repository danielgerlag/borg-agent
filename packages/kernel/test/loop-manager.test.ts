import {
  modelOperationKeySchema,
  type LoopStartInput,
} from "@borg/contracts";
import {
  defineTool,
  z,
  type LlmProviderContribution,
  type MemoryProviderContribution,
  type MemoryRecord,
  type ProviderEgress,
} from "@borg/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  CostLedger,
  DEFAULT_PERSONA_ID,
  ExecutionSecurityService,
  LoopManager,
  MemoryFacade,
  PersonaService,
  PromptAssembler,
  type ModelGateway,
} from "../src";
import { createSecurityRuntime } from "./security-runtime";

const TEST_PROVIDER_EGRESS = {
  kind: "remote",
  capacity: "internal",
  destination: "https://models.test.invalid/v1/generate",
} satisfies ProviderEgress;

type LoopStartWithoutSecurity = Omit<LoopStartInput, "security">;

function loopStartInput(
  operationId: string,
  input: LoopStartWithoutSecurity,
): LoopStartInput {
  return {
    ...input,
    security: {
      kind: "root",
      subject: {
        kind: "loop-test",
        id: operationId,
      },
      classification: "internal",
      provenance: {
        kind: "plugin",
        id: "borg.kernel.loop-manager-test",
      },
      operationPrefix: `loop-manager/${operationId}`,
    },
  };
}

function registerModelProvider(
  models: ModelGateway,
  ownerPluginId: string,
  provider: LlmProviderContribution,
) {
  return models.registerProvider(ownerPluginId, provider);
}

function createLoopRuntime(
  canInvokeTools?: (pluginId: string) => boolean,
) {
  const runtime = createSecurityRuntime();
  const loops =
    canInvokeTools === undefined
      ? new LoopManager(
          runtime.models,
          runtime.executions,
          runtime.tools,
          runtime.costs,
        )
      : new LoopManager(
          runtime.models,
          runtime.executions,
          runtime.tools,
          runtime.costs,
          canInvokeTools,
        );
  return { ...runtime, loops };
}

class DelayedExecutionSecurityService extends ExecutionSecurityService {
  constructor(
    store: ConstructorParameters<typeof ExecutionSecurityService>[0],
    readonly ready: Promise<void>,
  ) {
    super(store);
  }

  override async bind(
    ...args: Parameters<ExecutionSecurityService["bind"]>
  ) {
    await this.ready;
    return await super.bind(...args);
  }
}

async function bindModelExecution(
  executions: ExecutionSecurityService,
  ownerPluginId: string,
  operationId: string,
) {
  return await executions.bind(
    ownerPluginId,
    {
      mode: "root",
      subject: {
        kind: "model-test",
        id: operationId,
      },
      classification: "internal",
      provenance: {
        kind: "plugin",
        id: "borg.kernel.loop-manager-test",
      },
    },
    "detached",
  );
}

function createRuntime() {
  const runtime = createLoopRuntime();
  const { models, tools } = runtime;
  const executeEcho = vi.fn(({ text }: { readonly text: string }) => ({
    echoed: text,
  }));

  tools.register(
    "borg.tools.echo",
    defineTool({
      id: "tools.echo",
      description: "Echo text",
      input: z.object({ text: z.string() }),
      output: z.object({ echoed: z.string() }),
      approval: "ask",
      sideEffect: false,
      execute: executeEcho,
    }),
  );
  registerModelProvider(models, "borg.mock-llm", {
    id: "borg.mock-llm",
    models: ["mock:scripted"],
    egress: TEST_PROVIDER_EGRESS,
    async complete(request, permit) {
      await permit.commit();
      const toolResult = request.messages.find(({ role }) => role === "tool");
      return toolResult
        ? {
            content: `done: ${toolResult.content}`,
            usage: {
              inputTokens: 3,
              outputTokens: 2,
              amount: 0.01,
              currency: "USD",
            },
          }
        : {
            toolCalls: [
              {
                id: "call-1",
                name: "tools.echo",
                input: { text: "hello" },
              },
            ],
            usage: {
              inputTokens: 3,
              outputTokens: 2,
              amount: 0.01,
              currency: "USD",
            },
          };
    },
  });
  return { ...runtime, executeEcho };
}

describe("LoopManager", () => {
  it("rejects a loop without explicit execution security", async () => {
    const { loops } = createLoopRuntime();

    await expect(
      loops.start({ prompt: "unsecured" } as LoopStartInput),
    ).rejects.toThrow(/security/i);
  });

  it("runs a model-tool-model flow through approval and records usage", async () => {
    const { interactions, costs, loops } = createRuntime();
    const run = await loops.start(
      loopStartInput("model-tool-model-flow", {
        prompt: "use echo",
        providerId: "borg.mock-llm",
        modelId: "mock:scripted",
        allowedTools: ["tools.echo"],
      }),
    );
    const eventTypes: string[] = [];
    let toolInput: unknown;
    loops.subscribeRun(run.id, "kernel.loop", (event) => {
      eventTypes.push(event.type);
      if (event.type === "tool_start") {
        toolInput = event.input;
      }
    });
    await vi.waitFor(() => expect(interactions.listPending()).toHaveLength(1));
    const approval = interactions.listPending()[0];
    expect(approval?.kind).toBe("tool_approval");
    expect(approval?.prompt).not.toContain("hello");
    interactions.respond(approval!.id, {
      kind: "approval",
      decision: "allow",
    });

    await vi.waitFor(() => expect(loops.get(run.id)?.status).toBe("completed"));
    expect(loops.get(run.id)).toMatchObject({
      output: 'done: {"echoed":"hello"}',
      inputTokens: 6,
      outputTokens: 4,
      costsByCurrency: { USD: 0.02 },
    });
    expect(costs.list(run.id)).toHaveLength(2);
    expect(
      new Set(costs.list(run.id).map(({ correlationId }) => correlationId)),
    ).toEqual(new Set([run.id]));
    await vi.waitFor(() => expect(eventTypes).toContain("final"));
    expect(eventTypes).toEqual(
      expect.arrayContaining([
        "tool_start",
        "state",
        "model_start",
        "interaction_wait",
        "tool_result",
        "usage",
        "model_token",
        "final",
      ]),
    );
    expect(toolInput).toEqual({ text: "hello" });
    expect(Object.isFrozen(toolInput)).toBe(true);
    expect(() => {
      (toolInput as Record<string, unknown>).text = "mutated";
    }).toThrow();
  });

  it("fails the run when the user denies a tool", async () => {
    const { interactions, loops, executeEcho } = createRuntime();
    const run = await loops.start(
      loopStartInput("denied-tool", {
        prompt: "use echo",
        allowedTools: ["tools.echo"],
      }),
    );
    await vi.waitFor(() => expect(interactions.listPending()).toHaveLength(1));
    interactions.respond(interactions.listPending()[0]!.id, {
      kind: "approval",
      decision: "deny",
    });
    await vi.waitFor(() => expect(loops.get(run.id)?.status).toBe("failed"));
    expect(loops.get(run.id)?.error).toMatch(/denied/);
    expect(executeEcho).not.toHaveBeenCalled();
  });

  it("withholds denied model tokens from live and replayed history", async () => {
    const { loops, models, scanners } = createLoopRuntime();
    scanners.register("borg.security", {
      id: "borg.security.prompt-injection",
      stages: ["model_output"],
      scan: async ({ stage }) =>
        stage === "model_output"
          ? [
              {
                code: "injection.override",
                action: "block",
                reason: "model output was blocked",
              },
            ]
          : [],
    });
    registerModelProvider(models, "borg.mock-llm", {
      id: "borg.mock-llm",
      models: ["mock:scripted"],
      egress: TEST_PROVIDER_EGRESS,
      async complete(_request, permit, _signal, onRawToken) {
        await permit.commit();
        await onRawToken?.("blocked text");
        return {
          content: "blocked text",
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            amount: 0,
            currency: "USD",
          },
        };
      },
    });

    const live: string[] = [];
    const run = await loops.start(
      loopStartInput("denied-model-output", { prompt: "hello" }),
    );
    loops.subscribeRun(run.id, "kernel.loop", (event) => {
      if (event.type === "model_token") {
        live.push(event.token);
      }
    });

    await vi.waitFor(() => expect(loops.get(run.id)?.status).toBe("failed"));
    expect(live).toEqual([]);
    expect(loops.get(run.id)?.error).toMatch(/denied/);

    const replayed: string[] = [];
    loops.subscribeRun(run.id, "kernel.loop", (event) => {
      if (event.type === "model_token") {
        replayed.push(event.token);
      }
    });
    expect(replayed).toEqual([]);
  });

  it("emits interaction_wait while approved model output stays held", async () => {
    const { interactions, loops, models, scanners } = createLoopRuntime();
    scanners.register("borg.review", {
      id: "borg.review.model-output",
      stages: ["model_output"],
      scan: async () => [
        {
          code: "review.output",
          action: "review",
          reason: "model output needs review",
        },
      ],
    });
    registerModelProvider(models, "borg.mock-llm", {
      id: "borg.mock-llm",
      models: ["mock:scripted"],
      egress: TEST_PROVIDER_EGRESS,
      async complete(_request, permit, _signal, onRawToken) {
        await permit.commit();
        await onRawToken?.("approved text");
        return {
          content: "approved text",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    });

    const tokens: string[] = [];
    const events: string[] = [];
    const run = await loops.start(
      loopStartInput("reviewed-model-output", { prompt: "hello" }),
    );
    loops.subscribeRun(run.id, "kernel.loop", (event) => {
      events.push(event.type);
      if (event.type === "model_token") {
        tokens.push(event.token);
      }
    });

    await vi.waitFor(() =>
      expect(interactions.listPending()).toHaveLength(1),
    );
    expect(events).toContain("interaction_wait");
    expect(tokens).toEqual([]);
    interactions.respond(interactions.listPending()[0]!.id, {
      kind: "approval",
      decision: "allow",
    });
    await vi.waitFor(() =>
      expect(loops.get(run.id)?.status).toBe("completed"),
    );
    expect(tokens).toEqual(["approved text"]);
  });

  it("cancels a pending approval when its run ends", async () => {
    const { interactions, loops, executeEcho } = createRuntime();
    const run = await loops.start(
      loopStartInput("cancel-pending-approval", {
        prompt: "use echo",
        allowedTools: ["tools.echo"],
      }),
    );
    await vi.waitFor(() => expect(interactions.listPending()).toHaveLength(1));

    expect(loops.cancel(run.id)).toBe(true);
    await vi.waitFor(() => expect(interactions.listPending()).toHaveLength(0));
    expect(loops.get(run.id)?.status).toBe("cancelled");
    expect(executeEcho).not.toHaveBeenCalled();
  });

  it("closes late-bound execution security when setup is cancelled", async () => {
    const runtime = createSecurityRuntime();
    let releaseBinding = (): void => {
      throw new Error("Binding gate was not initialized");
    };
    const bindingGate = new Promise<void>((resolve) => {
      releaseBinding = resolve;
    });
    const executions = new DelayedExecutionSecurityService(
      runtime.store,
      bindingGate,
    );
    const loops = new LoopManager(
      runtime.models,
      executions,
      runtime.tools,
      runtime.costs,
    );
    const input = loopStartInput("cancel-during-security-bind", {
      prompt: "cancel during setup",
    });
    if (input.security.kind !== "root") {
      throw new Error("Test loop security must be a root");
    }
    const run = await loops.start(input);

    expect(loops.cancel(run.id)).toBe(true);
    releaseBinding();
    const execution = await executions.bind(
      "kernel.loop",
      {
        mode: "root",
        subject: input.security.subject,
        classification: "internal",
        provenance: {
          kind: "plugin",
          id: "borg.kernel.loop-manager-test",
        },
      },
      "detached",
    );
    await vi.waitFor(async () =>
      expect((await execution.summary()).lifecycle).toMatchObject({
        state: "closed",
        outcome: "cancelled",
      }),
    );
    await expect(runtime.tools.prepareRun(run.id)).rejects.toThrow(
      /unavailable/,
    );
  });

  it("drains terminal event subscribers when cancelling owned runs", async () => {
    const { interactions, loops } = createRuntime();
    const run = await loops.start(
      loopStartInput("drain-cancelled-subscribers", {
        prompt: "use echo",
        allowedTools: ["tools.echo"],
      }),
    );
    await vi.waitFor(() => expect(interactions.listPending()).toHaveLength(1));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    loops.subscribeRun(run.id, "kernel.loop", async (event) => {
      if (event.type === "state" && event.status === "cancelled") {
        await gate;
      }
    });

    let drained = false;
    const cancellation = loops.cancelOwned("kernel.loop").then(() => {
      drained = true;
    });
    await vi.waitFor(() => expect(loops.get(run.id)?.status).toBe("cancelled"));
    await Promise.resolve();
    expect(drained).toBe(false);
    release();
    await cancellation;
    expect(drained).toBe(true);
  });

  it("reports an unavailable feedback tool instead of bypassing the registry", async () => {
    const { interactions, loops, models } = createLoopRuntime();
    registerModelProvider(models, "borg.mock-llm", {
      id: "borg.mock-llm",
      models: ["mock:scripted"],
      egress: TEST_PROVIDER_EGRESS,
      async complete(_request, permit) {
        await permit.commit();
        return {
          toolCalls: [
            {
              id: "call-1",
              name: "feedback.ask",
              input: { prompt: "Continue?", form: "confirm", source: {} },
            },
          ],
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    });

    const run = await loops.start(
      loopStartInput("unavailable-feedback-tool", { prompt: "ask" }),
    );
    await vi.waitFor(() => expect(loops.get(run.id)?.status).toBe("failed"));
    expect(loops.get(run.id)?.error).toContain("unavailable");
    expect(interactions.listPending()).toHaveLength(0);
  });

  it("waits for human feedback and continues the model turn", async () => {
    const { interactions, loops, models, tools } = createLoopRuntime();
    tools.register(
      "borg.feedback",
      defineTool({
        id: "feedback.ask",
        description: "Ask the user",
        input: z.object({
          prompt: z.string(),
          form: z.literal("text"),
          source: z.object({}).default({}),
        }),
        output: z.object({
          interactionId: z.string().uuid(),
          answer: z.object({ kind: z.literal("text"), text: z.string() }),
        }),
        approval: "auto",
        sideEffect: false,
        async execute(input, execution) {
          const wait = interactions.requestHumanInput(
            "borg.feedback",
            input,
            execution.signal,
          );
          const answer = await wait.response;
          if (answer.kind !== "text") {
            throw new Error("Expected a text answer");
          }
          return {
            interactionId: wait.interaction.id,
            answer,
          };
        },
      }),
    );
    registerModelProvider(models, "borg.mock-llm", {
      id: "borg.mock-llm",
      models: ["mock:scripted"],
      egress: TEST_PROVIDER_EGRESS,
      async complete(request, permit) {
        await permit.commit();
        const answer = request.messages.find(({ role }) => role === "tool");
        return answer
          ? {
              content: `continued with ${answer.content}`,
              usage: { inputTokens: 2, outputTokens: 2 },
            }
          : {
              toolCalls: [
                {
                  id: "feedback-call",
                  name: "feedback.ask",
                  input: {
                    prompt: "What next?",
                    form: "text",
                    source: {},
                  },
                },
              ],
              usage: { inputTokens: 2, outputTokens: 2 },
            };
      },
    });

    const run = await loops.start(
      loopStartInput("human-feedback", {
        prompt: "ask for feedback",
        allowedTools: ["feedback.ask"],
      }),
    );
    await vi.waitFor(() => expect(interactions.listPending()).toHaveLength(1));
    const pending = interactions.listPending()[0]!;
    interactions.respond(pending.id, {
      kind: "text",
      text: "ship it",
    });
    await vi.waitFor(() => expect(loops.get(run.id)?.status).toBe("completed"));
    expect(loops.get(run.id)?.output).toContain("ship it");
  });

  it("pauses at a safe point and resumes without losing the turn", async () => {
    const { loops, models } = createLoopRuntime();
    let finishModel: (() => void) | undefined;
    registerModelProvider(models, "borg.mock-llm", {
      id: "borg.mock-llm",
      models: ["mock:scripted"],
      egress: TEST_PROVIDER_EGRESS,
      async complete(_request, permit) {
        await new Promise<void>((resolve) => {
          finishModel = resolve;
        });
        await permit.commit();
        return {
          content: "paused safely",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    });

    const run = await loops.start(
      loopStartInput("pause-and-resume", { prompt: "pause me" }),
    );
    await vi.waitFor(() => expect(finishModel).toBeDefined());
    expect(loops.pause(run.id)).toBe(true);
    finishModel?.();
    await vi.waitFor(() => expect(loops.get(run.id)?.status).toBe("paused"));
    expect(loops.resume(run.id)).toBe(true);
    await vi.waitFor(() => expect(loops.get(run.id)?.status).toBe("completed"));
    expect(loops.get(run.id)?.output).toBe("paused safely");
  });

  it("keeps cancellation terminal when a provider returns late", async () => {
    const { costs, loops, models } = createLoopRuntime();
    let finishModel: (() => void) | undefined;
    registerModelProvider(models, "borg.mock-llm", {
      id: "borg.mock-llm",
      models: ["mock:scripted"],
      egress: TEST_PROVIDER_EGRESS,
      async complete(_request, permit) {
        await permit.commit();
        await new Promise<void>((resolve) => {
          finishModel = resolve;
        });
        return {
          content: "too late",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    });

    const run = await loops.start(
      loopStartInput("late-provider-cancellation", { prompt: "cancel me" }),
    );
    await vi.waitFor(() => expect(finishModel).toBeDefined());
    expect(loops.cancel(run.id)).toBe(true);
    finishModel?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(loops.get(run.id)).toMatchObject({
      status: "cancelled",
      error: "Cancelled",
      inputTokens: 1,
      outputTokens: 1,
    });
    expect(loops.get(run.id)?.output).toBeUndefined();
    expect(costs.list(run.id)).toHaveLength(1);
  });

  it("counts live runs by owner without exposing ownership on snapshots", async () => {
    const { loops, models } = createLoopRuntime();
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    registerModelProvider(models, "borg.mock-llm", {
      id: "borg.mock-llm",
      models: ["mock:scripted"],
      egress: TEST_PROVIDER_EGRESS,
      async complete(_request, permit) {
        await permit.commit();
        await held;
        return {
          content: "done",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    });

    const chat = await loops.start(
      loopStartInput("owned-chat-run", { prompt: "chat turn" }),
      "borg.chat",
    );
    const bot = await loops.start(
      loopStartInput("owned-bot-run", { prompt: "bot turn" }),
      "borg.bots",
    );
    expect(chat).not.toHaveProperty("ownerPluginId");
    expect(loops.countLive()).toBe(2);
    expect(loops.countLive("borg.bots")).toBe(1);
    expect(loops.countLive("borg.chat")).toBe(1);
    loops.cancel(chat.id, "borg.chat");
    expect(loops.countLive()).toBe(1);
    expect(loops.countLive("borg.bots")).toBe(1);
    release();
    loops.cancel(bot.id, "borg.bots");
  });

  it("does not advertise or invoke tools for a loop owner without permission", async () => {
    const { loops, models, tools } = createLoopRuntime(() => false);
    tools.register(
      "borg.tools.echo",
      defineTool({
        id: "tools.echo",
        description: "Echo",
        input: z.object({ text: z.string() }),
        output: z.object({ echoed: z.string() }),
        approval: "auto",
        sideEffect: false,
        execute: ({ text }) => ({ echoed: text }),
      }),
    );
    let advertisedTools = -1;
    registerModelProvider(models, "borg.mock-llm", {
      id: "borg.mock-llm",
      models: ["mock:scripted"],
      egress: TEST_PROVIDER_EGRESS,
      async complete(request, permit) {
        await permit.commit();
        advertisedTools = request.tools.length;
        return {
          toolCalls: [
            {
              id: "call-1",
              name: "tools.echo",
              input: { text: "blocked" },
            },
          ],
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    });

    const run = await loops.start(
      loopStartInput("unprivileged-tool-run", { prompt: "try a tool" }),
      "borg.unprivileged",
    );
    await vi.waitFor(() => expect(loops.get(run.id)?.status).toBe("failed"));
    expect(advertisedTools).toBe(0);
    expect(loops.get(run.id)?.error).toContain("cannot invoke tools");
  });

  it("routes an explicit model to the provider that exposes it", async () => {
    const { loops, models } = createLoopRuntime();
    registerModelProvider(models, "borg.first", {
      id: "borg.first",
      models: ["first:model"],
      egress: TEST_PROVIDER_EGRESS,
      async complete(_request, permit) {
        await permit.commit();
        return {
          content: "wrong provider",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    });
    registerModelProvider(models, "borg.second", {
      id: "borg.second",
      models: ["second:model"],
      egress: TEST_PROVIDER_EGRESS,
      async complete(_request, permit) {
        await permit.commit();
        return {
          content: "right provider",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    });

    const run = await loops.start(
      loopStartInput("explicit-model-routing", {
        prompt: "route me",
        modelId: "second:model",
      }),
    );
    await vi.waitFor(() => expect(loops.get(run.id)?.status).toBe("completed"));
    expect(loops.get(run.id)).toMatchObject({
      providerId: "borg.second",
      output: "right provider",
    });
  });

  it("does not execute a tool removed while approval is pending", async () => {
    const { interactions, tools } = createSecurityRuntime();
    const execute = vi.fn(() => ({ done: true }));
    const registration = tools.register(
      "borg.tools.revocable",
      defineTool({
        id: "tools.revocable",
        description: "Revocable tool",
        input: z.object({}).strict(),
        output: z.object({ done: z.boolean() }).strict(),
        approval: "ask",
        sideEffect: true,
        execute,
      }),
    );

    const invocation = tools.invoke("tools.revocable", {}, {
      callerPluginId: "borg.caller",
    });
    const rejection = expect(invocation).rejects.toMatchObject({
      code: "unavailable",
    });
    await vi.waitFor(() => expect(interactions.listPending()).toHaveLength(1));
    registration.dispose();
    await vi.waitFor(() => expect(interactions.listPending()).toHaveLength(0));
    await rejection;
    expect(execute).not.toHaveBeenCalled();
  });

  it("enforces the kernel-owned allowlist for run-scoped tool calls", async () => {
    const { tools } = createSecurityRuntime();
    const execute = vi.fn(() => ({ done: true }));
    tools.register(
      "borg.tools.restricted",
      defineTool({
        id: "tools.restricted",
        description: "Restricted tool",
        input: z.object({}).strict(),
        output: z.object({ done: z.boolean() }).strict(),
        approval: "auto",
        sideEffect: false,
        execute,
      }),
    );
    const policy = tools.registerRunPolicy(
      "run-restricted",
      "borg.owner",
      ["tools.allowed"],
    );

    await expect(
      tools.invoke("tools.restricted", {}, {
        callerPluginId: "borg.owner",
        runId: "run-restricted",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      tools.invoke("tools.restricted", {}, {
        callerPluginId: "borg.other",
        runId: "run-restricted",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(execute).not.toHaveBeenCalled();
    policy.dispose();
  });

  it("requires tools to satisfy every run policy layer", async () => {
    const { tools } = createSecurityRuntime();
    for (const id of ["tools.allowed", "tools.blocked"]) {
      tools.register(
        "borg.tools.layered",
        defineTool({
          id,
          description: id,
          input: z.object({}).strict(),
          output: z.object({ id: z.string() }).strict(),
          approval: "auto",
          sideEffect: false,
          execute: () => ({ id }),
        }),
      );
    }
    tools.registerRunPolicy("run-layered", "borg.owner", ["*"], {
      additionalAllowedTools: ["tools.allowed"],
    });

    expect(
      tools.listDefinitions(["*"], ["tools.allowed"]).map(({ id }) => id),
    ).toEqual(["tools.allowed"]);
    await expect(
      tools.invoke("tools.blocked", {}, {
        callerPluginId: "borg.owner",
        runId: "run-layered",
      }),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  it("rejects a result returned after its tool was removed", async () => {
    const { tools } = createSecurityRuntime();
    let finish: (() => void) | undefined;
    const registration = tools.register(
      "borg.tools.revocable",
      defineTool({
        id: "tools.revocable",
        description: "Revocable tool",
        input: z.object({}).strict(),
        output: z.object({ done: z.boolean() }).strict(),
        approval: "auto",
        sideEffect: false,
        async execute() {
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
          return { done: true };
        },
      }),
    );
    const invocation = tools.invoke("tools.revocable", {}, {
      callerPluginId: "borg.caller",
    });
    await vi.waitFor(() => expect(finish).toBeDefined());
    registration.dispose();
    finish?.();

    await expect(invocation).rejects.toMatchObject({ code: "unavailable" });
  });

  it("does not accept a completion from a removed provider but records its usage", async () => {
    const { costs, executions, models } = createSecurityRuntime();
    const execution = await bindModelExecution(
      executions,
      "borg.loop-test",
      "revoked-provider",
    );
    let finish: (() => void) | undefined;
    const registration = registerModelProvider(models, "borg.revocable", {
      id: "borg.revocable",
      models: ["revocable:model"],
      egress: TEST_PROVIDER_EGRESS,
      async complete(_request, permit) {
        await permit.commit();
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return {
          content: "late result",
          usage: {
            inputTokens: 2,
            outputTokens: 3,
            amount: 0.01,
            currency: "USD",
          },
        };
      },
    });

    const completion = models.complete(
      {
        ownerPluginId: "borg.loop-test",
        feature: "loop-test",
        runId: "run-1",
      },
      {
        executionId: execution.id,
        operationKey: modelOperationKeySchema.parse(
          "loop-manager/revoked-provider/model/0",
        ),
        providerId: "borg.revocable",
        modelId: "revocable:model",
        messages: [{ role: "user", content: "wait" }],
        tools: [],
      },
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(finish).toBeDefined());
    const rejection = expect(completion).rejects.toThrow(/no longer available/);
    registration.dispose();
    finish?.();

    await rejection;
    expect(costs.list("run-1")).toHaveLength(1);
  });

  it("does not call a model provider for a pre-cancelled request", async () => {
    const { executions, models } = createSecurityRuntime();
    const execution = await bindModelExecution(
      executions,
      "borg.loop-test",
      "pre-cancelled-provider",
    );
    const complete: LlmProviderContribution["complete"] = vi.fn(
      async (_request, permit) => {
        await permit.commit();
        return {
          content: "too late",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    );
    registerModelProvider(models, "borg.provider", {
      id: "borg.provider",
      models: ["provider:model"],
      egress: TEST_PROVIDER_EGRESS,
      complete,
    });
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));

    await expect(
      models.complete(
        {
          ownerPluginId: "borg.loop-test",
          feature: "loop-test",
          runId: "run",
        },
        {
          executionId: execution.id,
          operationKey: modelOperationKeySchema.parse(
            "loop-manager/pre-cancelled-provider/model/0",
          ),
          providerId: "borg.provider",
          modelId: "provider:model",
          messages: [{ role: "user", content: "test" }],
          tools: [],
        },
        controller.signal,
      ),
    ).rejects.toThrow(/cancelled/);
    expect(complete).not.toHaveBeenCalled();
  });

  it("prepares scoped providers before the first completion and advertises their tools", async () => {
    const { loops, models, tools } = createLoopRuntime();
    let advertised: string[] = [];
    tools.registerProvider("borg.mcp", {
      id: "borg.mcp",
      async prepare() {
        return {
          definitions: [
            {
              id: "mcp.demo.echo",
              description: "Scoped echo",
              inputSchema: { type: "object", properties: {} },
              approval: "auto",
              sideEffect: false,
            },
          ],
          execute: async () => ({ ok: true }),
        };
      },
    });
    registerModelProvider(models, "borg.mock-llm", {
      id: "borg.mock-llm",
      models: ["mock:scripted"],
      egress: TEST_PROVIDER_EGRESS,
      async complete(request, permit) {
        await permit.commit();
        advertised = request.tools.map(({ id }) => id);
        return {
          content: "done",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    });

    const run = await loops.start(
      loopStartInput("prepared-tool-catalog", { prompt: "list tools" }),
    );
    await vi.waitFor(() => expect(loops.get(run.id)?.status).toBe("completed"));
    expect(advertised).toEqual(["mcp.demo.echo"]);
  });

  it("cancels the run when catalog preparation is aborted", async () => {
    const { loops, models, tools } = createLoopRuntime();
    const complete: LlmProviderContribution["complete"] = vi.fn(
      async (_request, permit) => {
        await permit.commit();
        return {
          content: "should not run",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    );
    let preparing = false;
    tools.registerProvider("borg.mcp", {
      id: "borg.mcp",
      async prepare(scope) {
        preparing = true;
        await new Promise<void>((_resolve, reject) => {
          if (scope.signal.aborted) {
            reject(scope.signal.reason);
            return;
          }
          scope.signal.addEventListener(
            "abort",
            () => reject(scope.signal.reason),
            { once: true },
          );
        });
        return {
          definitions: [],
          execute: async () => ({}),
        };
      },
    });
    registerModelProvider(models, "borg.mock-llm", {
      id: "borg.mock-llm",
      models: ["mock:scripted"],
      egress: TEST_PROVIDER_EGRESS,
      complete,
    });

    const run = await loops.start(
      loopStartInput("cancel-tool-catalog-prepare", {
        prompt: "cancel during prepare",
      }),
    );
    await vi.waitFor(() => expect(preparing).toBe(true));
    expect(loops.cancel(run.id)).toBe(true);
    await vi.waitFor(() => expect(loops.get(run.id)?.status).toBe("cancelled"));
    expect(complete).not.toHaveBeenCalled();
  });

  it("degrades the catalog when a provider fails to prepare", async () => {
    const { loops, models, tools } = createLoopRuntime();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    let advertised: string[] = [];
    tools.registerProvider("borg.broken", {
      id: "borg.broken",
      prepare: async () => {
        throw new Error("prepare failed");
      },
    });
    tools.registerProvider("borg.mcp", {
      id: "borg.mcp",
      async prepare() {
        return {
          definitions: [
            {
              id: "mcp.demo.echo",
              description: "Healthy",
              inputSchema: { type: "object" },
              approval: "auto",
              sideEffect: false,
            },
          ],
          execute: async () => ({ ok: true }),
        };
      },
    });
    registerModelProvider(models, "borg.mock-llm", {
      id: "borg.mock-llm",
      models: ["mock:scripted"],
      egress: TEST_PROVIDER_EGRESS,
      async complete(request, permit) {
        await permit.commit();
        advertised = request.tools.map(({ id }) => id);
        return {
          content: "done",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    });

    const run = await loops.start(
      loopStartInput("degraded-tool-catalog", {
        prompt: "survive a provider failure",
      }),
    );
    await vi.waitFor(() => expect(loops.get(run.id)?.status).toBe("completed"));
    expect(advertised).toEqual(["mcp.demo.echo"]);
    expect(loops.get(run.id)?.error).toBeUndefined();
    consoleError.mockRestore();
  });

  it("injects recalled memory into the model system prompt", async () => {
    const runtime = createSecurityRuntime();
    const personas = new PersonaService(runtime.store);
    await personas.initialize();
    const memory = new MemoryFacade();
    const stored: MemoryRecord[] = [];
    const provider: MemoryProviderContribution = {
      id: "test.memory",
      write: async (record) => {
        stored.push(record);
      },
      retrieve: async () => stored,
    };
    memory.registerProvider("test.memory", provider);
    await memory.write("borg.chat", {
      text: "The user's favorite color is cerulean.",
      personaId: DEFAULT_PERSONA_ID,
    });
    const prompts = new PromptAssembler(personas, memory);
    const complete: LlmProviderContribution["complete"] = vi.fn(
      async (_request, permit) => {
        await permit.commit();
        return {
          content: "done",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    );
    registerModelProvider(runtime.models, "borg.mock-llm", {
      id: "borg.mock-llm",
      models: ["mock:scripted"],
      egress: TEST_PROVIDER_EGRESS,
      complete,
    });
    const loops = new LoopManager(
      runtime.models,
      runtime.executions,
      runtime.tools,
      runtime.costs,
      () => false,
      personas,
      prompts,
    );
    const run = await loops.start(
      loopStartInput("memory-recall", {
        prompt: "What is my favorite color?",
      }),
      "borg.chat",
    );
    await vi.waitFor(() => expect(loops.get(run.id)?.status).toBe("completed"));
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "system",
            content: expect.stringContaining(
              "The user's favorite color is cerulean.",
            ),
          }),
        ]),
      }),
      expect.objectContaining({ commit: expect.any(Function) }),
      expect.any(AbortSignal),
      expect.any(Function),
      expect.any(Function),
    );
  });
});

describe("CostLedger", () => {
  it("preserves totals for each currency", () => {
    const costs = new CostLedger();
    for (const [currency, amount] of [
      ["USD", 0.01],
      ["EUR", 0.02],
    ] as const) {
      costs.record({
        providerId: "borg.provider",
        modelId: "provider:model",
        inputTokens: 1,
        outputTokens: 2,
        amount,
        currency,
        correlationId: "correlation",
        runId: "run",
      });
    }

    expect(costs.totalForRun("run")).toEqual({
      inputTokens: 2,
      outputTokens: 4,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      amountsByCurrency: { USD: 0.01, EUR: 0.02 },
    });
  });

  it("requires amount and currency together", () => {
    const costs = new CostLedger();
    expect(() =>
      costs.record({
        providerId: "borg.provider",
        modelId: "provider:model",
        inputTokens: 1,
        outputTokens: 2,
        amount: 0.01,
        correlationId: "correlation",
      }),
    ).toThrow(/amount and currency/i);
  });

  it("rejects cache tokens that exceed total input", () => {
    const costs = new CostLedger();
    expect(() =>
      costs.record({
        providerId: "borg.provider",
        modelId: "provider:model",
        inputTokens: 2,
        outputTokens: 1,
        cachedInputTokens: 2,
        cacheWriteTokens: 1,
        correlationId: "correlation",
      }),
    ).toThrow(/must not exceed inputTokens/);
  });

  it("summarizes process-session usage across currencies and notifies subscribers", () => {
    const costs = new CostLedger();
    const seen: number[] = [];
    const subscription = costs.subscribe((summary) => {
      seen.push(summary.inputTokens);
    });
    costs.record({
      providerId: "borg.first",
      modelId: "first",
      inputTokens: 10,
      outputTokens: 2,
      cachedInputTokens: 4,
      cacheWriteTokens: 1,
      amount: 0.01,
      currency: "USD",
      correlationId: "one",
    });
    costs.record({
      providerId: "borg.second",
      modelId: "second",
      inputTokens: 5,
      outputTokens: 3,
      amount: 0.02,
      currency: "EUR",
      correlationId: "two",
    });

    expect(costs.summary()).toEqual({
      inputTokens: 15,
      outputTokens: 5,
      cachedInputTokens: 4,
      cacheWriteTokens: 1,
      amountsByCurrency: { USD: 0.01, EUR: 0.02 },
    });
    expect(seen).toEqual([0, 10, 15]);
    subscription.dispose();
    costs.record({
      providerId: "borg.third",
      modelId: "third",
      inputTokens: 1,
      outputTokens: 1,
      correlationId: "three",
    });
    expect(seen).toEqual([0, 10, 15]);
  });

  it("isolates subscriber failures and still delivers later summaries", () => {
    const costs = new CostLedger();
    const seen: number[] = [];
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    costs.subscribe(() => {
      throw new Error("sync fail");
    });
    costs.subscribe(async () => {
      throw new Error("async fail");
    });
    const healthy = costs.subscribe((summary) => {
      seen.push(summary.inputTokens);
    });
    expect(seen).toEqual([0]);
    costs.record({
      providerId: "borg.first",
      modelId: "first",
      inputTokens: 4,
      outputTokens: 1,
      correlationId: "one",
    });
    expect(seen).toEqual([0, 4]);
    expect(consoleError).toHaveBeenCalled();
    healthy.dispose();
    consoleError.mockRestore();
  });
});

describe("ModelGateway fallback preferences and usage", () => {
  it("uses desktop-supplied fallback instead of insertion order", async () => {
    const { executions, models } = createSecurityRuntime({
      fallbackPreferences: ["borg.mock-llm:mock:scripted"],
    });
    const execution = await bindModelExecution(
      executions,
      "borg.loop-test",
      "fallback-preference",
    );
    registerModelProvider(models, "borg.anthropic", {
      id: "borg.anthropic",
      models: ["claude-sonnet-5"],
      egress: TEST_PROVIDER_EGRESS,
      async complete(_request, permit) {
        await permit.commit();
        return {
          content: "anthropic",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    });
    registerModelProvider(models, "borg.mock-llm", {
      id: "borg.mock-llm",
      models: ["mock:scripted"],
      egress: TEST_PROVIDER_EGRESS,
      async complete(_request, permit) {
        await permit.commit();
        return {
          content: "mock",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    });

    const completion = await models.complete(
      {
        ownerPluginId: "borg.loop-test",
        feature: "loop-test",
        runId: "unqualified",
      },
      {
        executionId: execution.id,
        operationKey: modelOperationKeySchema.parse(
          "loop-manager/fallback-preference/model/0",
        ),
        messages: [{ role: "user", content: "hello" }],
        tools: [],
      },
      new AbortController().signal,
    );
    expect(completion).toMatchObject({
      providerId: "borg.mock-llm",
      modelId: "mock:scripted",
      content: "mock",
    });
  });

  it("records buffered partial usage only when completion throws", async () => {
    const { costs, executions, models } = createSecurityRuntime();
    const execution = await bindModelExecution(
      executions,
      "borg.loop-test",
      "failed-partial-usage",
    );
    registerModelProvider(models, "borg.partial", {
      id: "borg.partial",
      models: ["partial:model"],
      egress: TEST_PROVIDER_EGRESS,
      async complete(_request, permit, _signal, _onRawToken, onUsage) {
        await permit.commit();
        await onUsage?.({
          inputTokens: 4,
          outputTokens: 1,
          cachedInputTokens: 1,
          amount: 0.002,
          currency: "USD",
        });
        throw new Error("stream failed");
      },
    });

    await expect(
      models.complete(
        {
          ownerPluginId: "borg.loop-test",
          feature: "loop-test",
          runId: "run-partial",
        },
        {
          executionId: execution.id,
          operationKey: modelOperationKeySchema.parse(
            "loop-manager/failed-partial-usage/model/0",
          ),
          providerId: "borg.partial",
          modelId: "partial:model",
          messages: [{ role: "user", content: "hello" }],
          tools: [],
        },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({
      name: "ModelProviderFailedError",
      providerId: "borg.partial",
      reason: "failed",
    });
    expect(costs.list("run-partial")).toEqual([
      expect.objectContaining({
        inputTokens: 4,
        outputTokens: 1,
        cachedInputTokens: 1,
        amount: 0.002,
        currency: "USD",
      }),
    ]);
  });

  it("keeps the successful result authoritative over partial usage", async () => {
    const { costs, executions, models } = createSecurityRuntime();
    const execution = await bindModelExecution(
      executions,
      "borg.loop-test",
      "successful-partial-usage",
    );
    registerModelProvider(models, "borg.partial", {
      id: "borg.partial",
      models: ["partial:model"],
      egress: TEST_PROVIDER_EGRESS,
      async complete(_request, permit, _signal, _onRawToken, onUsage) {
        await permit.commit();
        await onUsage?.({
          inputTokens: 99,
          outputTokens: 99,
        });
        return {
          content: "done",
          usage: { inputTokens: 3, outputTokens: 2 },
        };
      },
    });

    await models.complete(
      {
        ownerPluginId: "borg.loop-test",
        feature: "loop-test",
        runId: "run-success",
      },
      {
        executionId: execution.id,
        operationKey: modelOperationKeySchema.parse(
          "loop-manager/successful-partial-usage/model/0",
        ),
        providerId: "borg.partial",
        modelId: "partial:model",
        messages: [{ role: "user", content: "hello" }],
        tools: [],
      },
      new AbortController().signal,
    );
    expect(costs.list("run-success")).toEqual([
      expect.objectContaining({
        inputTokens: 3,
        outputTokens: 2,
      }),
    ]);
  });
});
