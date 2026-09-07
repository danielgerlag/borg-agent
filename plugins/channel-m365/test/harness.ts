import type {
  ChannelAdapter,
  ChannelInboundDraft,
  Disposable,
  JsonValue,
  PluginBus,
  PluginContext,
  PluginHttp,
  PluginOAuth,
  PluginOAuthConnectRequest,
  OAuthSessionSnapshot,
  StoreEntry,
  StoreTransactionOperation,
  ToolContribution,
} from "@borg/plugin-sdk";
import { m365ChannelConfigSchema } from "../src/config";

export interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | undefined;
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
      };
      requests.push(record);
      return handler(record);
    },
  };
  return { http, requests };
}

export interface RegisteredChannel {
  readonly adapter: ChannelAdapter;
  readonly controller: AbortController;
  readonly drafts: ChannelInboundDraft[];
  started: Disposable | undefined;
  disposed: boolean;
}

export interface FakeOauthOptions {
  readonly connected?: boolean | undefined;
  readonly mailboxToken?: string | undefined;
}

export function createFakeOauth(options: FakeOauthOptions = {}): {
  readonly oauth: PluginOAuth;
  connected: boolean;
  connects: number;
  disconnects: number;
  readonly requests: PluginOAuthConnectRequest[];
} {
  const state = {
    connected: options.connected === true,
    connects: 0,
    disconnects: 0,
    requests: [] as PluginOAuthConnectRequest[],
    oauth: {} as PluginOAuth,
  };
  const snapshot = (): OAuthSessionSnapshot => ({
    connected: state.connected,
    ...(state.connected
      ? { expiresAt: new Date(Date.now() + 3_600_000).toISOString() }
      : {}),
  });
  state.oauth = {
    connect: async (request) => {
      state.connects += 1;
      state.requests.push(request);
      state.connected = true;
      return snapshot();
    },
    snapshot: async () => snapshot(),
    accessToken: async () => options.mailboxToken ?? "m365-access-token",
    disconnect: async () => {
      state.disconnects += 1;
      state.connected = false;
    },
  };
  return state;
}

export interface M365HarnessOptions {
  readonly config?: Readonly<Record<string, unknown>> | undefined;
  readonly oauth?: FakeOauthOptions | undefined;
  readonly fetch?:
    | ((request: RecordedRequest) => Response | Promise<Response>)
    | undefined;
}

export function createM365Harness(options: M365HarnessOptions = {}) {
  const handlers = new Map<
    string,
    (input: unknown, signal: AbortSignal) => unknown
  >();
  const store = new Map<string, JsonValue>();
  const registrations: RegisteredChannel[] = [];
  const tools: ToolContribution[] = [];
  const watchers = new Set<
    (config: Readonly<Record<string, unknown>>) => void | Promise<void>
  >();
  const { http, requests } = createFakeHttp(
    options.fetch ??
      (() => jsonResponse(500, { message: "unexpected graph request" })),
  );
  const oauthState = createFakeOauth(options.oauth);
  let configDocument = m365ChannelConfigSchema.parse(options.config ?? {});

  const bus = {
    handle: (
      command: { readonly id: string },
      handler: (input: unknown, signal: AbortSignal) => unknown,
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
    pluginId: "borg.channel.m365",
    signal: new AbortController().signal,
    bus,
    config: {
      get: async () => configDocument as Readonly<Record<string, unknown>>,
      update: async (patch: Readonly<Record<string, unknown>>) => {
        configDocument = m365ChannelConfigSchema.parse({
          ...configDocument,
          ...patch,
        });
        for (const watcher of [...watchers]) {
          await watcher(configDocument as Readonly<Record<string, unknown>>);
        }
        return configDocument as Readonly<Record<string, unknown>>;
      },
      watch: (
        handler: (config: Readonly<Record<string, unknown>>) => void | Promise<void>,
      ) => {
        watchers.add(handler);
        return {
          dispose: () => {
            watchers.delete(handler);
          },
        };
      },
    },
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
    secrets: {
      get: async () => {
        throw new Error("Microsoft 365 must not read plugin secrets");
      },
      set: async () => {
        throw new Error("Microsoft 365 must not write plugin secrets");
      },
      delete: async () => {
        throw new Error("Microsoft 365 must not write plugin secrets");
      },
      has: async () => false,
    },
    http,
    oauth: oauthState.oauth,
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
    channels: {
      register: (adapter: ChannelAdapter): Disposable => {
        const registration: RegisteredChannel = {
          adapter,
          controller: new AbortController(),
          drafts: [],
          started: undefined,
          disposed: false,
        };
        registrations.push(registration);
        void Promise.resolve()
          .then(() =>
            adapter.start?.({
              ingest: (draft) => {
                registration.drafts.push(draft);
              },
              signal: registration.controller.signal,
            }),
          )
          .then((started) => {
            if (started && typeof started.dispose === "function") {
              registration.started = started;
            }
          });
        return {
          dispose: async () => {
            registration.disposed = true;
            registration.controller.abort();
            await registration.started?.dispose();
            const index = registrations.lastIndexOf(registration);
            if (index >= 0) {
              registrations.splice(index, 1);
            }
          },
        };
      },
      send: async () => {
        throw new Error("Kernel channel send is unused");
      },
    },
    runtime: {
      spawn: () => ({ dispose: () => undefined }),
    },
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
    requests,
    registrations,
    tools,
    oauth: oauthState,
    invoke: async <T>(command: { readonly id: string }, input: unknown) =>
      bus.invoke(command as never, input as never) as Promise<T>,
    get activeRegistration(): RegisteredChannel {
      const current = registrations[registrations.length - 1];
      if (!current) {
        throw new Error("Microsoft 365 adapter is not registered");
      }
      return current;
    },
    updateConfig: (patch: Readonly<Record<string, unknown>>) =>
      context.config.update(patch),
  };
}

export function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
