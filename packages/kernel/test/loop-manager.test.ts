import { defineTool, z } from "@borg/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  CostLedger,
  InteractionService,
  LoopManager,
  ModelRouter,
  ScannerRegistry,
  ToolService,
  TrustAuthorizer,
} from "../src";

function createRuntime() {
  const interactions = new InteractionService();
  const costs = new CostLedger();
  const tools = new ToolService(interactions);
  const models = new ModelRouter(costs);
  const loops = new LoopManager(models, tools, costs);
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
  models.registerProvider("borg.mock-llm", {
    id: "borg.mock-llm",
    models: ["mock:scripted"],
    async complete(request) {
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
  return { interactions, costs, loops, executeEcho };
}

describe("LoopManager", () => {
  it("runs a model-tool-model flow through approval and records usage", async () => {
    const { interactions, costs, loops } = createRuntime();
    const run = loops.start({
      prompt: "use echo",
      providerId: "borg.mock-llm",
      modelId: "mock:scripted",
      allowedTools: ["tools.echo"],
    });
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
    const run = loops.start({
      prompt: "use echo",
      allowedTools: ["tools.echo"],
    });
    await vi.waitFor(() => expect(interactions.listPending()).toHaveLength(1));
    interactions.respond(interactions.listPending()[0]!.id, {
      kind: "approval",
      decision: "deny",
    });
    await vi.waitFor(() => expect(loops.get(run.id)?.status).toBe("failed"));
    expect(loops.get(run.id)?.error).toMatch(/denied/);
    expect(executeEcho).not.toHaveBeenCalled();
  });

  it("drops denied model tokens from replayed run history", async () => {
    const interactions = new InteractionService();
    const costs = new CostLedger();
    const tools = new ToolService(interactions);
    const models = new ModelRouter(costs);
    const scanners = new ScannerRegistry();
    const authorizer = new TrustAuthorizer(interactions);
    const loops = new LoopManager(
      models,
      tools,
      costs,
      undefined,
      undefined,
      undefined,
      undefined,
      scanners,
      authorizer,
    );
    scanners.register("borg.security", {
      id: "borg.security.prompt-injection",
      stages: ["user_input", "model_output"],
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
    models.registerProvider("borg.mock-llm", {
      id: "borg.mock-llm",
      models: ["mock:scripted"],
      async complete(_request, _signal, onToken) {
        await onToken?.("blocked text");
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
    const run = loops.start({ prompt: "hello" });
    loops.subscribeRun(run.id, "kernel.loop", (event) => {
      if (event.type === "model_token") {
        live.push(event.token);
      }
    });

    await vi.waitFor(() => expect(loops.get(run.id)?.status).toBe("failed"));
    expect(live).toEqual(["blocked text"]);
    expect(loops.get(run.id)?.error).toMatch(/denied/);

    const replayed: string[] = [];
    loops.subscribeRun(run.id, "kernel.loop", (event) => {
      if (event.type === "model_token") {
        replayed.push(event.token);
      }
    });
    expect(replayed).toEqual([]);
  });

  it("cancels a pending approval when its run ends", async () => {
    const { interactions, loops, executeEcho } = createRuntime();
    const run = loops.start({
      prompt: "use echo",
      allowedTools: ["tools.echo"],
    });
    await vi.waitFor(() => expect(interactions.listPending()).toHaveLength(1));

    expect(loops.cancel(run.id)).toBe(true);
    await vi.waitFor(() => expect(interactions.listPending()).toHaveLength(0));
    expect(loops.get(run.id)?.status).toBe("cancelled");
    expect(executeEcho).not.toHaveBeenCalled();
  });

  it("drains terminal event subscribers when cancelling owned runs", async () => {
    const { interactions, loops } = createRuntime();
    const run = loops.start({
      prompt: "use echo",
      allowedTools: ["tools.echo"],
    });
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
    const interactions = new InteractionService();
    const costs = new CostLedger();
    const tools = new ToolService(interactions);
    const models = new ModelRouter(costs);
    const loops = new LoopManager(models, tools, costs);
    models.registerProvider("borg.mock-llm", {
      id: "borg.mock-llm",
      models: ["mock:scripted"],
      async complete() {
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

    const run = loops.start({ prompt: "ask" });
    await vi.waitFor(() => expect(loops.get(run.id)?.status).toBe("failed"));
    expect(loops.get(run.id)?.error).toContain("unavailable");
    expect(interactions.listPending()).toHaveLength(0);
  });

  it("waits for human feedback and continues the model turn", async () => {
    const interactions = new InteractionService();
    const costs = new CostLedger();
    const tools = new ToolService(interactions);
    const models = new ModelRouter(costs);
    const loops = new LoopManager(models, tools, costs);
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
    models.registerProvider("borg.mock-llm", {
      id: "borg.mock-llm",
      models: ["mock:scripted"],
      async complete(request) {
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

    const run = loops.start({
      prompt: "ask for feedback",
      allowedTools: ["feedback.ask"],
    });
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
    const interactions = new InteractionService();
    const costs = new CostLedger();
    const tools = new ToolService(interactions);
    const models = new ModelRouter(costs);
    const loops = new LoopManager(models, tools, costs);
    let finishModel: (() => void) | undefined;
    models.registerProvider("borg.mock-llm", {
      id: "borg.mock-llm",
      models: ["mock:scripted"],
      async complete() {
        await new Promise<void>((resolve) => {
          finishModel = resolve;
        });
        return {
          content: "paused safely",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    });

    const run = loops.start({ prompt: "pause me" });
    await vi.waitFor(() => expect(finishModel).toBeDefined());
    expect(loops.pause(run.id)).toBe(true);
    finishModel?.();
    await vi.waitFor(() => expect(loops.get(run.id)?.status).toBe("paused"));
    expect(loops.resume(run.id)).toBe(true);
    await vi.waitFor(() => expect(loops.get(run.id)?.status).toBe("completed"));
    expect(loops.get(run.id)?.output).toBe("paused safely");
  });

  it("keeps cancellation terminal when a provider returns late", async () => {
    const interactions = new InteractionService();
    const costs = new CostLedger();
    const tools = new ToolService(interactions);
    const models = new ModelRouter(costs);
    const loops = new LoopManager(models, tools, costs);
    let finishModel: (() => void) | undefined;
    models.registerProvider("borg.mock-llm", {
      id: "borg.mock-llm",
      models: ["mock:scripted"],
      async complete() {
        await new Promise<void>((resolve) => {
          finishModel = resolve;
        });
        return {
          content: "too late",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    });

    const run = loops.start({ prompt: "cancel me" });
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
    const interactions = new InteractionService();
    const costs = new CostLedger();
    const tools = new ToolService(interactions);
    const models = new ModelRouter(costs);
    const loops = new LoopManager(models, tools, costs);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    models.registerProvider("borg.mock-llm", {
      id: "borg.mock-llm",
      models: ["mock:scripted"],
      async complete() {
        await held;
        return {
          content: "done",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    });

    const chat = loops.start({ prompt: "chat turn" }, "borg.chat");
    const bot = loops.start({ prompt: "bot turn" }, "borg.bots");
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
    const interactions = new InteractionService();
    const costs = new CostLedger();
    const tools = new ToolService(interactions);
    const models = new ModelRouter(costs);
    const loops = new LoopManager(models, tools, costs, () => false);
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
    models.registerProvider("borg.mock-llm", {
      id: "borg.mock-llm",
      models: ["mock:scripted"],
      async complete(request) {
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

    const run = loops.start({ prompt: "try a tool" }, "borg.unprivileged");
    await vi.waitFor(() => expect(loops.get(run.id)?.status).toBe("failed"));
    expect(advertisedTools).toBe(0);
    expect(loops.get(run.id)?.error).toContain("cannot invoke tools");
  });

  it("routes an explicit model to the provider that exposes it", async () => {
    const interactions = new InteractionService();
    const costs = new CostLedger();
    const tools = new ToolService(interactions);
    const models = new ModelRouter(costs);
    const loops = new LoopManager(models, tools, costs);
    models.registerProvider("borg.first", {
      id: "borg.first",
      models: ["first:model"],
      async complete() {
        return {
          content: "wrong provider",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    });
    models.registerProvider("borg.second", {
      id: "borg.second",
      models: ["second:model"],
      async complete() {
        return {
          content: "right provider",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    });

    const run = loops.start({
      prompt: "route me",
      modelId: "second:model",
    });
    await vi.waitFor(() => expect(loops.get(run.id)?.status).toBe("completed"));
    expect(loops.get(run.id)).toMatchObject({
      providerId: "borg.second",
      output: "right provider",
    });
  });

  it("does not execute a tool removed while approval is pending", async () => {
    const interactions = new InteractionService();
    const tools = new ToolService(interactions);
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
    const interactions = new InteractionService();
    const tools = new ToolService(interactions);
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
    const interactions = new InteractionService();
    const tools = new ToolService(interactions);
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
    const interactions = new InteractionService();
    const tools = new ToolService(interactions);
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
    const costs = new CostLedger();
    const models = new ModelRouter(costs);
    let finish: (() => void) | undefined;
    const registration = models.registerProvider("borg.revocable", {
      id: "borg.revocable",
      models: ["revocable:model"],
      async complete() {
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
        providerId: "borg.revocable",
        modelId: "revocable:model",
        runId: "run-1",
        correlationId: "run-1",
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
    const costs = new CostLedger();
    const models = new ModelRouter(costs);
    const complete = vi.fn(async () => ({
      content: "too late",
      usage: { inputTokens: 1, outputTokens: 1 },
    }));
    models.registerProvider("borg.provider", {
      id: "borg.provider",
      models: ["provider:model"],
      complete,
    });
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));

    await expect(
      models.complete(
        {
          providerId: "borg.provider",
          modelId: "provider:model",
          runId: "run",
          correlationId: "run",
          messages: [{ role: "user", content: "test" }],
          tools: [],
        },
        controller.signal,
      ),
    ).rejects.toThrow(/cancelled/);
    expect(complete).not.toHaveBeenCalled();
  });

  it("prepares scoped providers before the first completion and advertises their tools", async () => {
    const interactions = new InteractionService();
    const costs = new CostLedger();
    const tools = new ToolService(interactions);
    const models = new ModelRouter(costs);
    const loops = new LoopManager(models, tools, costs);
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
    models.registerProvider("borg.mock-llm", {
      id: "borg.mock-llm",
      models: ["mock:scripted"],
      async complete(request) {
        advertised = request.tools.map(({ id }) => id);
        return {
          content: "done",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    });

    const run = loops.start({ prompt: "list tools" });
    await vi.waitFor(() => expect(loops.get(run.id)?.status).toBe("completed"));
    expect(advertised).toEqual(["mcp.demo.echo"]);
  });

  it("cancels the run when catalog preparation is aborted", async () => {
    const interactions = new InteractionService();
    const costs = new CostLedger();
    const tools = new ToolService(interactions);
    const models = new ModelRouter(costs);
    const loops = new LoopManager(models, tools, costs);
    const complete = vi.fn(async () => ({
      content: "should not run",
      usage: { inputTokens: 1, outputTokens: 1 },
    }));
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
    models.registerProvider("borg.mock-llm", {
      id: "borg.mock-llm",
      models: ["mock:scripted"],
      complete,
    });

    const run = loops.start({ prompt: "cancel during prepare" });
    await vi.waitFor(() => expect(preparing).toBe(true));
    expect(loops.cancel(run.id)).toBe(true);
    await vi.waitFor(() => expect(loops.get(run.id)?.status).toBe("cancelled"));
    expect(complete).not.toHaveBeenCalled();
  });

  it("degrades the catalog when a provider fails to prepare", async () => {
    const interactions = new InteractionService();
    const costs = new CostLedger();
    const tools = new ToolService(interactions);
    const models = new ModelRouter(costs);
    const loops = new LoopManager(models, tools, costs);
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
    models.registerProvider("borg.mock-llm", {
      id: "borg.mock-llm",
      models: ["mock:scripted"],
      async complete(request) {
        advertised = request.tools.map(({ id }) => id);
        return {
          content: "done",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    });

    const run = loops.start({ prompt: "survive a provider failure" });
    await vi.waitFor(() => expect(loops.get(run.id)?.status).toBe("completed"));
    expect(advertised).toEqual(["mcp.demo.echo"]);
    expect(loops.get(run.id)?.error).toBeUndefined();
    consoleError.mockRestore();
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

describe("ModelRouter fallback preferences", () => {
  it("uses desktop-supplied fallback instead of insertion order", async () => {
    const costs = new CostLedger();
    const models = new ModelRouter(costs, {
      fallbackPreferences: ["borg.mock-llm:mock:scripted"],
    });
    models.registerProvider("borg.anthropic", {
      id: "borg.anthropic",
      models: ["claude-sonnet-5"],
      async complete() {
        return {
          content: "anthropic",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    });
    models.registerProvider("borg.mock-llm", {
      id: "borg.mock-llm",
      models: ["mock:scripted"],
      async complete() {
        return {
          content: "mock",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    });

    const completion = await models.complete(
      {
        correlationId: "unqualified",
        messages: [{ role: "user", content: "hello" }],
        tools: [],
      },
      new AbortController().signal,
    );
    expect(completion).toMatchObject({
      providerId: "borg.mock-llm",
      modelId: "mock:scripted",
      result: { content: "mock" },
    });
  });

  it("records buffered partial usage only when completion throws", async () => {
    const costs = new CostLedger();
    const models = new ModelRouter(costs);
    models.registerProvider("borg.partial", {
      id: "borg.partial",
      models: ["partial:model"],
      async complete(_request, _signal, _onToken, onUsage) {
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
          providerId: "borg.partial",
          modelId: "partial:model",
          correlationId: "partial",
          runId: "run-partial",
          messages: [{ role: "user", content: "hello" }],
          tools: [],
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/stream failed/);
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
    const costs = new CostLedger();
    const models = new ModelRouter(costs);
    models.registerProvider("borg.partial", {
      id: "borg.partial",
      models: ["partial:model"],
      async complete(_request, _signal, _onToken, onUsage) {
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
        providerId: "borg.partial",
        modelId: "partial:model",
        correlationId: "success",
        runId: "run-success",
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
