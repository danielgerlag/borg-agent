import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  definePlugin,
  defineTool,
  type BorgPluginManifest,
  type ConfigStoreProvider,
  type JsonValue,
  type SecretStoreProvider,
  type StoreEntry,
  type StoreTransactionOperation,
  z,
} from "@borg-agent/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  A2AService,
  CommunicationService,
  InteractionService,
  LoopManager,
  NetworkService,
  OAuthService,
  ProcessSupervisor,
  SchedulerCore,
  TlsService,
  WebSocketService,
  createKernel,
  type Kernel,
  type PluginSource,
} from "../src";
import { PLUGIN_ENABLEMENT_NAMESPACE } from "../src/plugin-enablement";

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

class MemorySecretStore implements SecretStoreProvider {
  readonly kind = "development" as const;
  readonly values = new Map<string, string>();

  async get(namespace: string, key: string): Promise<string | undefined> {
    return this.values.get(`${namespace}:${key}`);
  }

  async set(namespace: string, key: string, value: string): Promise<void> {
    this.values.set(`${namespace}:${key}`, value);
  }

  async delete(namespace: string, key: string): Promise<void> {
    this.values.delete(`${namespace}:${key}`);
  }

  async has(namespace: string, key: string): Promise<boolean> {
    return this.values.has(`${namespace}:${key}`);
  }
}

function sourceFor(definition: {
  readonly id: string;
  readonly version: string;
  readonly engines: { readonly borg: string };
  readonly permissions: readonly string[];
  readonly contributes: BorgPluginManifest["contributes"];
  activate: NonNullable<
    Parameters<typeof definePlugin>[0]["activate"]
  >;
}): PluginSource {
  const manifest = {
    id: definition.id,
    version: definition.version,
    engines: definition.engines,
    main: `${definition.id}/main`,
    permissions: definition.permissions,
    contributes: definition.contributes,
  } as const satisfies BorgPluginManifest;
  return {
    manifest,
    loadMain: async () =>
      definePlugin({
        id: manifest.id,
        version: manifest.version,
        engines: manifest.engines,
        permissions: manifest.permissions,
        contributes: manifest.contributes,
        activate: definition.activate,
      }),
  };
}

function memoryConfigSource(): PluginSource {
  return sourceFor({
    id: "test.config",
    version: "0.1.0",
    engines: { borg: "^0.1.0" },
    permissions: [],
    contributes: { kinds: ["configStore"] },
    activate(context) {
      context.persistence.registerConfigStore(new MemoryConfigStore());
    },
  });
}

function memorySecretSource(): PluginSource {
  return sourceFor({
    id: "test.secrets",
    version: "0.1.0",
    engines: { borg: "^0.1.0" },
    permissions: [],
    contributes: { kinds: ["secretStore"] },
    activate(context) {
      context.persistence.registerSecretStore(new MemorySecretStore());
    },
  });
}

