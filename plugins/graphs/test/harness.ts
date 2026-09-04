import type {
  GraphDefinition,
  LoopEvent,
  LoopRunSnapshot,
  LoopStartInput,
} from "@borg/contracts";
import type {
  Disposable,
  GraphStepContribution,
  GraphTriggerContribution,
  JsonValue,
  PluginBus,
  PluginContext,
  StoreEntry,
  StoreTransactionOperation,
  ToolContribution,
} from "@borg/plugin-sdk";
import { vi } from "vitest";
import { GRAPH_ENGINE_ID } from "../src/executor";

type CommandHandler = (
  input: unknown,
  signal: AbortSignal,
) => unknown | Promise<unknown>;

type EventHandler = (payload: unknown) => unknown | Promise<unknown>;

type GraphConfig = GraphDefinition["nodes"][number]["config"];

type ToolHandler = (
  input: unknown,
  options: {
    readonly runId?: string | undefined;
    readonly signal?: AbortSignal | undefined;
  },
) => JsonValue | Promise<JsonValue>;

export interface ScheduledTask {
  readonly id: string;
  readonly runAt: string;
  readonly callback: (signal: AbortSignal) => void | Promise<void>;
  readonly controller: AbortController;
}

export interface ToolScopeRecord {
  readonly runId: string;
  readonly sessionId: string;
  readonly allowedTools: readonly string[] | undefined;
  disposed: boolean;
}

