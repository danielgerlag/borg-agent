import {
  ollamaConnect,
  ollamaDisconnect,
  ollamaGetStatus,
} from "@borg/contracts";
import {
  createTestHarness,
  type Disposable,
  type LlmProviderContribution,
  type PluginBus,
  type PluginContext,
} from "@borg/plugin-sdk";
import { parseOllamaConfig } from "../src/config";
import ollamaPlugin from "../src/main";

type CommandHandler = (
  input: unknown,
  signal: AbortSignal,
) => unknown | Promise<unknown>;

export function createOllamaHarness(options?: {
  readonly fetchImpl?: typeof fetch;
  readonly baseUrl?: string;
  readonly models?: readonly string[];
}) {
  const handlers = new Map<string, CommandHandler>();
  let config = parseOllamaConfig({
    ...(options?.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    models: options?.models ? [...options.models] : [],
  });
  const listeners = new Set<
    (document: Record<string, unknown>) => void | Promise<void>
  >();
  const providers: LlmProviderContribution[] = [];
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
    emit: async () => undefined,
    on: () => ({ dispose: () => undefined }),
  } as unknown as PluginBus;

  const originalFetch = globalThis.fetch;
  if (options?.fetchImpl) {
    globalThis.fetch = options.fetchImpl;
  }

  const context = {
    pluginId: "borg.ollama",
    signal: new AbortController().signal,
    bus,
    secrets: {
      get: async () => undefined,
      set: async () => undefined,
      delete: async () => undefined,
      has: async () => false,
    },
    models: {
      registerProvider: (provider: LlmProviderContribution): Disposable => {
        providers.push(provider);
        return {
          dispose: () => {
            const index = providers.indexOf(provider);
            if (index >= 0) {
              providers.splice(index, 1);
            }
          },
        };
      },
    },
    store: {},
    config: {
      get: async () => config,
      update: async (patch: Readonly<Record<string, unknown>>) => {
        config = parseOllamaConfig({ ...config, ...patch });
        for (const listener of [...listeners]) {
          await listener(config);
        }
        return config;
      },
      watch: (
        handler: (document: Record<string, unknown>) => void | Promise<void>,
      ) => {
        listeners.add(handler);
        return {
          dispose: () => {
            listeners.delete(handler);
          },
        };
      },
    },
    persistence: {},
    tools: {},
    loops: {},
    interactions: {},
    cost: {},
    personas: {},
    workspace: {},
    prompts: {},
    memory: {
      registerProvider: () => ({ dispose: () => undefined }),
      write: async () => {
        throw new Error("Memory writes are unused");
      },
      retrieve: async () => [],
    },
    sandbox: {
      run: async () => {
        throw new Error("Sandbox runs are unused");
      },
    },
    graphs: {},
    scheduler: {},
    runtime: {},
    window: { show: () => undefined },
    dataDir: "/tmp/borg-ollama-test",
    notify: () => undefined,
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    host: { version: "0.1.0", platform: "test" },
  } as unknown as PluginContext;

  return {
    context,
    providers,
    getConfig: () => config,
    invokeStatus: () =>
      bus.invoke(ollamaGetStatus as never, {} as never) as Promise<{
        connected: boolean;
        modelCount: number;
      }>,
    invokeConnect: () => bus.invoke(ollamaConnect as never, {} as never),
    invokeDisconnect: () => bus.invoke(ollamaDisconnect as never, {} as never),
    activate: () => createTestHarness(ollamaPlugin, context),
    restoreFetch: () => {
      globalThis.fetch = originalFetch;
    },
  };
}
