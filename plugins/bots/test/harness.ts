import {
  personaSchema,
  type BusEnvelope,
  type CommandDefinition,
  type CommandInput,
  type CommandOutput,
  type EventDefinition,
  type EventPayload,
  type LoopEvent,
  type LoopRunSnapshot,
  type LoopStartInput,
  type ParentExecutionGrant,
} from "@borg/contracts";
import {
  CommandEventBus,
  ExecutionSecurityService,
  PersistenceRegistry,
  StoreFacade,
} from "../../../packages/kernel/src";
import type {
  ConfigStoreProvider,
  Disposable,
  JsonValue,
  PluginBus,
  PluginContext,
  PluginExecutions,
  PluginStore,
  StoreEntry,
  StoreTransactionOperation,
  ToolContribution,
} from "@borg/plugin-sdk";
import { vi } from "vitest";

function unavailable(capability: string): never {
  throw new Error(`${capability} is unavailable in the bot harness`);
}

class MemoryConfigStore implements ConfigStoreProvider {
  constructor(readonly values: Map<string, JsonValue>) {}

  async readConfig(_namespace: string): Promise<unknown | undefined> {
    return unavailable("Config reads");
  }

  async writeConfig(_namespace: string, _value: JsonValue): Promise<void> {
    return unavailable("Config writes");
  }

  async getStore(
    namespace: string,
    key: string,
  ): Promise<JsonValue | undefined> {
    return this.values.get(this.#storageKey(namespace, key));
  }

  async listStore(
    namespace: string,
    prefix: string,
  ): Promise<readonly StoreEntry[]> {
    const storagePrefix = this.#storageKey(namespace, prefix);
    return [...this.values.entries()]
      .filter(([key]) => key.startsWith(storagePrefix))
      .map(([key, value]) => ({
        key:
          namespace === "borg.bots"
            ? key
            : key.slice(this.#namespacePrefix(namespace).length),
        value,
      }));
  }

  async applyStoreTransaction(
    namespace: string,
    operations: readonly StoreTransactionOperation[],
  ): Promise<void> {
    const values = new Map(this.values);
    for (const operation of operations) {
      const key = this.#storageKey(namespace, operation.key);
      if (operation.type === "set") {
        values.set(key, operation.value);
      } else {
        values.delete(key);
      }
    }
    this.values.clear();
    for (const [key, value] of values) {
      this.values.set(key, value);
    }
  }

  #storageKey(namespace: string, key: string): string {
    return namespace === "borg.bots"
      ? key
      : `${this.#namespacePrefix(namespace)}${key}`;
  }

  #namespacePrefix(namespace: string): string {
    return `.harness/${encodeURIComponent(namespace)}/`;
  }
}

function createPluginStore(store: Map<string, JsonValue>): PluginStore {
  return {
    get: async (key) => store.get(key),
    set: async (key, value) => {
      store.set(key, value);
    },
    delete: async (key) => {
      store.delete(key);
    },
    list: async (prefix = "") =>
      [...store.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => ({ key, value })),
    transaction: async (operations) => {
      const next = new Map(store);
      for (const operation of operations) {
        if (operation.type === "set") {
          next.set(operation.key, operation.value);
        } else {
          next.delete(operation.key);
        }
      }
      store.clear();
      for (const [key, value] of next) {
        store.set(key, value);
      }
    },
  };
}

