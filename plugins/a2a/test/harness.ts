import { a2aGetStatus } from "@borg/contracts";
import {
  createTestHarness,
  type PluginBus,
  type PluginContext,
} from "@borg/plugin-sdk";
import a2aPlugin from "../src/main";

type CommandHandler = (
  input: unknown,
  signal: AbortSignal,
) => unknown | Promise<unknown>;

export function createA2AHarness() {
  const handlers = new Map<string, CommandHandler>();
  let config: Record<string, unknown> = {};
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
    pluginId: "borg.a2a",
    signal: new AbortController().signal,
    bus,
    config: {
      get: async () => config,
      update: async (patch: Readonly<Record<string, unknown>>) => {
        config = { ...config, ...patch };
        return config;
      },
      watch: () => ({ dispose: () => undefined }),
    },
    sandbox: {
      run: async () => {
        throw new Error("Sandbox runs are unused");
      },
    },
  } as unknown as PluginContext;

  return {
    context,
    invokeStatus: () => bus.invoke(a2aGetStatus as never, {} as never),
    activate: () => createTestHarness(a2aPlugin, context),
  };
}
