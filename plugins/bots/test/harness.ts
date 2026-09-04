import {
  personaSchema,
  type LoopEvent,
  type LoopRunSnapshot,
  type LoopStartInput,
} from "@borg/contracts";
import type {
  Disposable,
  JsonValue,
  PluginBus,
  PluginContext,
  StoreEntry,
  StoreTransactionOperation,
} from "@borg/plugin-sdk";
import { vi } from "vitest";

type CommandHandler = (
  input: unknown,
  signal: AbortSignal,
) => unknown | Promise<unknown>;

export function createBotHarness(store = new Map<string, JsonValue>()) {
  const handlers = new Map<string, CommandHandler>();
  const eventHandlers = new Map<string, Set<(payload: unknown) => unknown>>();
  const emittedEvents: string[] = [];
  const runs = new Map<string, LoopRunSnapshot>();
  const runSubscribers = new Map<
    string,
    Set<(event: LoopEvent) => void | Promise<void>>
  >();
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
  const bus = {
    handle: (command: { readonly id: string }, handler: CommandHandler) => {
      handlers.set(command.id, handler);
      return {
        dispose: () => {
          handlers.delete(command.id);
        },
      };
    },
    invoke: async (command: { readonly id: string }, input: unknown) => {
      const handler = handlers.get(command.id);
      if (!handler) {
        throw new Error(`Missing handler ${command.id}`);
      }
      return handler(input, new AbortController().signal);
    },
    provides: (command: { readonly id: string }) => handlers.has(command.id),
    emit: async (event: { readonly id: string }, payload: unknown) => {
      emittedEvents.push(event.id);
      await Promise.allSettled(
        [...(eventHandlers.get(event.id) ?? [])].map(async (handler) =>
          handler(payload),
        ),
      );
    },
    on: (
      event: { readonly id: string },
      handler: (payload: unknown) => unknown,
    ) => {
      const subscribers = eventHandlers.get(event.id) ?? new Set();
      subscribers.add(handler);
      eventHandlers.set(event.id, subscribers);
      return {
        dispose: () => subscribers.delete(handler),
      };
    },
  } as unknown as PluginBus;
  const context = {
    pluginId: "borg.bots",
    signal: new AbortController().signal,
    bus,
    store: {
      get: async (key: string) => store.get(key),
      set: async (key: string, value: JsonValue) => {
        store.set(key, value);
      },
      delete: async (key: string) => {
        store.delete(key);
      },
      list: async (prefix = ""): Promise<readonly StoreEntry[]> =>
        [...store.entries()]
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, value]) => ({ key, value })),
      transaction: async (operations: readonly StoreTransactionOperation[]) => {
        for (const operation of operations) {
          if (operation.type === "set") {
            store.set(operation.key, operation.value);
          } else {
            store.delete(operation.key);
          }
        }
      },
    },
    personas: {
      get: (id: string) => (id === general.id ? general : undefined),
      getDefault: () => general,
      list: () => [general],
    },
    workspace: {
      allocate: (sessionId: string) => ({
        sessionId,
        rootPath: `/tmp/${sessionId}`,
      }),
      get: (sessionId: string) => ({
        sessionId,
        rootPath: `/tmp/${sessionId}`,
      }),
      listFiles: async () => [],
      release: async () => undefined,
    },
    loops: {
      start,
      get: (runId: string) => runs.get(runId),
      list: () => [...runs.values()],
      pause: () => false,
      resume: () => false,
      cancel,
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
    tools: {
      register: () => ({ dispose: () => undefined }),
    },
    config: {},
    secrets: {},
    persistence: {},
    models: {},
    interactions: {},
    cost: {},
    window: { show: () => undefined },
    dataDir: "/tmp/borg-bots-test",
    notify: () => undefined,
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    host: { version: "0.1.0", platform: "test" },
  } as unknown as PluginContext;

  const invoke = async <T>(command: { readonly id: string }, input: unknown) =>
    bus.invoke(command as never, input as never) as Promise<T>;

  const emitLoop = async (runId: string, event: LoopEvent): Promise<void> => {
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
    emittedEvents,
  };
}
