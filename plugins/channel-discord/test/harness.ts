import type {
  ChannelAdapter,
  ChannelInboundDraft,
  Disposable,
  JsonValue,
  PluginBus,
  PluginContext,
  PluginHttp,
  PluginWebSocketConnection,
  PluginWebSockets,
  StoreEntry,
  StoreTransactionOperation,
} from "@borg/plugin-sdk";
import { discordChannelConfigSchema } from "../src/config";
import type { GatewayClock, GatewayTimer } from "../src/runtime";

export class ManualClock implements GatewayClock {
  #now = 0;
  #sequence = 0;
  readonly #timers = new Map<
    number,
    { readonly at: number; readonly callback: () => void }
  >();

  get pending(): number {
    return this.#timers.size;
  }

  get now(): number {
    return this.#now;
  }

  setTimer(callback: () => void, delayMs: number): GatewayTimer {
    const id = (this.#sequence += 1);
    this.#timers.set(id, { at: this.#now + Math.max(0, delayMs), callback });
    return {
      cancel: () => {
        this.#timers.delete(id);
      },
    };
  }

  advance(deltaMs: number): void {
    this.#now += deltaMs;
    for (const [id, timer] of [...this.#timers].sort(
      (left, right) => left[1].at - right[1].at,
    )) {
      if (timer.at <= this.#now && this.#timers.delete(id)) {
        timer.callback();
      }
    }
  }
}

export class FakeSocket implements PluginWebSocketConnection {
  readonly ready: Promise<void>;
  readonly sent: string[] = [];
  closeCalls: { readonly code: number | undefined; readonly reason: string | undefined }[] =
    [];
  disposed = false;
  #resolve: (() => void) | undefined;
  #reject: ((error: Error) => void) | undefined;
  readonly #messages = new Set<(data: string) => void | Promise<void>>();
  readonly #closes = new Set<(code: number, reason: string) => void | Promise<void>>();
  readonly #errors = new Set<(error: Error) => void | Promise<void>>();

