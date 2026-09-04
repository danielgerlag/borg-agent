import {
  anthropicConnect,
  anthropicDisconnect,
  anthropicGetStatus,
} from "@borg/contracts";
import {
  createTestHarness,
  type Disposable,
  type LlmProviderContribution,
  type PluginBus,
  type PluginContext,
} from "@borg/plugin-sdk";
import anthropicPlugin from "../src/main";

type CommandHandler = (
  input: unknown,
  signal: AbortSignal,
) => unknown | Promise<unknown>;

export function createAnthropicHarness(options?: {
  readonly fetchImpl?: typeof fetch;
  readonly hasKey?: boolean;
}) {
  const handlers = new Map<string, CommandHandler>();
  const secrets = new Map<string, string>();
  if (options?.hasKey) {
    secrets.set("apiKey", "sk-ant-test");
  }
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
    pluginId: "borg.anthropic",
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
    config: {},
    persistence: {},
    tools: {},
    loops: {},
    interactions: {},
    cost: {},
    personas: {},
    workspace: {},
    prompts: {},
    graphs: {},
    scheduler: {},
    runtime: {},
    window: { show: () => undefined },
    dataDir: "/tmp/borg-anthropic-test",
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
    invokeStatus: () =>
      bus.invoke(anthropicGetStatus as never, {} as never) as Promise<{
        hasKey: boolean;
        connected: boolean;
      }>,
    invokeConnect: () =>
      bus.invoke(anthropicConnect as never, {} as never),
    invokeDisconnect: () =>
      bus.invoke(anthropicDisconnect as never, {} as never),
    activate: () => createTestHarness(anthropicPlugin, context),
    restoreFetch: () => {
      globalThis.fetch = originalFetch;
    },
  };
}
