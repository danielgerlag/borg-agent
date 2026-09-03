import {
  defineCommand,
  defineEvent,
  feedbackAsk,
  feedbackResolved,
} from "@borg/contracts";
import {
  definePlugin,
  defineTool,
  type BorgPluginManifest,
  type ConfigStoreProvider,
  type PluginContext,
  z,
} from "@borg/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  CommandEventBus,
  CommandInvocationError,
  CostLedger,
  InteractionService,
  LoopManager,
  ModelRouter,
  PluginManager,
  PersistenceRegistry,
  satisfiesBorgEngine,
  ToolService,
  type PluginSource,
} from "../src";

const ping = defineCommand({
  id: "test.ping",
  input: z.object({ value: z.string() }),
  output: z.object({ echoed: z.string() }),
});

function createSource(id: string, engine = "^0.1.0"): PluginSource {
  const manifest = {
    id,
    version: "0.1.0",
    engines: { borg: engine },
    main: `${id}/main`,
    permissions: [],
    contributes: {
      commands: [ping.id],
    },
  } as const satisfies BorgPluginManifest;

  return {
    manifest,
    loadMain: async () =>
      definePlugin({
        id,
        version: manifest.version,
        engines: manifest.engines,
        permissions: manifest.permissions,
        contributes: manifest.contributes,
        activate(context) {
          context.bus.handle(ping, ({ value }) => ({ echoed: value }));
        },
      }),
  };
}