export interface EmittedEvent {
  readonly id: string;
  readonly payload: unknown;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export function linearDefinition(options: {
  readonly id: string;
  readonly version?: string;
  readonly triggerKind?: string;
  readonly triggerConfig?: GraphConfig;
  readonly taskKind?: string;
  readonly taskConfig?: GraphConfig;
  readonly endConfig?: GraphConfig;
  readonly output?: Record<string, string>;
  readonly permissions?: readonly string[];
}): GraphDefinition {
  return {
    id: options.id,
    name: `Test graph ${options.id}`,
    version: options.version ?? "1.0.0",
    engineId: GRAPH_ENGINE_ID,
    mode: "background",
    inputSchema: {},
    variablesSchema: {},
    nodes: [
      {
        id: "start",
        type: "trigger",
        kind: options.triggerKind ?? "manual",
        config: options.triggerConfig ?? {},
        onError: { action: "fail" },
      },
      {
        id: "work",
        type: "task",
        kind: options.taskKind ?? "set_variable",
        config:
          options.taskConfig ?? { name: "result", value: "fixture-result" },
        onError: { action: "fail" },
      },
      {
        id: "end",
        type: "control",
        kind: "end",
        config: options.endConfig ?? {},
        onError: { action: "fail" },
      },
    ],
    edges: [
      { id: "start-work", source: "start", target: "work" },
      { id: "work-end", source: "work", target: "end" },
    ],
    ...(options.output ? { output: options.output } : {}),
    ...(options.permissions
      ? { permissions: [...options.permissions] }
      : {}),
  };
}

export function createGraphHarness(
  initialStoredValues?: ReadonlyMap<string, JsonValue>,
  graphContributions?: {
    readonly steps?: readonly GraphStepContribution[];
    readonly triggers?: readonly GraphTriggerContribution[];
  },
) {
  const handlers = new Map<string, CommandHandler>();
  const eventHandlers = new Map<string, Set<EventHandler>>();
  const emittedEvents: EmittedEvent[] = [];
  const commandInvocations: {
    readonly id: string;
    readonly input: unknown;
  }[] = [];
  const storedValues = new Map<string, JsonValue>(
    [...(initialStoredValues ?? [])].map(([key, value]) => [
      key,
      clone(value),
    ]),
  );
  const runtimeTasks = new Set<Promise<void>>();
  const scheduledTasks = new Map<string, ScheduledTask>();
  const registeredTools = new Map<string, ToolContribution>();
  const toolHandlers = new Map<string, ToolHandler>();
  const toolScopes: ToolScopeRecord[] = [];
  const activeToolScopes = new Map<string, ToolScopeRecord>();
  const workspaces = new Map<string, { sessionId: string; rootPath: string }>();
  const runs = new Map<string, LoopRunSnapshot>();
  const runSubscribers = new Map<
    string,
    Set<(event: LoopEvent) => void | Promise<void>>
  >();
  const startLoop = vi.fn(
    async (input: LoopStartInput): Promise<LoopRunSnapshot> => {
      const now = new Date().toISOString();
      const snapshot: LoopRunSnapshot = {
        id: crypto.randomUUID(),
        status: "running",
        prompt: input.prompt,
        personaId: input.personaId,
        sessionId: input.sessionId,
        providerId: input.providerId ?? "borg.mock-llm",
        modelId: input.modelId ?? "mock:scripted",
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
    },
  );

  const bus = {
    handle: (
      command: { readonly id: string },
      handler: CommandHandler,
    ): Disposable => {
      handlers.set(command.id, handler);
      return {
        dispose: () => {
          if (handlers.get(command.id) === handler) {
            handlers.delete(command.id);
          }
        },
      };
    },
    invoke: async (
      command: { readonly id: string },
      input: unknown,
      options?: { readonly signal?: AbortSignal | undefined },
    ) => {
      commandInvocations.push({ id: command.id, input: clone(input) });
      const handler = handlers.get(command.id);
      if (!handler) {
        throw new Error(`Command ${command.id} is unavailable`);
      }
      return handler(
        input,
        options?.signal ?? new AbortController().signal,
      );
    },
    provides: (command: { readonly id: string }) => handlers.has(command.id),
    emit: async (event: { readonly id: string }, payload: unknown) => {
      emittedEvents.push({ id: event.id, payload: clone(payload) });
      await Promise.all(
        [...(eventHandlers.get(event.id) ?? [])].map(async (handler) =>
          handler(payload),
        ),
      );
    },
    on: (
      event: { readonly id: string },
      handler: EventHandler,
    ): Disposable => {
      const subscribers = eventHandlers.get(event.id) ?? new Set<EventHandler>();
      subscribers.add(handler);
      eventHandlers.set(event.id, subscribers);
      return {
        dispose: () => {
          subscribers.delete(handler);
        },
      };
    },
  } as unknown as PluginBus;

  const registerExecutionScope = vi.fn(
    (options: {
      readonly runId: string;
      readonly sessionId: string;
      readonly allowedTools?: readonly string[];
    }): Disposable & { prepare(): Promise<void> } => {
      const { runId, sessionId, allowedTools } = options;
      const record: ToolScopeRecord = {
        runId,
        sessionId,
        allowedTools: allowedTools ? [...allowedTools] : undefined,
        disposed: false,
      };
      toolScopes.push(record);
      activeToolScopes.set(runId, record);
      return {
        prepare: async () => undefined,
        dispose: () => {
          record.disposed = true;
          if (activeToolScopes.get(runId) === record) {
            activeToolScopes.delete(runId);
          }
        },
      };
    },
  );

  const invokeTool = vi.fn(
    async (
      toolId: string,
      input: unknown,
      options: {
        readonly runId?: string | undefined;
        readonly signal?: AbortSignal | undefined;
      } = {},
    ): Promise<JsonValue> => {
      if (options.runId && !activeToolScopes.has(options.runId)) {
        throw new Error(`Execution scope ${options.runId} is unavailable`);
      }
      const handler = toolHandlers.get(toolId);
      if (!handler) {
        throw new Error(`Tool ${toolId} is unavailable`);
      }
      return handler(input, options);
    },
  );

  const context = {
    pluginId: "borg.graphs",
    signal: new AbortController().signal,
    bus,
    store: {
      get: async (key: string) => {
        const value = storedValues.get(key);
        return value === undefined ? undefined : clone(value);
      },
      set: async (key: string, value: JsonValue) => {
        storedValues.set(key, clone(value));
      },
      delete: async (key: string) => {
        storedValues.delete(key);
      },
      list: async (prefix = ""): Promise<readonly StoreEntry[]> =>
        [...storedValues.entries()]
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, value]) => ({ key, value: clone(value) })),
      transaction: async (
        operations: readonly StoreTransactionOperation[],
      ): Promise<void> => {
        const next = new Map(storedValues);
        for (const operation of operations) {
          if (operation.type === "set") {
            next.set(operation.key, clone(operation.value));
          } else {
            next.delete(operation.key);
          }
        }
        storedValues.clear();
        for (const [key, value] of next) {
          storedValues.set(key, value);
        }
      },
    },
    runtime: {
      spawn: (
        task: (signal: AbortSignal) => void | Promise<void>,
      ): Disposable => {
        const controller = new AbortController();
        const promise = Promise.resolve()
          .then(() => task(controller.signal))
          .then(() => undefined);
        runtimeTasks.add(promise);
        void promise.then(
          () => runtimeTasks.delete(promise),
          () => runtimeTasks.delete(promise),
        );
        return {
          dispose: () => {
            controller.abort(new Error("Test task disposed"));
          },
        };
      },
    },
    scheduler: {
      scheduleCron: () => ({
        dispose: () => undefined,
      }),
      schedule: (
        id: string,
        runAt: string,
        callback: (signal: AbortSignal) => void | Promise<void>,
      ): Disposable => {
        const entry: ScheduledTask = {
          id,
          runAt,
          callback,
          controller: new AbortController(),
        };
        scheduledTasks.set(id, entry);
        return {
          dispose: () => {
            if (scheduledTasks.get(id) === entry) {
              scheduledTasks.delete(id);
            }
            entry.controller.abort(new Error("Test schedule disposed"));
          },
        };
      },
      cancel: (id: string): boolean => {
        const entry = scheduledTasks.get(id);
        if (!entry) {
          return false;
        }
        scheduledTasks.delete(id);
        entry.controller.abort(new Error("Test schedule cancelled"));
        return true;
      },
    },
    tools: {
      register: (tool: ToolContribution): Disposable => {
        registeredTools.set(tool.id, tool);
        return {
          dispose: () => {
            if (registeredTools.get(tool.id) === tool) {
              registeredTools.delete(tool.id);
            }
          },
        };
      },
      registerExecutionScope,
      invoke: invokeTool,
    },
    workspace: {
      allocate: (sessionId: string) => {
        const workspace = {
          sessionId,
          rootPath: `/tmp/borg-graphs-test/${sessionId}`,
        };
        workspaces.set(sessionId, workspace);
        return workspace;
      },
      get: (sessionId: string) => workspaces.get(sessionId),
      listFiles: async () => [],
      release: async (sessionId: string) => {
        workspaces.delete(sessionId);
      },
    },
    loops: {
      start: startLoop,
      get: (runId: string) => runs.get(runId),
      list: () => [...runs.values()],
      pause: () => false,
      resume: () => false,
      cancel: (runId: string) => {
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
      },
      subscribe: (
        runId: string,
        handler: (event: LoopEvent) => void | Promise<void>,
      ): Disposable => {
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
    models: {
      registerProvider: () => ({ dispose: () => undefined }),
      complete: async () => ({
        providerId: "borg.mock-llm",
        modelId: "mock:scripted",
        result: {
          content: "model response",
          usage: { inputTokens: 1, outputTokens: 1 },
        },
      }),
    },
    personas: {
      get: (personaId: string) =>
        personaId === "system/general"
          ? {
              id: "system/general",
              name: "General",
              instructions: "Test persona",
              preferredModels: ["borg.mock-llm:mock:scripted"],
            }
          : undefined,
      getDefault: () => ({
        id: "system/general",
        name: "General",
        instructions: "Test persona",
        preferredModels: ["borg.mock-llm:mock:scripted"],
      }),
      list: () => [],
    },
    config: {},
    secrets: {},
    persistence: {},
    interactions: {},
    cost: {},
    prompts: {},
    graphs: {
      registerStep: () => ({ dispose: () => undefined }),
      registerTrigger: () => ({ dispose: () => undefined }),
      listSteps: () => graphContributions?.steps ?? [],
      listTriggers: () => graphContributions?.triggers ?? [],
    },
    window: { show: () => undefined },
    dataDir: "/tmp/borg-graphs-test",
    notify: () => undefined,
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    host: { version: "0.1.0", platform: "test" },
  } as unknown as PluginContext;

  const flush = async (): Promise<void> => {
    for (;;) {
      const batch = [...runtimeTasks];
      if (batch.length === 0) {
        await Promise.resolve();
        if (runtimeTasks.size === 0) {
          return;
        }
        continue;
      }
      await Promise.allSettled(batch);
    }
  };

  const runScheduled = async (id: string): Promise<void> => {
    const entry = scheduledTasks.get(id);
    if (!entry) {
      throw new Error(`Schedule ${id} is unavailable`);
    }
    scheduledTasks.delete(id);
    await entry.callback(entry.controller.signal);
    await flush();
  };

  const finishLoop = async (runId: string, output: string): Promise<void> => {
    const run = runs.get(runId);
    if (!run) {
      throw new Error(`Loop ${runId} is unavailable`);
    }
    runs.set(runId, {
      ...run,
      status: "completed",
      output,
      updatedAt: new Date().toISOString(),
    });
    const event: LoopEvent = {
      type: "state",
      runId,
      status: "completed",
      timestamp: new Date().toISOString(),
    };
    await Promise.all(
      [...(runSubscribers.get(runId) ?? [])].map(async (handler) =>
        handler(event),
      ),
    );
  };

  return {
    context,
    storedValues,
    emittedEvents,
    commandInvocations,
    scheduledTasks,
    registeredTools,
    toolScopes,
    registerExecutionScope,
    invokeTool,
    startLoop,
    workspaces,
    flush,
    runScheduled,
    finishLoop,
    handleCommand: (id: string, handler: CommandHandler): Disposable =>
      bus.handle({ id } as never, handler as never),
    invokeCommand: <T>(
      command: { readonly id: string },
      input: unknown,
    ): Promise<T> => bus.invoke(command as never, input as never) as Promise<T>,
    emitEvent: (
      event: { readonly id: string },
      payload: unknown,
    ): Promise<void> => bus.emit(event as never, payload as never),
    registerToolHandler: (toolId: string, handler: ToolHandler): void => {
      toolHandlers.set(toolId, handler);
    },
  };
}