export async function createBotHarness(
  store = new Map<string, JsonValue>(),
) {
  const commandBus = new CommandEventBus();
  const emittedEvents: string[] = [];
  const runs = new Map<string, LoopRunSnapshot>();
  const workspaces = new Map<
    string,
    { readonly sessionId: string; readonly rootPath: string }
  >();
  const registeredTools = new Map<string, ToolContribution>();
  const runSubscribers = new Map<
    string,
    Set<(event: LoopEvent) => void | Promise<void>>
  >();
  const persistence = new PersistenceRegistry();
  persistence.registerConfigStore(
    "borg.bots.test-store",
    new MemoryConfigStore(store),
  );
  const executionSecurity = new ExecutionSecurityService(
    new StoreFacade(persistence),
  );
  await executionSecurity.initialize();

  const executions: PluginExecutions = {
    bind: (intent) =>
      executionSecurity.bind("borg.bots", intent, "detached"),
    grant: async (executionId) => {
      await executionSecurity.snapshot("borg.bots", executionId);
      return executionSecurity.createParentGrant({
        parentExecutionId: executionId,
        granteePluginId: "borg.bots",
      });
    },
  };
  const start = vi.fn(async (input: LoopStartInput) => {
    const now = new Date().toISOString();
    const snapshot: LoopRunSnapshot = {
      id: crypto.randomUUID(),
      status: "running",
      prompt: input.prompt,
      personaId: input.personaId,
      sessionId: input.sessionId,
      providerId: "borg.mock-llm",
      modelId: "mock:scripted",
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      costsByCurrency: {},
      createdAt: now,
      updatedAt: now,
    };
    runs.set(snapshot.id, snapshot);
    return snapshot;
  });
  const cancel = vi.fn((runId: string) => {
    const run = runs.get(runId);
    if (!run) {
      return false;
    }
    runs.set(runId, {
      ...run,
      status: "cancelled",
      updatedAt: new Date().toISOString(),
    });
    return true;
  });
  const general = personaSchema.parse({
    id: "system/general",
    name: "General",
    instructions: "Be useful.",
    preferredModels: ["borg.mock-llm:mock:scripted"],
  });
  const bus: PluginBus = {
    handle: <TCommand extends CommandDefinition>(
      command: TCommand,
      handler: (
        input: CommandInput<TCommand>,
        signal: AbortSignal,
        envelope: BusEnvelope,
      ) => CommandOutput<TCommand> | Promise<CommandOutput<TCommand>>,
    ) =>
      commandBus.handle(
        "borg.bots",
        new Set([command.id]),
        command,
        handler,
      ),
    invoke: async <TCommand extends CommandDefinition>(
      command: TCommand,
      input: CommandInput<TCommand>,
      options?: { readonly signal?: AbortSignal | undefined },
    ): Promise<CommandOutput<TCommand>> =>
      commandBus.invoke(command, input, {
        source: { kind: "plugin", id: "borg.bots" },
        ...(options?.signal ? { signal: options.signal } : {}),
      }),
    provides: (command) => commandBus.provides(command),
    emit: async <TEvent extends EventDefinition>(
      event: TEvent,
      payload: EventPayload<TEvent>,
    ) => {
      emittedEvents.push(event.id);
      await commandBus.emit(
        "borg.bots",
        new Set([event.id]),
        event,
        payload,
      );
    },
    on: <TEvent extends EventDefinition>(
      event: TEvent,
      handler: (
        payload: EventPayload<TEvent>,
        envelope: BusEnvelope,
      ) => void | Promise<void>,
    ) => commandBus.on("borg.bots", event, handler),
  };
  const context: PluginContext = {
    pluginId: "borg.bots",
    signal: new AbortController().signal,
    bus,
    store: createPluginStore(store),
    executions,
    personas: {
      get: (id) => (id === general.id ? general : undefined),
      getDefault: () => general,
      list: () => [general],
      setDefault: async () => unavailable("Persona mutation"),
      create: async () => unavailable("Persona creation"),
      update: async () => unavailable("Persona mutation"),
      archive: async () => unavailable("Persona archival"),
    },
    workspace: {
      allocate: (sessionId) => {
        const workspace = {
          sessionId,
          rootPath: `.borg-bots-test/${sessionId}`,
        };
        workspaces.set(sessionId, workspace);
        return workspace;
      },
      get: (sessionId) => workspaces.get(sessionId),
      listFiles: async () => [],
      release: async (sessionId) => {
        workspaces.delete(sessionId);
      },
    },
    loops: {
      start,
      get: (runId) => runs.get(runId),
      list: () => [...runs.values()],
      pause: (runId) => {
        const run = runs.get(runId);
        if (
          !run ||
          (run.status !== "running" && run.status !== "waiting")
        ) {
          return false;
        }
        runs.set(runId, {
          ...run,
          status: "paused",
          updatedAt: new Date().toISOString(),
        });
        return true;
      },
      resume: (runId) => {
        const run = runs.get(runId);
        if (!run || run.status !== "paused") {
          return false;
        }
        runs.set(runId, {
          ...run,
          status: "running",
          updatedAt: new Date().toISOString(),
        });
        return true;
      },
      cancel,
      subscribe: (runId, handler): Disposable => {
        const subscribers = runSubscribers.get(runId) ?? new Set();
        subscribers.add(handler);
        runSubscribers.set(runId, subscribers);
        return {
          dispose: () => {
            subscribers.delete(handler);
          },
        };
      },
    },
    tools: {
      register: (tool) => {
        if (registeredTools.has(tool.id)) {
          throw new Error(`Tool ${tool.id} is already registered`);
        }
        registeredTools.set(tool.id, tool);
        return {
          dispose: () => {
            if (registeredTools.get(tool.id) === tool) {
              registeredTools.delete(tool.id);
            }
          },
        };
      },
      registerProvider: () => unavailable("Tool provider registration"),
      registerExecutionScope: () => unavailable("Tool execution scopes"),
      invoke: async () => unavailable("Tool invocation"),
    },
    config: {
      get: async () => unavailable("Config reads"),
      update: async () => unavailable("Config writes"),
      watch: () => unavailable("Config watches"),
    },
    secrets: {
      get: async () => unavailable("Secret reads"),
      set: async () => unavailable("Secret writes"),
      delete: async () => unavailable("Secret deletion"),
      has: async () => unavailable("Secret reads"),
    },
    persistence: {
      registerConfigStore: () =>
        unavailable("Config store registration"),
      registerSecretStore: () =>
        unavailable("Secret store registration"),
    },
    models: {
      registerProvider: () => unavailable("Model provider registration"),
      complete: async () => unavailable("Model completion"),
    },
    interactions: {
      requestHumanInput: () => unavailable("Human input"),
    },
    cost: {
      summary: () => unavailable("Cost summaries"),
      subscribe: () => unavailable("Cost subscriptions"),
    },
    prompts: {
      registerSlot: () => unavailable("Prompt slot registration"),
    },
    memory: {
      registerProvider: () => unavailable("Memory provider registration"),
      write: async () => unavailable("Memory writes"),
      retrieve: async () => unavailable("Memory retrieve"),
    },
    sandbox: {
      run: async () => unavailable("Sandbox runs"),
    },
    scanners: {
      register: () => unavailable("Scanner registration"),
    },
    graphs: {
      registerStep: () => unavailable("Graph step registration"),
      registerTrigger: () => unavailable("Graph trigger registration"),
      listSteps: () => unavailable("Graph step listing"),
      listTriggers: () => unavailable("Graph trigger listing"),
    },
    scheduler: {
      schedule: () => unavailable("Scheduling"),
      scheduleCron: () => unavailable("Cron scheduling"),
      cancel: () => unavailable("Schedule cancellation"),
    },
    runtime: {
      spawn: () => unavailable("Runtime tasks"),
    },
    process: {
      spawn: async () => unavailable("Processes"),
    },
    http: {
      fetch: async () => unavailable("HTTP"),
    },
    channels: {
      register: () => unavailable("Channel registration"),
      send: async () => unavailable("Channel sends"),
    },
    webSockets: {
      connect: async () => unavailable("WebSockets"),
    },
    window: { show: () => unavailable("Window display") },
    dataDir: ".borg-bots-test",
    notify: () => unavailable("Notifications"),
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    host: { version: "0.1.0", platform: "test" },
  };

  const invoke = async <TCommand extends CommandDefinition>(
    command: TCommand,
    input: CommandInput<TCommand>,
    parentExecutionGrant?: ParentExecutionGrant,
  ): Promise<CommandOutput<TCommand>> =>
    commandBus.invoke(command, input, {
      ...(parentExecutionGrant ? { parentExecutionGrant } : {}),
    });

  const emitLoop = async (
    runId: string,
    event: LoopEvent,
  ): Promise<void> => {
    const run = runs.get(runId);
    if (run && event.type === "state") {
      runs.set(runId, {
        ...run,
        status: event.status,
        updatedAt: event.timestamp,
      });
    }
    await Promise.all(
      [...(runSubscribers.get(runId) ?? [])].map(async (handler) =>
        handler(event),
      ),
    );
  };

  return {
    context,
    invoke,
    start,
    cancel,
    emitLoop,
    store,
    executionSecurity,
    emittedEvents,
  };
}
