import {
  coinbaseDisconnect,
  coinbaseGetStatus,
  coinbaseVerify,
} from "@borg/contracts";
import {
  createTestHarness,
  type Disposable,
  type PluginBus,
  type PluginContext,
  type PluginHttp,
  type ToolContribution,
} from "@borg/plugin-sdk";
import coinbasePlugin from "../src/main";
import { coinbaseConfigSchema } from "../src/config";

type CommandHandler = (
  input: unknown,
  signal: AbortSignal,
) => unknown | Promise<unknown>;

export interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | undefined;
  readonly redirect: RequestRedirect | undefined;
}

export function jsonResponse(
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export function createFakeHttp(
  handler: (request: RecordedRequest) => Response | Promise<Response>,
): { readonly http: PluginHttp; readonly requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const http: PluginHttp = {
    fetch: async (input, init) => {
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(
        (init?.headers as Record<string, string>) ?? {},
      )) {
        headers[name] = value;
      }
      const record: RecordedRequest = {
        url: String(input),
        method: init?.method ?? "GET",
        headers,
        body: typeof init?.body === "string" ? init.body : undefined,
        redirect: init?.redirect,
      };
      requests.push(record);
      return handler(record);
    },
  };
  return { http, requests };
}

export interface CoinbaseHarnessOptions {
  readonly config?: Readonly<Record<string, unknown>> | undefined;
  readonly secrets?: Readonly<Record<string, string>> | undefined;
  readonly fetch?:
    | ((request: RecordedRequest) => Response | Promise<Response>)
    | undefined;
}

export function createCoinbaseHarness(options: CoinbaseHarnessOptions = {}) {
  const handlers = new Map<string, CommandHandler>();
  const secrets = new Map(Object.entries(options.secrets ?? {}));
  const tools: ToolContribution[] = [];
  const watchers = new Set<
    (config: Readonly<Record<string, unknown>>) => void | Promise<void>
  >();
  const { http, requests } = createFakeHttp(
    options.fetch ??
      (() => jsonResponse(500, { message: "unexpected coinbase request" })),
  );
  let configDocument = coinbaseConfigSchema.parse(options.config ?? {});
  const bus = {
    handle: (
      command: { readonly id: string },
      handler: CommandHandler,
    ) => {
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
    pluginId: "borg.coinbase",
    signal: new AbortController().signal,
    bus,
    config: {
      get: async () => configDocument as Readonly<Record<string, unknown>>,
      update: async (patch: Readonly<Record<string, unknown>>) => {
        configDocument = coinbaseConfigSchema.parse({
          ...configDocument,
          ...patch,
        });
        for (const watcher of [...watchers]) {
          await watcher(configDocument as Readonly<Record<string, unknown>>);
        }
        return configDocument as Readonly<Record<string, unknown>>;
      },
      watch: (
        handler: (
          config: Readonly<Record<string, unknown>>,
        ) => void | Promise<void>,
      ) => {
        watchers.add(handler);
        return {
          dispose: () => {
            watchers.delete(handler);
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
    http,
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
    tools,
    requests,
    secrets,
    invoke: async <T>(command: { readonly id: string }, input: unknown) =>
      bus.invoke(command as never, input as never) as Promise<T>,
    invokeStatus: () => bus.invoke(coinbaseGetStatus as never, {} as never),
    invokeVerify: () => bus.invoke(coinbaseVerify as never, {} as never),
    invokeDisconnect: () =>
      bus.invoke(coinbaseDisconnect as never, {} as never),
    activate: () => createTestHarness(coinbasePlugin, context),
    updateConfig: async (patch: Readonly<Record<string, unknown>>) => {
      await (
        context.config as unknown as {
          update(patch: Readonly<Record<string, unknown>>): Promise<unknown>;
        }
      ).update(patch);
    },
  };
}
