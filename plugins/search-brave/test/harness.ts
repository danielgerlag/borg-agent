import {
  braveConnect,
  braveDisconnect,
  braveGetStatus,
} from "@borg/contracts";
import {
  createTestHarness,
  type Disposable,
  type PluginBus,
  type PluginContext,
  type ToolContribution,
} from "@borg/plugin-sdk";
import bravePlugin from "../src/main";

type CommandHandler = (
  input: unknown,
  signal: AbortSignal,
) => unknown | Promise<unknown>;

export function createBraveHarness(options?: {
  readonly fetchImpl?: typeof fetch;
  readonly hasKey?: boolean;
  readonly enabled?: boolean;
}) {
  const handlers = new Map<string, CommandHandler>();
  const secrets = new Map<string, string>();
  if (options?.hasKey) {
    secrets.set("apiKey", "brave-test");
  }
  let config: Record<string, unknown> = {
    enabled: options?.enabled === true,
  };
  const listeners = new Set<(document: Record<string, unknown>) => void>();
  const tools: ToolContribution[] = [];
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

  const context = {
    pluginId: "borg.search.brave",
    signal: new AbortController().signal,
    bus,
    config: {
      get: async () => config,
      update: async (patch: Readonly<Record<string, unknown>>) => {
        config = { ...config, ...patch };
        for (const listener of [...listeners]) {
          await listener(config);
        }
        return config;
      },
      watch: (handler: (document: Record<string, unknown>) => void) => {
        listeners.add(handler);
        return {
          dispose: () => {
            listeners.delete(handler);
          },
        };
      },
    },
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
    tools: {
      register: (tool: ToolContribution): Disposable => {
        tools.push(tool);
        return {
          dispose: () => {
            const index = tools.indexOf(tool);
            if (index >= 0) {
              tools.splice(index, 1);
            }
          },
        };
      },
    },
    http: {
      fetch: options?.fetchImpl ?? (async () => new Response("{}", { status: 200 })),
    },
    sandbox: {
      run: async () => {
        throw new Error("Sandbox runs are unused");
      },
    },
  } as unknown as PluginContext;

  return {
    context,
    tools,
    invokeConnect: () => bus.invoke(braveConnect as never, {} as never),
    invokeDisconnect: () => bus.invoke(braveDisconnect as never, {} as never),
    invokeStatus: () => bus.invoke(braveGetStatus as never, {} as never),
    activate: () => createTestHarness(bravePlugin, context),
  };
}