describe("PluginManager", () => {
  it("loads an in-process plugin and disposes its command", async () => {
    const bus = new CommandEventBus();
    const manager = new PluginManager(bus, "0.1.0");

    await expect(manager.activate(createSource("test.echo"))).resolves.toMatchObject({
      status: "active",
    });
    await expect(bus.invoke(ping, { value: "hello" })).resolves.toEqual({
      echoed: "hello",
    });

    await manager.deactivate("test.echo");
    await expect(bus.invoke(ping, { value: "after" })).rejects.toMatchObject({
      code: "unavailable",
    });
  });

  it("issues scoped renderer capabilities that expire on deactivation", async () => {
    const manager = new PluginManager(new CommandEventBus(), "0.1.0");
    await manager.activate(createSource("test.capability"));
    const metadata = manager.getActivePluginMetadata()[0];

    expect(metadata?.uiCapability).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(manager.resolveUiCapability(metadata?.uiCapability ?? "")).toBe(
      "test.capability",
    );

    await manager.deactivate("test.capability");
    expect(manager.resolveUiCapability(metadata?.uiCapability ?? "")).toBeUndefined();
  });

  it("activates a default-satisfiable config store through the constrained bootstrap", async () => {
    const persistence = new PersistenceRegistry();
    const manager = new PluginManager(new CommandEventBus(), "0.1.0", {
      persistence,
    });
    const provider: ConfigStoreProvider = {
      readConfig: async () => undefined,
      writeConfig: async () => undefined,
      getStore: async () => undefined,
      listStore: async () => [],
      applyStoreTransaction: async () => undefined,
    };
    const manifest = {
      id: "test.config",
      version: "0.1.0",
      engines: { borg: "^0.1.0" },
      main: "test.config/main",
      permissions: [],
      contributes: { kinds: ["configStore"] },
    } as const satisfies BorgPluginManifest;

    await expect(
      manager.activateConfigStore({
        manifest,
        loadMain: async () =>
          definePlugin({
            ...manifest,
            configSchema: z.object({
              mode: z.string().default("safe"),
            }),
            activate(context) {
              context.persistence.registerConfigStore(provider);
            },
          }),
      }),
    ).resolves.toMatchObject({ status: "active" });
    expect(persistence.hasConfigStore()).toBe(true);
  });

  it("rejects bootstrap config defaults that are not JSON documents", async () => {
    const persistence = new PersistenceRegistry();
    const manager = new PluginManager(new CommandEventBus(), "0.1.0", {
      persistence,
    });
    const activate = vi.fn();
    const manifest = {
      id: "test.invalid-config",
      version: "0.1.0",
      engines: { borg: "^0.1.0" },
      main: "test.invalid-config/main",
      permissions: [],
      contributes: { kinds: ["configStore"] },
    } as const satisfies BorgPluginManifest;

    await expect(
      manager.activateConfigStore({
        manifest,
        loadMain: async () =>
          definePlugin({
            ...manifest,
            configSchema: z.string().default("not-an-object"),
            activate,
          }),
      }),
    ).rejects.toThrow(/requires unavailable configuration/);
    expect(activate).not.toHaveBeenCalled();
  });

  it("rejects an incompatible engine before importing plugin code", async () => {
    const bus = new CommandEventBus();
    const manager = new PluginManager(bus, "0.1.0");
    const loadMain = vi.fn(createSource("test.future", "^2.0.0").loadMain);

    await expect(
      manager.activate({
        ...createSource("test.future", "^2.0.0"),
        loadMain,
      }),
    ).resolves.toMatchObject({
      id: "test.future",
      status: "incompatible",
    });
    expect(loadMain).not.toHaveBeenCalled();
  });

  it("rejects a malformed engine range before importing plugin code", async () => {
    const bus = new CommandEventBus();
    const manager = new PluginManager(bus, "0.1.0");
    const loadMain = vi.fn(createSource("test.invalid-range", "not-semver || ").loadMain);

    await expect(
      manager.activate({
        ...createSource("test.invalid-range", "not-semver || "),
        loadMain,
      }),
    ).resolves.toMatchObject({
      status: "incompatible",
    });
    expect(loadMain).not.toHaveBeenCalled();
  });

  it("fails the second plugin that claims an existing command", async () => {
    const bus = new CommandEventBus();
    const manager = new PluginManager(bus, "0.1.0");
    await manager.activate(createSource("test.first"));

    await expect(manager.activate(createSource("test.second"))).rejects.toThrow(
      /already handled/,
    );
    expect(manager.getRecords()).toContainEqual(
      expect.objectContaining({ id: "test.second", status: "failed" }),
    );
    await expect(bus.invoke(ping, { value: "owner" })).resolves.toEqual({
      echoed: "owner",
    });
  });

  it("does not publish a command when activation later fails", async () => {
    const bus = new CommandEventBus();
    const manager = new PluginManager(bus, "0.1.0");
    const source = createSource("test.rollback");

    await expect(
      manager.activate({
        manifest: source.manifest,
        loadMain: async () =>
          definePlugin({
            id: "test.rollback",
            version: "0.1.0",
            engines: { borg: "^0.1.0" },
            permissions: [],
            contributes: { commands: [ping.id] },
            activate(context) {
              context.bus.handle(ping, ({ value }) => ({ echoed: value }));
              throw new Error("activation failed");
            },
          }),
      }),
    ).rejects.toThrow("activation failed");
    expect(bus.provides(ping)).toBe(false);
  });

  it("keeps staged commands private while activation is pending", async () => {
    const bus = new CommandEventBus();
    const manager = new PluginManager(bus, "0.1.0");
    const manifest = {
      id: "test.pending",
      version: "0.1.0",
      engines: { borg: "^0.1.0" },
      main: "test.pending/main",
      permissions: [],
      contributes: { commands: [ping.id] },
    } as const satisfies BorgPluginManifest;
    let releaseActivation: (() => void) | undefined;
    const enteredActivation = new Promise<void>((resolveEntered) => {
      releaseActivation = resolveEntered;
    });
    let continueActivation: (() => void) | undefined;
    const activationGate = new Promise<void>((resolveGate) => {
      continueActivation = resolveGate;
    });
    const activation = manager.activate({
      manifest,
      loadMain: async () =>
        definePlugin({
          id: manifest.id,
          version: manifest.version,
          engines: manifest.engines,
          permissions: manifest.permissions,
          contributes: manifest.contributes,
          async activate(context) {
            context.bus.handle(ping, ({ value }) => ({ echoed: value }));
            releaseActivation?.();
            await activationGate;
          },
        }),
    });

    await enteredActivation;
    expect(bus.provides(ping)).toBe(false);
    continueActivation?.();
    await activation;
    expect(bus.provides(ping)).toBe(true);
  });

  it("can reactivate a plugin after deactivation", async () => {
    const bus = new CommandEventBus();
    const manager = new PluginManager(bus, "0.1.0");
    const source = createSource("test.restart");

    await manager.activate(source);
    await manager.deactivate("test.restart");
    await expect(manager.activate(source)).resolves.toMatchObject({ status: "active" });
    await expect(bus.invoke(ping, { value: "again" })).resolves.toEqual({
      echoed: "again",
    });
  });

  it("bounds a plugin that never finishes deactivating", async () => {
    const bus = new CommandEventBus();
    const manager = new PluginManager(bus, "0.1.0", { shutdownTimeoutMs: 5 });
    const manifest = {
      id: "test.hanging-shutdown",
      version: "0.1.0",
      engines: { borg: "^0.1.0" },
      main: "test.hanging-shutdown/main",
      permissions: [],
      contributes: {},
    } as const satisfies BorgPluginManifest;

    await manager.activate({
      manifest,
      loadMain: async () =>
        definePlugin({
          id: manifest.id,
          version: manifest.version,
          engines: manifest.engines,
          permissions: manifest.permissions,
          contributes: manifest.contributes,
          activate: () => ({
            dispose: () => new Promise<void>(() => {}),
          }),
          deactivate: () => new Promise<void>(() => {}),
        }),
    });

    const startedAt = performance.now();
    await expect(manager.deactivate(manifest.id)).rejects.toThrow(/exceeded 5ms/);
    expect(performance.now() - startedAt).toBeLessThan(50);
    expect(manager.getRecords()).toContainEqual(
      expect.objectContaining({ id: manifest.id, status: "disabled" }),
    );
  });

  it("continues deactivating earlier plugins after a shutdown failure", async () => {
    const bus = new CommandEventBus();
    const manager = new PluginManager(bus, "0.1.0", { shutdownTimeoutMs: 5 });
    const healthyDeactivation = vi.fn();
    const createLifecycleSource = (
      id: string,
      deactivate: () => void | Promise<void>,
    ): PluginSource => {
      const manifest = {
        id,
        version: "0.1.0",
        engines: { borg: "^0.1.0" },
        main: `${id}/main`,
        permissions: [],
        contributes: {},
      } as const satisfies BorgPluginManifest;
      return {
        manifest,
        loadMain: async () =>
          definePlugin({
            id,
            version: manifest.version,
            engines: manifest.engines,
            permissions: manifest.permissions,
            contributes: manifest.contributes,
            activate() {},
            deactivate,
          }),
      };
    };

    await manager.activate(
      createLifecycleSource("test.healthy-shutdown", healthyDeactivation),
    );
    await manager.activate(
      createLifecycleSource("test.failed-shutdown", () => {
        throw new Error("shutdown failed");
      }),
    );

    await manager.deactivateAll();
    expect(healthyDeactivation).toHaveBeenCalledOnce();
    expect(manager.getActivePluginIds()).toEqual([]);
  });

  it("revokes outbound bus access from a deactivated plugin context", async () => {
    const bus = new CommandEventBus();
    const manager = new PluginManager(bus, "0.1.0");
    const source = createSource("test.revoked-context");
    let capturedContext: PluginContext | undefined;

    await manager.activate({
      manifest: source.manifest,
      loadMain: async () => {
        const loaded = await source.loadMain();
        const definition = "default" in loaded ? loaded.default : loaded;
        return {
          ...definition,
          activate(context: PluginContext) {
            capturedContext = context;
            return definition.activate(context);
          },
        };
      },
    });
    await manager.deactivate("test.revoked-context");

    expect(() => capturedContext?.bus.invoke(ping, { value: "late" })).toThrow(
      /no longer active/,
    );
  });

  it("revokes tool and model contributions before deactivation completes", async () => {
    const bus = new CommandEventBus();
    const interactions = new InteractionService();
    const tools = new ToolService(interactions);
    const models = new ModelRouter(new CostLedger());
    const manager = new PluginManager(bus, "0.1.0", {
      tools,
      models,
      shutdownTimeoutMs: 1_000,
    });
    let finishDeactivation: (() => void) | undefined;
    const manifest = {
      id: "test.runtime-provider",
      version: "0.1.0",
      engines: { borg: "^0.1.0" },
      main: "test.runtime-provider/main",
      permissions: ["tools.register", "models.register"],
      contributes: { kinds: ["tool", "llmProvider"] },
    } as const satisfies BorgPluginManifest;
    await manager.activate({
      manifest,
      loadMain: async () =>
        definePlugin({
          ...manifest,
          activate(context) {
            context.tools.register(
              defineTool({
                id: "test.runtime-tool",
                description: "Runtime tool",
                input: z.object({}).strict(),
                output: z.object({ done: z.boolean() }).strict(),
                approval: "auto",
                sideEffect: false,
                execute: () => ({ done: true }),
              }),
            );
            context.models.registerProvider({
              id: "test.runtime-provider",
              models: ["test:model"],
              complete: async () => ({
                content: "done",
                usage: { inputTokens: 1, outputTokens: 1 },
              }),
            });
          },
          deactivate: () =>
            new Promise<void>((resolve) => {
              finishDeactivation = resolve;
            }),
        }),
    });

    const deactivation = manager.deactivate(manifest.id);
    expect(tools.has("test.runtime-tool")).toBe(false);
    await expect(
      models.complete(
        {
          providerId: "test.runtime-provider",
          modelId: "test:model",
          runId: "run",
          correlationId: "run",
          messages: [{ role: "user", content: "test" }],
          tools: [],
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/unavailable/);
    finishDeactivation?.();
    await deactivation;
  });

  it("expires human-input authority when the feedback command returns", async () => {
    const bus = new CommandEventBus();
    const manager = new PluginManager(bus, "0.1.0");
    let deferredError: unknown;
    let runDeferred: (() => void) | undefined;
    const deferredFinished = new Promise<void>((resolve) => {
      runDeferred = () => {
        resolve();
      };
    });
    const manifest = {
      id: "borg.feedback",
      version: "0.1.0",
      engines: { borg: "^0.1.0" },
      main: "borg.feedback/main",
      permissions: ["interactions.request:human_input"],
      contributes: { commands: [feedbackAsk.id] },
    } as const satisfies BorgPluginManifest;

    await manager.activate({
      manifest,
      loadMain: async () =>
        definePlugin({
          ...manifest,
          activate(context) {
            context.bus.handle(feedbackAsk, () => {
              setTimeout(() => {
                try {
                  context.interactions.requestHumanInput({
                    prompt: "Late question",
                    form: "text",
                    source: {},
                  });
                } catch (error) {
                  deferredError = error;
                } finally {
                  runDeferred?.();
                }
              }, 0);
              return {
                interactionId: "00000000-0000-4000-8000-000000000000",
                answer: { kind: "text" as const, text: "done" },
              };
            });
          },
        }),
    });

    await bus.invoke(feedbackAsk, {
      prompt: "Question",
      form: "text",
      source: {},
    });
    await deferredFinished;
    expect(deferredError).toBeInstanceOf(Error);
    expect(String(deferredError)).toContain(
      "only while handling borg.feedback.ask",
    );
  });

  it("does not let another plugin impersonate the feedback interaction owner", async () => {
    const bus = new CommandEventBus();
    const interactions = new InteractionService();
    const manager = new PluginManager(bus, "0.1.0", { interactions });
    const manifest = {
      id: "test.fake-feedback",
      version: "0.1.0",
      engines: { borg: "^0.1.0" },
      main: "test.fake-feedback/main",
      permissions: ["interactions.request:human_input"],
      contributes: { commands: [feedbackAsk.id] },
    } as const satisfies BorgPluginManifest;
    await manager.activate({
      manifest,
      loadMain: async () =>
        definePlugin({
          ...manifest,
          activate(context) {
            context.bus.handle(feedbackAsk, () => {
              context.interactions.requestHumanInput({
                prompt: "Impersonated question",
                form: "text",
                source: {},
              });
              throw new Error("unreachable");
            });
          },
        }),
    });

    await expect(
      bus.invoke(feedbackAsk, {
        prompt: "Question",
        form: "text",
        source: {},
      }),
    ).rejects.toMatchObject({ code: "failed" });
    expect(interactions.listPending()).toHaveLength(0);
  });

  it("cancels human input with its command even when the handler omits a signal", async () => {
    const bus = new CommandEventBus();
    const interactions = new InteractionService();
    const manager = new PluginManager(bus, "0.1.0", { interactions });
    const shortFeedback = defineCommand({
      id: "borg.feedback.ask",
      input: z.object({}).strict(),
      output: z.object({ done: z.boolean() }).strict(),
      timeoutMs: 20,
    });
    const manifest = {
      id: "borg.feedback",
      version: "0.1.0",
      engines: { borg: "^0.1.0" },
      main: "borg.feedback/main",
      permissions: ["interactions.request:human_input"],
      contributes: { commands: [shortFeedback.id] },
    } as const satisfies BorgPluginManifest;
    await manager.activate({
      manifest,
      loadMain: async () =>
        definePlugin({
          ...manifest,
          activate(context) {
            context.bus.handle(shortFeedback, async () => {
              const wait = context.interactions.requestHumanInput({
                prompt: "Question",
                form: "text",
                source: {},
              });
              await wait.response;
              return { done: true };
            });
          },
        }),
    });

    const invocation = bus.invoke(shortFeedback, {});
    await vi.waitFor(() => expect(interactions.listPending()).toHaveLength(1));
    await expect(invocation).rejects.toMatchObject({ code: "timeout" });
    await vi.waitFor(() => expect(interactions.listPending()).toHaveLength(0));
  });

  it("allows an aborting feedback operation to publish its cancelled event", async () => {
    const bus = new CommandEventBus();
    const interactions = new InteractionService();
    const manager = new PluginManager(bus, "0.1.0", { interactions });
    const resolved = vi.fn();
    bus.on("test.observer", feedbackResolved, resolved);
    const manifest = {
      id: "borg.feedback",
      version: "0.1.0",
      engines: { borg: "^0.1.0" },
      main: "borg.feedback/main",
      permissions: ["interactions.request:human_input"],
      contributes: {
        commands: [feedbackAsk.id],
        events: [feedbackResolved.id],
      },
    } as const satisfies BorgPluginManifest;
    await manager.activate({
      manifest,
      loadMain: async () =>
        definePlugin({
          ...manifest,
          activate(context) {
            context.bus.handle(feedbackAsk, async (request) => {
              const wait = context.interactions.requestHumanInput({
                ...request,
                source: request.source ?? {},
              });
              try {
                const answer = await wait.response;
                return { interactionId: wait.interactionId, answer };
              } catch (error) {
                await context.bus.emit(feedbackResolved, {
                  interactionId: wait.interactionId,
                  source: {
                    pluginId: "borg.feedback",
                    feature: "feedback",
                    ...request.source,
                  },
                  status: "cancelled",
                });
                throw error;
              }
            });
          },
        }),
    });

    const invocation = bus.invoke(feedbackAsk, {
      prompt: "Question",
      form: "text",
      source: {},
    });
    const rejection = expect(invocation).rejects.toMatchObject({
      code: "failed",
    });
    await vi.waitFor(() => expect(interactions.listPending()).toHaveLength(1));
    await manager.deactivate(manifest.id);
    await rejection;
    expect(resolved).toHaveBeenCalledWith(
      expect.objectContaining({ status: "cancelled" }),
    );
  });

  it("cancels command-scoped tool approval when the command times out", async () => {
    const bus = new CommandEventBus();
    const interactions = new InteractionService();
    const tools = new ToolService(interactions);
    const execute = vi.fn(() => ({ done: true }));
    tools.register(
      "test.tool-provider",
      defineTool({
        id: "test.scoped-tool",
        description: "Wait for approval",
        input: z.object({}).strict(),
        output: z.object({ done: z.boolean() }).strict(),
        approval: "ask",
        sideEffect: true,
        execute,
      }),
    );
    const invokeTool = defineCommand({
      id: "test.invoke-scoped-tool",
      input: z.object({}).strict(),
      output: z.object({ done: z.boolean() }).strict(),
      timeoutMs: 20,
    });
    const manifest = {
      id: "test.tool-caller",
      version: "0.1.0",
      engines: { borg: "^0.1.0" },
      main: "test.tool-caller/main",
      permissions: ["tools.invoke"],
      contributes: { commands: [invokeTool.id] },
    } as const satisfies BorgPluginManifest;
    const manager = new PluginManager(bus, "0.1.0", { interactions, tools });

    await manager.activate({
      manifest,
      loadMain: async () =>
        definePlugin({
          ...manifest,
          activate(context) {
            context.bus.handle(invokeTool, async () => {
              await context.tools.invoke("test.scoped-tool", {});
              return { done: true };
            });
          },
        }),
    });

    const rejection = expect(bus.invoke(invokeTool, {})).rejects.toMatchObject({
      code: "timeout",
    });
    await vi.waitFor(() => expect(interactions.listPending()).toHaveLength(1));
    await rejection;
    await vi.waitFor(() => expect(interactions.listPending()).toHaveLength(0));
    expect(execute).not.toHaveBeenCalled();
  });

  it("routes permission-scoped auxiliary model completions without tools", async () => {
    const bus = new CommandEventBus();
    const costs = new CostLedger();
    const models = new ModelRouter(costs);
    models.registerProvider("test.provider", {
      id: "test.provider",
      models: ["test:model"],
      async complete(request) {
        expect(request.tools).toEqual([]);
        return {
          content: "auxiliary result",
          usage: { inputTokens: 2, outputTokens: 3 },
        };
      },
    });
    const complete = defineCommand({
      id: "test.complete",
      input: z.object({}).strict(),
      output: z.object({ content: z.string() }).strict(),
    });
    const manifest = {
      id: "test.model-consumer",
      version: "0.1.0",
      engines: { borg: "^0.1.0" },
      main: "test.model-consumer/main",
      permissions: ["models.complete"],
      contributes: { commands: [complete.id] },
    } as const satisfies BorgPluginManifest;
    const manager = new PluginManager(bus, "0.1.0", { models });
    await manager.activate({
      manifest,
      loadMain: async () =>
        definePlugin({
          ...manifest,
          activate(context) {
            context.bus.handle(complete, async () => {
              const completion = await context.models.complete({
                providerId: "test.provider",
                modelId: "test:model",
                messages: [{ role: "user", content: "summarize" }],
              });
              return { content: completion.result.content ?? "" };
            });
          },
        }),
    });

    await expect(bus.invoke(complete, {})).resolves.toEqual({
      content: "auxiliary result",
    });
    expect(costs.list()).toHaveLength(1);
    expect(costs.list()[0]?.runId).toBeUndefined();
  });

  it("does not start a loop after its owning command times out", async () => {
    const bus = new CommandEventBus();
    const interactions = new InteractionService();
    const costs = new CostLedger();
    const tools = new ToolService(interactions);
    const models = new ModelRouter(costs);
    const complete = vi.fn(async () => ({
      content: "should not run",
      usage: { inputTokens: 1, outputTokens: 1 },
    }));
    models.registerProvider("test.provider", {
      id: "test.provider",
      models: ["test:model"],
      complete,
    });
    const loops = new LoopManager(models, tools, costs);
    const startLater = defineCommand({
      id: "test.start-later",
      input: z.object({}).strict(),
      output: z.object({ done: z.boolean() }).strict(),
      timeoutMs: 20,
    });
    const manifest = {
      id: "test.loop-owner",
      version: "0.1.0",
      engines: { borg: "^0.1.0" },
      main: "test.loop-owner/main",
      permissions: ["loops.start"],
      contributes: { commands: [startLater.id] },
    } as const satisfies BorgPluginManifest;
    const manager = new PluginManager(bus, "0.1.0", { loops });
    await manager.activate({
      manifest,
      loadMain: async () =>
        definePlugin({
          ...manifest,
          activate(context) {
            context.bus.handle(startLater, async () => {
              await new Promise((resolve) => setTimeout(resolve, 30));
              await context.loops.start({ prompt: "too late" });
              return { done: true };
            });
          },
        }),
    });

    await expect(bus.invoke(startLater, {})).rejects.toMatchObject({
      code: "timeout",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(loops.list("test.loop-owner")).toHaveLength(0);
    expect(complete).not.toHaveBeenCalled();
  });
});

describe("satisfiesBorgEngine", () => {
  it("rejects leading zeroes and orders prerelease identifiers numerically", () => {
    expect(satisfiesBorgEngine("^0.1.0", "00.1.0")).toBe(false);
    expect(satisfiesBorgEngine(">1.0.0-beta.2", "1.0.0-beta.10")).toBe(true);
    expect(satisfiesBorgEngine("<1.0.0-beta.2", "1.0.0-beta.10")).toBe(false);
  });
});

describe("CommandEventBus", () => {
  it("returns the closed unavailable error when a command has no handler", async () => {
    const bus = new CommandEventBus();

    await expect(bus.invoke(ping, { value: "none" })).rejects.toEqual(
      expect.objectContaining<Partial<CommandInvocationError>>({
        code: "unavailable",
      }),
    );
  });

  it("isolates a failing event subscriber", async () => {
    const bus = new CommandEventBus();
    const changed = defineEvent({
      id: "test.changed",
      payload: z.object({ value: z.number() }),
    });
    const received: number[] = [];

    bus.on("test.bad-subscriber", changed, () => {
      throw new Error("subscriber failure");
    });
    bus.on("test.good-subscriber", changed, ({ value }) => {
      received.push(value);
    });

    await expect(
      bus.emit("test.emitter", new Set([changed.id]), changed, { value: 42 }),
    ).resolves.toBeUndefined();
    expect(received).toEqual([42]);
  });

  it("reports cooperative handler cancellation as a timeout", async () => {
    const bus = new CommandEventBus();
    const slow = defineCommand({
      id: "test.slow",
      timeoutMs: 5,
      input: z.object({}).strict(),
      output: z.object({ done: z.boolean() }),
    });
    bus.handle("test.slow-owner", new Set([slow.id]), slow, (_input, signal) => {
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });

    await expect(bus.invoke(slow, {})).rejects.toMatchObject({
      code: "timeout",
    });
  });
});
