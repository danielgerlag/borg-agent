import {
  azureConnect,
  azureDisconnect,
  azureGetStatus,
} from "@borg/contracts";
import {
  createTestHarness,
  type Disposable,
  type LlmProviderContribution,
  type PluginBus,
  type PluginContext,
} from "@borg/plugin-sdk";
import { parseAzureConfig } from "../src/config";
import azurePlugin from "../src/main";

type CommandHandler = (
  input: unknown,
  signal: AbortSignal,
) => unknown | Promise<unknown>;

export function createAzureHarness(options?: {
  readonly fetchImpl?: typeof fetch;
  readonly hasKey?: boolean;
  readonly endpoint?: string;
  readonly authMode?: "api-key" | "azure-default";
  readonly models?: readonly string[];
}) {
  const handlers = new Map<string, CommandHandler>();
  const secrets = new Map<string, string>();
  if (options?.hasKey) {
    secrets.set("apiKey", "azure-test-key");
  }
  let config = parseAzureConfig({
    ...(options?.endpoint === undefined ? {} : { endpoint: options.endpoint }),
    ...(options?.authMode === undefined ? {} : { authMode: options.authMode }),
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
    pluginId: "borg.azure",
    signal: new AbortController().signal,
    bus,
    secrets: {
      get: async (key: string) => secrets.get(key),
      set: async (key: string, value: string) => {
        secrets.set(key, value);
      },
      delete: async (key: string) => {
        secrets.delete(key);
      },
      has: async (key: string) => secrets.has(key),
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
        config = parseAzureConfig({ ...config, ...patch });
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
    dataDir: "/tmp/borg-azure-test",
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
    secrets,
    providers,
    getConfig: () => config,
    invokeStatus: () =>
      bus.invoke(azureGetStatus as never, {} as never) as Promise<{
        hasKey: boolean;
        connected: boolean;
        authMode: "api-key" | "azure-default";
      }>,
    invokeConnect: () => bus.invoke(azureConnect as never, {} as never),
    invokeDisconnect: () => bus.invoke(azureDisconnect as never, {} as never),
    activate: () => createTestHarness(azurePlugin, context),
    restoreFetch: () => {
      globalThis.fetch = originalFetch;
    },
  };
}