  constructor() {
    this.ready = new Promise<void>((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
    void this.ready.catch(() => undefined);
  }

  get messageHandlerCount(): number {
    return this.#messages.size;
  }

  open(): void {
    this.#resolve?.();
    this.#resolve = undefined;
    this.#reject = undefined;
  }

  failHandshake(message = "handshake failed"): void {
    this.#reject?.(new Error(message));
    this.#resolve = undefined;
    this.#reject = undefined;
  }

  onMessage(handler: (data: string) => void | Promise<void>): Disposable {
    this.#messages.add(handler);
    return {
      dispose: () => {
        this.#messages.delete(handler);
      },
    };
  }

  onClose(
    handler: (code: number, reason: string) => void | Promise<void>,
  ): Disposable {
    this.#closes.add(handler);
    return {
      dispose: () => {
        this.#closes.delete(handler);
      },
    };
  }

  onError(handler: (error: Error) => void | Promise<void>): Disposable {
    this.#errors.add(handler);
    return {
      dispose: () => {
        this.#errors.delete(handler);
      },
    };
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls.push({ code, reason });
  }

  dispose(): void {
    this.disposed = true;
  }

  deliver(raw: string): void {
    for (const handler of [...this.#messages]) {
      void handler(raw);
    }
  }

  deliverClose(code: number, reason = ""): void {
    for (const handler of [...this.#closes]) {
      void handler(code, reason);
    }
  }

  deliverError(message: string): void {
    for (const handler of [...this.#errors]) {
      void handler(new Error(message));
    }
  }
}

export interface FakeConnectRecord {
  readonly url: string;
  readonly socket: FakeSocket;
  readonly maxMessageBytes: number | undefined;
  readonly signal: AbortSignal | undefined;
}

export class FakeWebSockets implements PluginWebSockets {
  readonly connections: FakeConnectRecord[] = [];
  autoOpen = true;
  failNextConnect: string | undefined;

  async connect(
    url: string,
    options?: {
      readonly signal?: AbortSignal | undefined;
      readonly maxMessageBytes?: number | undefined;
    },
  ): Promise<PluginWebSocketConnection> {
    if (this.failNextConnect !== undefined) {
      const message = this.failNextConnect;
      this.failNextConnect = undefined;
      throw new Error(message);
    }
    const socket = new FakeSocket();
    this.connections.push({
      url,
      socket,
      maxMessageBytes: options?.maxMessageBytes,
      signal: options?.signal,
    });
    if (this.autoOpen) {
      socket.open();
    }
    return socket;
  }

  get last(): FakeConnectRecord {
    const record = this.connections.at(-1);
    if (!record) {
      throw new Error("no websocket connection was opened");
    }
    return record;
  }
}

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

export interface LogRecord {
  readonly level: string;
  readonly message: string;
  readonly metadata: unknown;
}

export interface DiscordHarnessOptions {
  readonly config?: Readonly<Record<string, unknown>> | undefined;
  readonly secrets?: Readonly<Record<string, string>> | undefined;
  readonly fetch?:
    | ((request: RecordedRequest) => Response | Promise<Response>)
    | undefined;
}

export function createDiscordHarness(options: DiscordHarnessOptions = {}) {
  const handlers = new Map<
    string,
    (input: unknown, signal: AbortSignal) => unknown
  >();
  const secrets = new Map(Object.entries(options.secrets ?? {}));
  const store = new Map<string, JsonValue>();
  const logs: LogRecord[] = [];
  const registrations: RegisteredChannel[] = [];
  const spawned: AbortController[] = [];
  const watchers = new Set<
    (config: Readonly<Record<string, unknown>>) => void | Promise<void>
  >();
  const clock = new ManualClock();
  const webSockets = new FakeWebSockets();
  const { http, requests } = createFakeHttp(
    options.fetch ??
      (() => jsonResponse(500, { message: "unexpected discord request" })),
  );

  let configDocument = discordChannelConfigSchema.parse(options.config ?? {});

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

  const log = (level: string) => (message: string, metadata?: unknown) => {
    logs.push({ level, message, metadata });
  };

  const context = {
    pluginId: "borg.channel.discord",
    signal: new AbortController().signal,
    bus,
    config: {
      get: async () => configDocument as Readonly<Record<string, unknown>>,
      update: async (patch: Readonly<Record<string, unknown>>) => {
        configDocument = discordChannelConfigSchema.parse({
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
    http,
    webSockets,
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
            registration.controller.abort(new Error("unregistered"));
            const started = registration.started;
            registration.started = undefined;
            await started?.dispose();
          },
        };
      },
      send: async () => ({ status: "denied" as const, reasons: ["unused"] }),
    },
    runtime: {
      spawn: (task: (signal: AbortSignal) => void | Promise<void>) => {
        const controller = new AbortController();
        spawned.push(controller);
        void Promise.resolve().then(() => task(controller.signal));
        return {
          dispose: () => {
            controller.abort(new Error("cancelled"));
          },
        };
      },
    },
    window: { show: () => undefined },
    dataDir: "/tmp/borg-discord-test",
    notify: () => undefined,
    logger: {
      debug: log("debug"),
      info: log("info"),
      warn: log("warn"),
      error: log("error"),
    },
    host: { version: "0.1.0", platform: "test" },
  } as unknown as PluginContext;

  return {
    context,
    clock,
    webSockets,
    requests,
    secrets,
    store,
    logs,
    registrations,
    spawned,
    get activeRegistration(): RegisteredChannel {
      const active = [...registrations].reverse().find((entry) => !entry.disposed);
      if (!active) {
        throw new Error("no active channel registration");
      }
      return active;
    },
    invoke: async <T>(command: { readonly id: string }, input: unknown) =>
      bus.invoke(command as never, input as never) as Promise<T>,
    updateConfig: async (patch: Readonly<Record<string, unknown>>) => {
      await (
        context.config as unknown as {
          update(patch: Readonly<Record<string, unknown>>): Promise<unknown>;
        }
      ).update(patch);
    },
  };
}

export async function flush(times = 6): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await Promise.resolve();
  }
}

export function settle(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}
