import { personaSchema, type Persona } from "@borg/contracts";
import type {
  Disposable,
  JsonValue,
  PluginBus,
  PluginContext,
  PreparedToolCatalog,
  ToolProviderContribution,
} from "@borg/plugin-sdk";
import { ProcessSupervisor } from "../../../packages/kernel/src/process-supervisor";
import { NetworkService } from "../../../packages/kernel/src/network-service";

type CommandHandler = (
  input: unknown,
  signal: AbortSignal,
) => unknown | Promise<unknown>;

export function createMcpHarness(options?: {
  readonly persona?: Persona;
  readonly secrets?: Readonly<Record<string, string>>;
  readonly fetchImpl?: typeof fetch;
}) {
  const handlers = new Map<string, CommandHandler>();
  const eventHandlers = new Map<string, Set<(payload: unknown) => unknown>>();
  const emitted: { id: string; payload: unknown }[] = [];
  const logs: { level: string; message: string; metadata?: unknown }[] = [];
  const providers: ToolProviderContribution[] = [];
  const supervisor = new ProcessSupervisor();
  const spawnedPids: number[] = [];
  const network = new NetworkService({
    fetch: options?.fetchImpl ?? globalThis.fetch.bind(globalThis),
  });
  const secrets = new Map(Object.entries(options?.secrets ?? {}));
  const persona =
    options?.persona ??
    personaSchema.parse({
      id: "system/general",
      name: "General",
      instructions: "Be useful.",
      preferredModels: ["borg.mock-llm:mock:scripted"],
    });
  const personas = new Map<string, Persona>([[persona.id, persona]]);
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
      emitted.push({ id: event.id, payload });
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
    pluginId: "borg.mcp",
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
    tools: {
      registerProvider: (provider: ToolProviderContribution): Disposable => {
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
    personas: {
      get: (id: string) => personas.get(id),
      getDefault: () => persona,
      list: () => [...personas.values()],
      update: async (id: string, patch: Record<string, unknown>) => {
        const current = personas.get(id);
        if (!current) {
          throw new Error("missing persona");
        }
        const next = personaSchema.parse({ ...current, ...patch });
        personas.set(id, next);
        return next;
      },
    },
    process: {
      spawn: async (
        command: string,
        args: readonly string[],
        spawnOptions?: {
          readonly cwd?: string;
          readonly env?: Readonly<Record<string, string>>;
          readonly signal?: AbortSignal;
        },
      ) => {
        const child = await supervisor.spawn(
          "borg.mcp",
          command,
          args,
          spawnOptions,
        );
        spawnedPids.push(child.pid);
        return child;
      },
    },
    http: {
      fetch: (input: string | URL | Request, init?: RequestInit) =>
        network.fetch("borg.mcp", input, init),
    },
    store: {},
    config: {},
    persistence: {},
    models: {},
    loops: {},
    interactions: {},
    cost: {},
    workspace: {},
    prompts: {},
    memory: {
      registerProvider: () => ({ dispose: () => undefined }),
      write: async () => {
        throw new Error("Memory writes are unused");
      },
      retrieve: async () => [],
    },
    graphs: {},
    scheduler: {},
    runtime: {},
    window: { show: () => undefined },
    dataDir: "/tmp/borg-mcp-test",
    notify: () => undefined,
    logger: {
      debug: (message: string, metadata?: unknown) => {
        logs.push({ level: "debug", message, metadata });
      },
      info: (message: string, metadata?: unknown) => {
        logs.push({ level: "info", message, metadata });
      },
      warn: (message: string, metadata?: unknown) => {
        logs.push({ level: "warn", message, metadata });
      },
      error: (message: string, metadata?: unknown) => {
        logs.push({ level: "error", message, metadata });
      },
    },
    host: { version: "0.1.0", platform: "test" },
  } as unknown as PluginContext;

  return {
    context,
    providers,
    emitted,
    logs,
    secrets,
    personas,
    supervisor,
    spawnedPids,
    invoke: async <T>(command: { readonly id: string }, input: unknown) =>
      bus.invoke(command as never, input as never) as Promise<T>,
    async prepare(): Promise<PreparedToolCatalog> {
      const provider = providers[0];
      if (!provider?.prepare) {
        throw new Error("MCP tool provider was not registered");
      }
      const current = personas.get(persona.id) ?? persona;
      return provider.prepare({
        runId: crypto.randomUUID(),
        ownerPluginId: "borg.chat",
        persona: current,
        personaId: current.id,
        sessionId: "11111111-1111-4111-8111-111111111111",
        signal: new AbortController().signal,
      });
    },
    async shutdown(): Promise<void> {
      network.shutdown();
      await supervisor.shutdown();
    },
  };
}

export function asJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