describe("createKernel", () => {
  let dataDirectory: string | undefined;
  let kernel: Kernel | undefined;

  afterEach(async () => {
    await kernel?.stop();
    kernel = undefined;
    vi.restoreAllMocks();
    if (dataDirectory !== undefined) {
      rmSync(dataDirectory, { recursive: true, force: true });
      dataDirectory = undefined;
    }
  });

  it("boots headless in plain Node, runs a tool call through the loop, and stops cleanly", async () => {
    dataDirectory = mkdtempSync(path.join(os.tmpdir(), "borg-kernel-"));
    const toolInputs: { readonly text: string }[] = [];
    const plugins: PluginSource[] = [
      sourceFor({
        id: "test.config",
        version: "0.1.0",
        engines: { borg: "^0.1.0" },
        permissions: [],
        contributes: { kinds: ["configStore"] },
        activate(context) {
          context.persistence.registerConfigStore(new MemoryConfigStore());
        },
      }),
      sourceFor({
        id: "test.secrets",
        version: "0.1.0",
        engines: { borg: "^0.1.0" },
        permissions: [],
        contributes: { kinds: ["secretStore"] },
        activate(context) {
          context.persistence.registerSecretStore(new MemorySecretStore());
        },
      }),
      // A scripted stand-in registered under the mock-llm id, so the kernel's
      // default fallback preference (borg.mock-llm:mock:scripted) selects it.
      sourceFor({
        id: "borg.mock-llm",
        version: "0.1.0",
        engines: { borg: "^0.1.0" },
        permissions: ["models.register"],
        contributes: { kinds: ["llmProvider"] },
        activate(context) {
          context.models.registerProvider({
            id: "borg.mock-llm",
            models: ["mock:scripted"],
            egress: {
              kind: "remote",
              capacity: "internal",
              destination: "https://models.test.invalid/v1/generate",
            },
            async complete(request, permit) {
              await permit.commit();
              const toolMessage = request.messages.find(
                (message) => message.role === "tool",
              );
              if (toolMessage) {
                return {
                  content: `continued with ${toolMessage.content}`,
                  usage: { inputTokens: 2, outputTokens: 2 },
                };
              }
              return {
                toolCalls: [
                  {
                    id: "call-1",
                    name: "test.echo",
                    input: { text: "kernel" },
                  },
                ],
                usage: { inputTokens: 1, outputTokens: 1 },
              };
            },
          });
        },
      }),
      sourceFor({
        id: "test.tools",
        version: "0.1.0",
        engines: { borg: "^0.1.0" },
        permissions: ["tools.register"],
        contributes: { kinds: ["tool"] },
        activate(context) {
          context.tools.register(
            defineTool({
              id: "test.echo",
              description: "Echo one string",
              input: z.object({ text: z.string() }).strict(),
              output: z.object({ echoed: z.string() }).strict(),
              approval: "auto",
              sideEffect: false,
              execute: (input) => {
                toolInputs.push({ text: input.text });
                return { echoed: input.text };
              },
            }),
          );
        },
      }),
    ];

    kernel = createKernel({
      plugins,
      host: { dataDirectory },
      resolveSecretStore: async () => "test.secrets",
    });
    await kernel.start();

    expect(kernel.plugins.getActivePluginIds()).toEqual([
      "test.config",
      "test.secrets",
      "borg.mock-llm",
      "test.tools",
    ]);

    const run = await kernel.loops.start({
      prompt: "Echo kernel",
      security: {
        kind: "root",
        subject: { kind: "kernel-test", id: "tool-call" },
        classification: "internal",
        provenance: {
          kind: "plugin",
          id: "borg.kernel.create-kernel-test",
        },
        operationPrefix: "create-kernel/tool-call",
      },
    });
    await vi.waitFor(() => {
      const status = kernel?.loops.get(run.id)?.status;
      expect(
        status === "completed" || status === "failed" || status === "cancelled",
      ).toBe(true);
    });

    expect(kernel.loops.get(run.id)?.status).toBe("completed");
    expect(kernel.loops.get(run.id)?.output).toBe(
      'continued with {"echoed":"kernel"}',
    );
    expect(toolInputs).toEqual([{ text: "kernel" }]);

    await kernel.stop();
    expect(kernel.plugins.getActivePluginIds()).toEqual([]);
    await expect(kernel.stop()).resolves.toBeUndefined();
  });

  it("rejects a second start() while the kernel is started", async () => {
    dataDirectory = mkdtempSync(path.join(os.tmpdir(), "borg-kernel-"));
    kernel = createKernel({
      plugins: [memoryConfigSource(), memorySecretSource()],
      host: { dataDirectory },
      resolveSecretStore: async () => "test.secrets",
    });
    await kernel.start();

    await expect(kernel.start()).rejects.toThrow("Kernel is already started");
    expect(kernel.plugins.getActivePluginIds()).toEqual([
      "test.config",
      "test.secrets",
    ]);
  });

  it("rejects a concurrent start() while the kernel is starting", async () => {
    dataDirectory = mkdtempSync(path.join(os.tmpdir(), "borg-kernel-"));
    kernel = createKernel({
      plugins: [memoryConfigSource(), memorySecretSource()],
      host: { dataDirectory },
      resolveSecretStore: async () => "test.secrets",
    });
    const first = kernel.start();

    await expect(kernel.start()).rejects.toThrow("Kernel is already starting");
    await expect(first).resolves.toBeUndefined();
  });

  it("rejects start() after stop()", async () => {
    dataDirectory = mkdtempSync(path.join(os.tmpdir(), "borg-kernel-"));
    kernel = createKernel({
      plugins: [memoryConfigSource(), memorySecretSource()],
      host: { dataDirectory },
      resolveSecretStore: async () => "test.secrets",
    });
    await kernel.start();
    await kernel.stop();

    await expect(kernel.start()).rejects.toThrow(
      "Kernel has been stopped; create a new kernel to start again",
    );
    expect(kernel.plugins.getActivePluginIds()).toEqual([]);
  });

  it("stops activating plugins when stop() is called while starting", async () => {
    dataDirectory = mkdtempSync(path.join(os.tmpdir(), "borg-kernel-"));
    let markRequested!: () => void;
    const secretStoreRequested = new Promise<void>((resolve) => {
      markRequested = resolve;
    });
    let releaseSecretStore!: (id: string) => void;
    kernel = createKernel({
      plugins: [memoryConfigSource(), memorySecretSource()],
      host: { dataDirectory },
      resolveSecretStore: () =>
        new Promise<string>((resolve) => {
          releaseSecretStore = resolve;
          markRequested();
        }),
    });
    const starting = kernel.start();
    await secretStoreRequested;

    await kernel.stop();
    releaseSecretStore("test.secrets");

    await expect(starting).rejects.toThrow("Kernel was stopped while starting");
    expect(kernel.plugins.getActivePluginIds()).toEqual([]);
  });

  it("runs every teardown step when earlier steps fail and rejects stop() with an AggregateError", async () => {
    dataDirectory = mkdtempSync(path.join(os.tmpdir(), "borg-kernel-"));
    kernel = createKernel({
      plugins: [memoryConfigSource(), memorySecretSource()],
      host: { dataDirectory },
      resolveSecretStore: async () => "test.secrets",
    });
    const registerSchema = kernel.config.registerSchema.bind(kernel.config);
    const disposeEnablementSchema = vi.fn();
    vi.spyOn(kernel.config, "registerSchema").mockImplementation(
      (namespace, schema) => {
        const registration = registerSchema(namespace, schema);
        if (namespace !== PLUGIN_ENABLEMENT_NAMESPACE) {
          return registration;
        }
        return {
          dispose: async () => {
            disposeEnablementSchema();
            await registration.dispose();
          },
        };
      },
    );
    await kernel.start();

    const pluginFailure = new Error("plugin deactivation failed");
    const processFailure = new Error("process supervisor shutdown failed");
    const deactivateAll = vi
      .spyOn(kernel.plugins, "deactivateAll")
      .mockRejectedValueOnce(pluginFailure);
    const processShutdown = vi
      .spyOn(ProcessSupervisor.prototype, "shutdown")
      .mockRejectedValueOnce(processFailure);
    const steps = [
      deactivateAll,
      vi.spyOn(A2AService.prototype, "close"),
      vi.spyOn(SchedulerCore.prototype, "shutdown"),
      vi.spyOn(LoopManager.prototype, "shutdown"),
      vi.spyOn(InteractionService.prototype, "cancelAll"),
      processShutdown,
      vi.spyOn(CommunicationService.prototype, "shutdown"),
      vi.spyOn(TlsService.prototype, "shutdown"),
      vi.spyOn(OAuthService.prototype, "shutdown"),
      vi.spyOn(WebSocketService.prototype, "shutdown"),
      vi.spyOn(NetworkService.prototype, "shutdown"),
      disposeEnablementSchema,
    ];

    const failure = await kernel.stop().then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).message).toBe(
      "Kernel stop completed with 2 teardown failure(s)",
    );
    expect((failure as AggregateError).errors).toEqual([
      pluginFailure,
      processFailure,
    ]);
    for (const step of steps) {
      expect(step).toHaveBeenCalledTimes(1);
    }
    const callOrder = steps.map((step) => step.mock.invocationCallOrder[0] ?? -1);
    expect(callOrder).toEqual([...callOrder].sort((left, right) => left - right));

    await expect(kernel.stop()).resolves.toBeUndefined();
    for (const step of steps) {
      expect(step).toHaveBeenCalledTimes(1);
    }
  });

  it("stops cleanly after start() fails because no config store is available", async () => {
    dataDirectory = mkdtempSync(path.join(os.tmpdir(), "borg-kernel-"));
    kernel = createKernel({
      plugins: [memorySecretSource()],
      host: { dataDirectory },
      resolveSecretStore: async () => "test.secrets",
    });

    await expect(kernel.start()).rejects.toThrow(
      "Expected one compatible config store, found 0",
    );
    expect(kernel.plugins.getActivePluginIds()).toEqual([]);

    await expect(kernel.stop()).resolves.toBeUndefined();
    expect(kernel.plugins.getActivePluginIds()).toEqual([]);
    expect(kernel.loops.countLive()).toBe(0);
    expect(kernel.interactions.listPending()).toEqual([]);
    await expect(kernel.start()).rejects.toThrow(
      "Kernel has been stopped; create a new kernel to start again",
    );
  });
});
