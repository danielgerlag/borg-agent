import {
  remoteDestroy,
  remoteGetRun,
  remoteListWorkers,
  remoteProvision,
  remoteRunSpecSchema,
  remoteSubmitRun,
  type RemoteRunSpec,
} from "@borg/contracts";
import {
  createTestHarness,
  type JsonValue,
  type PluginBus,
  type PluginContext,
  type PluginHttp,
  type PluginStore,
  type StoreEntry,
  type StoreTransactionOperation,
} from "@borg/plugin-sdk";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import remotePlugin from "../src/main";

type CommandHandler = (
  input: unknown,
  signal: AbortSignal,
) => unknown | Promise<unknown>;

export interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
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

export function createMemoryStore(): PluginStore {
  const store = new Map<string, JsonValue>();
  return {
    get: async (key) => store.get(key),
    set: async (key, value) => {
      store.set(key, value);
    },
    delete: async (key) => {
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
  };
}

export function createFakeHttp(
  handler: (request: RecordedRequest) => Response | Promise<Response>,
): { readonly http: PluginHttp; readonly requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const http: PluginHttp = {
    fetch: async (input, init) => {
      const record: RecordedRequest = {
        url: String(input),
        method: (init?.method ?? "GET").toUpperCase(),
        headers: new Headers(init?.headers),
        body: typeof init?.body === "string" ? init.body : undefined,
      };
      requests.push(record);
      return handler(record);
    },
  };
  return { http, requests };
}

export function sampleRunSpec(options?: {
  readonly allowedTools?: readonly string[];
  readonly runId?: string;
}): RemoteRunSpec {
  return remoteRunSpecSchema.parse({
    version: 1,
    runId: options?.runId ?? "00000000-0000-4000-8000-000000000001",
    prompt: "echo hello",
    unattended: true,
    persona: {
      id: "user/detached",
      name: "Detached",
      instructions: "Finish the task.",
      preferredModels: ["borg.runtime.scripted:scripted"],
      allowedTools: [...(options?.allowedTools ?? ["tools.echo"])],
      loopStrategy: "react",
    },
    provider: {
      kind: "scripted",
      replies: [{ content: "done" }],
    },
  });
}

export function createRemoteHarness(options?: {
  readonly fetchImpl?: typeof fetch;
  readonly dataDir?: string;
}) {
  const handlers = new Map<string, CommandHandler>();
  const secrets = new Map<string, string>();
  const store = createMemoryStore();
  const dataDir =
    options?.dataDir ?? mkdtempSync(path.join(tmpdir(), "borg-remote-"));
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
    pluginId: "borg.remote",
    signal: new AbortController().signal,
    bus,
    config: {
      get: async () => ({}),
      update: async (patch: Readonly<Record<string, unknown>>) => patch,
      watch: () => ({ dispose: () => undefined }),
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
    store,
    http: {
      fetch:
        options?.fetchImpl ??
        (async () => new Response("{}", { status: 200 })),
    },
    sandbox: {
      run: async () => {
        throw new Error("Sandbox runs are unused");
      },
    },
    dataDir,
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
    store,
    dataDir,
    invokeList: () => bus.invoke(remoteListWorkers as never, {} as never),
    invokeProvision: (input: unknown) =>
      bus.invoke(remoteProvision as never, input as never),
    invokeDestroy: (workerId: string) =>
      bus.invoke(remoteDestroy as never, { workerId } as never),
    invokeSubmit: (workerId: string, spec: RemoteRunSpec) =>
      bus.invoke(remoteSubmitRun as never, { workerId, spec } as never),
    invokeGetRun: (workerId: string, runId: string) =>
      bus.invoke(remoteGetRun as never, { workerId, runId } as never),
    activate: () => createTestHarness(remotePlugin, context),
  };
}
