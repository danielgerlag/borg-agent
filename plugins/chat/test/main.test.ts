import {
  chatCreateSession,
  chatDeleteSession,
  chatDocumentSchema,
  chatGetSession,
  chatListSessions,
  chatSendMessage,
  chatSpawnSubAgent,
  embeddedContentRegistered,
  executionIdSchema,
  modelOperationPrefixSchema,
  personaSchema,
  type BusEnvelope,
  type CommandDefinition,
  type CommandInput,
  type CommandOutput,
  type EventDefinition,
  type EventPayload,
  type ExecutionId,
  type LoopEvent,
  type LoopRunSnapshot,
  type LoopStartInput,
} from "@borg/contracts";
import {
  createTestHarness,
  z,
  type ConfigStoreProvider,
  type Disposable,
  type JsonValue,
  type MemoryQuery,
  type MemoryRecord,
  type MemoryWriteInput,
  type PluginBus,
  type PluginContext,
  type PluginExecutions,
  type StoreEntry,
  type StoreTransactionOperation,
} from "@borg/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { ExecutionSecurityService } from "../../../packages/kernel/src/execution-security";
import { MemoryFacade } from "../../../packages/kernel/src/memory-facade";
import {
  PersistenceRegistry,
  StoreFacade,
} from "../../../packages/kernel/src/persistence";
import manifest from "../borg.plugin.json";
import chatPlugin from "../src/main";

const CHAT_PLUGIN_ID = chatPlugin.id;
const INTERNAL_STORE_PREFIX = "__borg_chat_harness__/";

const persistedChatRecordSchema = z
  .object({
    version: z.literal(2),
    document: chatDocumentSchema,
    security: z
      .object({
        headExecutionId: executionIdSchema,
        active: z
          .object({
            turnId: z.string().uuid(),
            executionId: executionIdSchema,
            operationPrefix: modelOperationPrefixSchema,
            runId: z.string().uuid().optional(),
          })
          .strict()
          .optional(),
        pendingClose: z
          .object({
            executionId: executionIdSchema,
            outcome: z.enum(["completed", "failed", "cancelled"]),
            reason: z.string().min(1),
          })
          .strict()
          .optional(),
      })
      .strict(),
  })
  .strict();

type CommandHandler = (
  input: unknown,
  signal: AbortSignal,
  envelope: BusEnvelope,
) => unknown | Promise<unknown>;

type EventHandler = (
  payload: unknown,
  envelope: BusEnvelope,
) => void | Promise<void>;

function createEnvelope(kind: BusEnvelope["source"]["kind"]): BusEnvelope {
  return {
    correlationId: crypto.randomUUID(),
    source: { kind, id: CHAT_PLUGIN_ID },
    timestamp: new Date().toISOString(),
  };
}

class ChatHarnessBus implements PluginBus {
  readonly #handlers = new Map<string, CommandHandler>();
  readonly #eventHandlers = new Map<string, Set<EventHandler>>();

  constructor(readonly emittedEvents: string[]) {}

  handle<TCommand extends CommandDefinition>(
    command: TCommand,
    handler: (
      input: CommandInput<TCommand>,
      signal: AbortSignal,
      envelope: BusEnvelope,
    ) => CommandOutput<TCommand> | Promise<CommandOutput<TCommand>>,
  ): Disposable {
    const storedHandler = handler as CommandHandler;
    this.#handlers.set(command.id, storedHandler);
    return {
      dispose: () => {
        if (this.#handlers.get(command.id) === storedHandler) {
          this.#handlers.delete(command.id);
        }
      },
    };
  }

  async invoke<TCommand extends CommandDefinition>(
    command: TCommand,
    input: CommandInput<TCommand>,
    options?: { readonly signal?: AbortSignal | undefined },
  ): Promise<CommandOutput<TCommand>> {
    const handler = this.#handlers.get(command.id);
    if (!handler) {
      throw new Error(`Missing handler ${command.id}`);
    }
    const result = await handler(
      input,
      options?.signal ?? new AbortController().signal,
      createEnvelope("renderer"),
    );
    return command.output.parse(result) as CommandOutput<TCommand>;
  }

  provides(command: CommandDefinition): boolean {
    return this.#handlers.has(command.id);
  }

  async emit<TEvent extends EventDefinition>(
    event: TEvent,
    payload: EventPayload<TEvent>,
  ): Promise<void> {
    this.emittedEvents.push(event.id);
    await Promise.all(
      [...(this.#eventHandlers.get(event.id) ?? [])].map(async (handler) =>
        handler(payload, createEnvelope("plugin")),
      ),
    );
  }

  on<TEvent extends EventDefinition>(
    event: TEvent,
    handler: (
      payload: EventPayload<TEvent>,
      envelope: BusEnvelope,
    ) => void | Promise<void>,
  ): Disposable {
    const storedHandler = handler as EventHandler;
    const subscribers =
      this.#eventHandlers.get(event.id) ?? new Set<EventHandler>();
    subscribers.add(storedHandler);
    this.#eventHandlers.set(event.id, subscribers);
    return {
      dispose: () => {
        subscribers.delete(storedHandler);
      },
    };
  }
}

function namespacePrefix(namespace: string): string {
  return namespace === CHAT_PLUGIN_ID
    ? ""
    : `${INTERNAL_STORE_PREFIX}store/${encodeURIComponent(namespace)}/`;
}

function namespaceKey(namespace: string, key: string): string {
  return `${namespacePrefix(namespace)}${key}`;
}

function configKey(namespace: string): string {
  return `${INTERNAL_STORE_PREFIX}config/${encodeURIComponent(namespace)}`;
}

class MemoryConfigStore implements ConfigStoreProvider {
  constructor(readonly values: Map<string, JsonValue>) {}

  async readConfig(namespace: string): Promise<unknown | undefined> {
    return this.values.get(configKey(namespace));
  }

  async writeConfig(namespace: string, value: JsonValue): Promise<void> {
    this.values.set(configKey(namespace), value);
  }

  async getStore(
    namespace: string,
    key: string,
  ): Promise<JsonValue | undefined> {
    return this.values.get(namespaceKey(namespace, key));
  }

  async listStore(
    namespace: string,
    prefix: string,
  ): Promise<readonly StoreEntry[]> {
    const storedPrefix = namespacePrefix(namespace);
    const entries: StoreEntry[] = [];
    for (const [storedKey, value] of this.values) {
      if (
        namespace === CHAT_PLUGIN_ID &&
        storedKey.startsWith(INTERNAL_STORE_PREFIX)
      ) {
        continue;
      }
      if (!storedKey.startsWith(storedPrefix)) {
        continue;
      }
      const key = storedKey.slice(storedPrefix.length);
      if (key.startsWith(prefix)) {
        entries.push({ key, value });
      }
    }
    return entries;
  }

  async applyStoreTransaction(
    namespace: string,
    operations: readonly StoreTransactionOperation[],
  ): Promise<void> {
    const next = new Map(this.values);
    for (const operation of operations) {
      const key = namespaceKey(namespace, operation.key);
      if (operation.type === "set") {
        next.set(key, operation.value);
      } else {
        next.delete(key);
      }
    }
    this.values.clear();
    for (const [key, value] of next) {
      this.values.set(key, value);
    }
  }
}

function unavailable(capability: string): never {
  throw new Error(`${capability} is unavailable in the chat test harness`);
}

function persistedChatRecord(
  store: ReadonlyMap<string, JsonValue>,
  sessionId: string,
) {
  const value = store.get(`sessions/${sessionId}`);
  if (value === undefined) {
    throw new Error(`Persisted chat session ${sessionId} is unavailable`);
  }
  return persistedChatRecordSchema.parse(value);
}

function createChatHarnessContext(
  store = new Map<string, JsonValue>(),
) {
  const emittedEvents: string[] = [];
  const bus = new ChatHarnessBus(emittedEvents);
  const persistence = new PersistenceRegistry();
  persistence.registerConfigStore(
    "borg.chat.test-store",
    new MemoryConfigStore(store),
  );
  const storeFacade = new StoreFacade(persistence);
  const executionSecurity = new ExecutionSecurityService(storeFacade);
  const executionsReady = executionSecurity.initialize();
  const executions: PluginExecutions = {
    bind: async (intent) => {
      await executionsReady;
      return executionSecurity.bind(CHAT_PLUGIN_ID, intent, "detached");
    },
    grant: async (executionId) => {
      await executionsReady;
      await executionSecurity.snapshot(CHAT_PLUGIN_ID, executionId);
      return executionSecurity.createParentGrant({
        parentExecutionId: executionId,
        granteePluginId: CHAT_PLUGIN_ID,
      });
    },
  };
  const runs = new Map<string, LoopRunSnapshot>();
  const workspaces = new Map<
    string,
    { readonly sessionId: string; readonly rootPath: string }
  >();
  let failingStoreSets = 0;
  let failingTransactions = 0;
  let failLoopStart = false;
  const runSubscribers = new Map<
    string,
    Set<(event: LoopEvent) => void | Promise<void>>
  >();
  const start = vi.fn(async (input: LoopStartInput) => {
    if (failLoopStart) {
      throw new Error("Injected loop start failure");
    }
    const now = new Date().toISOString();
    const snapshot: LoopRunSnapshot = {
      id: crypto.randomUUID(),
      status: "running",
      prompt: input.prompt,
      personaId: input.personaId,
      sessionId: input.sessionId,
      providerId: "borg.mock-llm",
      modelId: "mock:scripted",
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      costsByCurrency: {},
      createdAt: now,
      updatedAt: now,
    };
    runs.set(snapshot.id, snapshot);
    return snapshot;
  });
  const cancel = vi.fn((runId: string) => {
    const run = runs.get(runId);
    if (!run) {
      return false;
    }
    runs.set(runId, {
      ...run,
      status: "cancelled",
      updatedAt: new Date().toISOString(),
    });
    return true;
  });
  const release = vi.fn(async (sessionId: string) => {
    workspaces.delete(sessionId);
  });
  const general = personaSchema.parse({
    id: "system/general",
    name: "General",
    instructions: "Be useful.",
    preferredModels: ["borg.mock-llm:mock:scripted"],
  });
  const context: PluginContext = {
    pluginId: CHAT_PLUGIN_ID,
    signal: new AbortController().signal,
    bus,
    store: {
      get: (key) => storeFacade.get(CHAT_PLUGIN_ID, key),
      set: async (key: string, value: JsonValue) => {
        if (failingStoreSets > 0) {
          failingStoreSets -= 1;
          throw new Error("Injected store failure");
        }
        await storeFacade.set(CHAT_PLUGIN_ID, key, value);
      },
      delete: (key) => storeFacade.delete(CHAT_PLUGIN_ID, key),
      list: (prefix = "") => storeFacade.list(CHAT_PLUGIN_ID, prefix),
      transaction: async (operations: readonly StoreTransactionOperation[]) => {
        if (failingTransactions > 0) {
          failingTransactions -= 1;
          throw new Error("Injected transaction failure");
        }
        await storeFacade.transaction(CHAT_PLUGIN_ID, operations);
      },
    },
    config: {
      get: async () => unavailable("config.get"),
      update: async () => unavailable("config.update"),
      watch: () => unavailable("config.watch"),
    },
    secrets: {
      get: async () => unavailable("secrets.get"),
      set: async () => unavailable("secrets.set"),
      delete: async () => unavailable("secrets.delete"),
      has: async () => unavailable("secrets.has"),
    },
    persistence: {
      registerConfigStore: () =>
        unavailable("persistence.registerConfigStore"),
      registerSecretStore: () =>
        unavailable("persistence.registerSecretStore"),
    },
    executions,
    tools: {
      register: () => unavailable("tools.register"),
      registerProvider: () => unavailable("tools.registerProvider"),
      registerExecutionScope: () =>
        unavailable("tools.registerExecutionScope"),
      invoke: async () => unavailable("tools.invoke"),
    },
    models: {
      registerProvider: () => unavailable("models.registerProvider"),
      complete: async () => unavailable("models.complete"),
    },
    personas: {
      get: (id: string) => (id === general.id ? general : undefined),
      getDefault: () => general,
      list: () => [general],
      setDefault: async () => unavailable("personas.setDefault"),
      create: async () => unavailable("personas.create"),
      update: async () => unavailable("personas.update"),
      archive: async () => unavailable("personas.archive"),
    },
    workspace: {
      allocate: (sessionId: string) => {
        const workspace = {
          sessionId,
          rootPath: `/virtual/borg-chat-test/${sessionId}`,
        };
        workspaces.set(sessionId, workspace);
        return workspace;
      },
      get: (sessionId) => workspaces.get(sessionId),
      listFiles: async () => [],
      release,
    },
    loops: {
      start,
      get: (runId: string) => runs.get(runId),
      list: () => [...runs.values()],
      pause: () => unavailable("loops.pause"),
      resume: () => unavailable("loops.resume"),
      cancel,
      subscribe: (
        runId: string,
        handler: (event: LoopEvent) => void | Promise<void>,
      ): Disposable => {
        const subscribers = runSubscribers.get(runId) ?? new Set();
        subscribers.add(handler);
        runSubscribers.set(runId, subscribers);
        return {
          dispose: () => {
            subscribers.delete(handler);
          },
        };
      },
    },
    interactions: {
      requestHumanInput: () =>
        unavailable("interactions.requestHumanInput"),
    },
    cost: {
      summary: () => unavailable("cost.summary"),
      subscribe: () => unavailable("cost.subscribe"),
    },
    prompts: {
      registerSlot: () => unavailable("prompts.registerSlot"),
    },
    memory: {
      registerProvider: () => unavailable("memory.registerProvider"),
      write: async () => unavailable("memory.write"),
      retrieve: async () => unavailable("memory.retrieve"),
    },
    scanners: {
      register: () => unavailable("scanners.register"),
    },
    graphs: {
      registerStep: () => unavailable("graphs.registerStep"),
      registerTrigger: () => unavailable("graphs.registerTrigger"),
      listSteps: () => unavailable("graphs.listSteps"),
      listTriggers: () => unavailable("graphs.listTriggers"),
    },
    scheduler: {
      schedule: () => unavailable("scheduler.schedule"),
      scheduleCron: () => unavailable("scheduler.scheduleCron"),
      cancel: () => unavailable("scheduler.cancel"),
    },
    runtime: {
      spawn: () => unavailable("runtime.spawn"),
    },
    process: {
      spawn: async () => unavailable("process.spawn"),
    },
    http: {
      fetch: async () => unavailable("http.fetch"),
    },
    channels: {
      register: () => unavailable("channels.register"),
      send: async () => unavailable("channels.send"),
    },
    webSockets: {
      connect: async () => unavailable("webSockets.connect"),
    },
    window: { show: () => unavailable("window.show") },
    dataDir: "/virtual/borg-chat-test",
    notify: () => unavailable("notify"),
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    host: { version: "0.1.0", platform: "test" },
  };

  const invoke = <TCommand extends CommandDefinition>(
    command: TCommand,
    input: CommandInput<TCommand>,
  ): Promise<CommandOutput<TCommand>> => bus.invoke(command, input);
  const finish = async (
    runId: string,
    output: string,
    usage?: {
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly cachedInputTokens?: number;
      readonly cacheWriteTokens?: number;
      readonly costsByCurrency?: Readonly<Record<string, number>>;
    },
  ): Promise<void> => {
    const run = runs.get(runId);
    if (!run) {
      throw new Error(`Loop run ${runId} is unavailable`);
    }
    runs.set(runId, {
      ...run,
      status: "completed",
      output,
      inputTokens: usage?.inputTokens ?? run.inputTokens,
      outputTokens: usage?.outputTokens ?? run.outputTokens,
      cachedInputTokens: usage?.cachedInputTokens ?? run.cachedInputTokens,
      cacheWriteTokens: usage?.cacheWriteTokens ?? run.cacheWriteTokens,
      costsByCurrency: usage?.costsByCurrency ?? run.costsByCurrency,
      updatedAt: new Date().toISOString(),
    });
    const event: LoopEvent = {
      type: "state",
      runId,
      status: "completed",
      timestamp: new Date().toISOString(),
    };
    await Promise.all(
      [...(runSubscribers.get(runId) ?? [])].map(async (handler) =>
        handler(event),
      ),
    );
  };
  return {
    context,
    invoke,
    start,
    cancel,
    release,
    finish,
    store,
    failNextStoreSets: (count: number) => {
      failingStoreSets = count;
    },
    failNextTransaction: () => {
      failingTransactions = 1;
    },
    failNextLoopStart: () => {
      failLoopStart = true;
    },
    emittedEvents,
    emit: <TEvent extends EventDefinition>(
      event: TEvent,
      payload: EventPayload<TEvent>,
    ) => bus.emit(event, payload),
    executionSnapshot: async (executionId: ExecutionId) => {
      await executionsReady;
      return executionSecurity.snapshot(CHAT_PLUGIN_ID, executionId);
    },
  };
}

describe("borg.chat harness", () => {
  it("declares execution security access", () => {
    expect(chatPlugin.permissions).toContain("executions.manage");
    expect(manifest.permissions).toContain("executions.manage");
    expect(chatPlugin.permissions).toContain("memory.write");
    expect(manifest.permissions).toContain("memory.write");
  });

  it("persists the first user message atomically with a new chat", async () => {
    const fixture = createChatHarnessContext();
    const harness = await createTestHarness(chatPlugin, fixture.context);

    fixture.failNextStoreSets(1);
    await expect(
      fixture.invoke(chatCreateSession, {
        initialMessage: "Do not leave an empty chat",
      }),
    ).rejects.toThrow("Injected store failure");
    expect(
      await fixture.invoke(chatListSessions, {}),
    ).toEqual({ sessions: [] });
    expect(fixture.release).toHaveBeenCalledOnce();

    fixture.failNextLoopStart();
    const created = await fixture.invoke(chatCreateSession, {
      initialMessage: "Keep this accepted message",
    });
    expect(created.startError).toContain("Injected loop start failure");
    const document = await fixture.invoke(chatGetSession, {
      sessionId: created.sessionId,
    });
    expect(document.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "user",
          content: "Keep this accepted message",
        }),
      ]),
    );
    expect(document.session.status).toBe("error");

    await harness.deactivate();
  });

  it("persists a persona-backed turn and projects its final transcript", async () => {
    const fixture = createChatHarnessContext();
    const harness = await createTestHarness(chatPlugin, fixture.context);
    const created = await fixture.invoke(chatCreateSession, {});
    const sent = await fixture.invoke(chatSendMessage, {
      sessionId: created.sessionId,
      text: "hello",
    });

    expect(fixture.start).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "hello",
        personaId: "system/general",
        sessionId: created.sessionId,
      }),
    );
    await fixture.finish(sent.runId, "mock reply");
    const beforeRestart = persistedChatRecord(
      fixture.store,
      created.sessionId,
    );
    expect(beforeRestart.version).toBe(2);
    expect(beforeRestart.security.active).toBeUndefined();
    const securityHead = beforeRestart.security.headExecutionId;
    await harness.deactivate();
    const restored = createChatHarnessContext(fixture.store);
    const restoredHarness = await createTestHarness(
      chatPlugin,
      restored.context,
    );
    const afterRestart = persistedChatRecord(
      restored.store,
      created.sessionId,
    );
    expect(afterRestart.security.headExecutionId).toBe(securityHead);
    await expect(
      restored.executionSnapshot(securityHead),
    ).resolves.toMatchObject({
      classification: "internal",
      lifecycle: { state: "closed", outcome: "completed" },
      subject: {
        kind: "chat-turn",
      },
    });
    await vi.waitFor(async () => {
      const document = await restored.invoke(chatGetSession, {
        sessionId: created.sessionId,
      });
      expect(document.entries).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: "user", content: "hello" }),
          expect.objectContaining({
            role: "assistant",
            content: "mock reply",
          }),
        ]),
      );
    });
    await restoredHarness.deactivate();
  });

  it("recovers a persisted turn that never reached loop start", async () => {
    const fixture = createChatHarnessContext();
    const harness = await createTestHarness(chatPlugin, fixture.context);
    const created = await fixture.invoke(chatCreateSession, {});
    const persisted = persistedChatRecord(
      fixture.store,
      created.sessionId,
    );
    const turnId = crypto.randomUUID();
    const parent = await fixture.context.executions.grant(
      persisted.security.headExecutionId,
    );
    const turn = await fixture.context.executions.bind({
      mode: "child",
      subject: {
        kind: "chat-turn",
        id: `${created.sessionId}/${turnId}`,
      },
      parent,
    });
    const operationPrefix = modelOperationPrefixSchema.parse(
      `chat/session/${created.sessionId}/turn/${turnId}`,
    );
    const interrupted = persistedChatRecordSchema.parse({
      ...persisted,
      document: {
        ...persisted.document,
        session: {
          ...persisted.document.session,
          status: "running",
          updatedAt: new Date().toISOString(),
        },
      },
      security: {
        headExecutionId: persisted.security.headExecutionId,
        active: {
          turnId,
          executionId: turn.id,
          operationPrefix,
        },
      },
    });
    fixture.store.set(
      `sessions/${created.sessionId}`,
      z.json().parse(interrupted),
    );
    await harness.deactivate();

    const restored = createChatHarnessContext(fixture.store);
    const restoredHarness = await createTestHarness(
      chatPlugin,
      restored.context,
    );
    expect(restored.start).not.toHaveBeenCalled();
    const recovered = persistedChatRecord(
      restored.store,
      created.sessionId,
    );
    expect(recovered.security).toEqual({
      headExecutionId: turn.id,
    });
    await expect(restored.executionSnapshot(turn.id)).resolves.toMatchObject({
      lifecycle: {
        state: "closed",
        outcome: "interrupted",
      },
    });
    const document = await restored.invoke(chatGetSession, {
      sessionId: created.sessionId,
    });
    expect(
      document.entries.some(
        (entry) => entry.metadata?.status === "interrupted",
      ),
    ).toBe(true);
    await restoredHarness.deactivate();
  });

  it("serializes active-session deletion and cancels its loop", async () => {
    const fixture = createChatHarnessContext();
    const harness = await createTestHarness(chatPlugin, fixture.context);
    const created = await fixture.invoke(chatCreateSession, {});
    const sent = await fixture.invoke(chatSendMessage, {
      sessionId: created.sessionId,
      text: "keep running",
    });

    await expect(
      fixture.invoke(chatDeleteSession, { sessionId: created.sessionId }),
    ).resolves.toEqual({ deleted: true });
    expect(fixture.cancel).toHaveBeenCalledWith(sent.runId);
    expect(fixture.release).toHaveBeenCalledWith(created.sessionId);
    await harness.deactivate();
  });

  it("unblocks a session and exposes an error when terminal persistence fails", async () => {
    const fixture = createChatHarnessContext();
    const harness = await createTestHarness(chatPlugin, fixture.context);
    const created = await fixture.invoke(chatCreateSession, {});
    const sent = await fixture.invoke(chatSendMessage, {
      sessionId: created.sessionId,
      text: "hello",
    });
    fixture.failNextStoreSets(3);
    await fixture.finish(sent.runId, "volatile reply");
    const document = await fixture.invoke(chatGetSession, {
      sessionId: created.sessionId,
    });
    expect(document.session).toMatchObject({
      status: "error",
      activeRunId: undefined,
    });
    expect(document.entries.map(({ content }) => content)).toEqual(
      expect.arrayContaining([
        "volatile reply",
        "The turn finished, but its result could not be saved.",
      ]),
    );
    const retried = await fixture.invoke(chatSendMessage, {
      sessionId: created.sessionId,
      text: "try again",
    });
    await fixture.finish(retried.runId, "saved reply");
    await expect(
      fixture.invoke(chatGetSession, {
        sessionId: created.sessionId,
      }),
    ).resolves.toMatchObject({
      session: {
        status: "idle",
        activeRunId: undefined,
      },
    });
    await harness.deactivate();
  });

  it("keeps an active session intact when durable deletion fails", async () => {
    const fixture = createChatHarnessContext();
    const harness = await createTestHarness(chatPlugin, fixture.context);
    const created = await fixture.invoke(chatCreateSession, {});
    const sent = await fixture.invoke(chatSendMessage, {
      sessionId: created.sessionId,
      text: "keep running",
    });
    fixture.failNextTransaction();

    await expect(
      fixture.invoke(chatDeleteSession, { sessionId: created.sessionId }),
    ).rejects.toThrow("Injected transaction failure");
    expect(fixture.cancel).not.toHaveBeenCalled();
    await expect(
      fixture.invoke(chatGetSession, { sessionId: created.sessionId }),
    ).resolves.toMatchObject({
      session: { activeRunId: sent.runId, status: "running" },
    });
    await harness.deactivate();
  });

  it("keeps child sessions reachable when their parent is deleted", async () => {
    const fixture = createChatHarnessContext();
    const harness = await createTestHarness(chatPlugin, fixture.context);
    const parent = await fixture.invoke(chatCreateSession, {});
    const child = await fixture.invoke(chatSpawnSubAgent, {
      parentSessionId: parent.sessionId,
      task: "child task",
    });
    const parentHead = persistedChatRecord(
      fixture.store,
      parent.sessionId,
    ).security.headExecutionId;
    const childHead = persistedChatRecord(
      fixture.store,
      child.childSessionId,
    ).security.headExecutionId;
    const parentSecurity = await fixture.executionSnapshot(parentHead);
    const childSecurity = await fixture.executionSnapshot(childHead);
    expect(childSecurity.classification).toBe(
      parentSecurity.classification,
    );
    expect(childSecurity).toMatchObject({
      rootExecutionId: parentSecurity.rootExecutionId,
      parentExecutionId: parentSecurity.id,
      subject: {
        kind: "chat-session",
        id: child.childSessionId,
      },
    });
    await fixture.finish(child.runId, "child reply");

    await fixture.invoke(chatDeleteSession, { sessionId: parent.sessionId });
    const listed = await fixture.invoke(chatListSessions, {});
    expect(listed.sessions).toEqual([
      expect.objectContaining({
        id: child.childSessionId,
        parentSessionId: undefined,
      }),
    ]);
    await harness.deactivate();
  });

  it("publishes child deletion when sub-agent startup rolls back", async () => {
    const fixture = createChatHarnessContext();
    const harness = await createTestHarness(chatPlugin, fixture.context);
    const parent = await fixture.invoke(chatCreateSession, {});
    fixture.failNextLoopStart();

    await expect(
      fixture.invoke(chatSpawnSubAgent, {
        parentSessionId: parent.sessionId,
        task: "child task",
      }),
    ).rejects.toThrow("Injected loop start failure");
    expect(fixture.emittedEvents).toContain("borg.chat.session.deleted");
    const listed = await fixture.invoke(chatListSessions, {
      includeChildren: true,
    });
    expect(listed.sessions.map(({ id }) => id)).toEqual([parent.sessionId]);
    await harness.deactivate();
  });

  it("accumulates durable session usage exactly once from the terminal snapshot", async () => {
    const fixture = createChatHarnessContext();
    const harness = await createTestHarness(chatPlugin, fixture.context);
    const created = await fixture.invoke(chatCreateSession, {});
    const first = await fixture.invoke(chatSendMessage, {
      sessionId: created.sessionId,
      text: "first",
    });
    await fixture.finish(first.runId, "one", {
      inputTokens: 10,
      outputTokens: 4,
      cachedInputTokens: 2,
      cacheWriteTokens: 1,
      costsByCurrency: { USD: 0.01 },
    });
    const afterFirst = await fixture.invoke(chatGetSession, {
      sessionId: created.sessionId,
    });
    expect(afterFirst.session.usage).toEqual({
      inputTokens: 10,
      outputTokens: 4,
      cachedInputTokens: 2,
      cacheWriteTokens: 1,
      costsByCurrency: { USD: 0.01 },
    });

    const second = await fixture.invoke(chatSendMessage, {
      sessionId: created.sessionId,
      text: "second",
    });
    await fixture.finish(second.runId, "two", {
      inputTokens: 3,
      outputTokens: 1,
      costsByCurrency: { USD: 0.002 },
    });
    const afterSecond = await fixture.invoke(chatGetSession, {
      sessionId: created.sessionId,
    });
    expect(afterSecond.session.usage).toEqual({
      inputTokens: 13,
      outputTokens: 5,
      cachedInputTokens: 2,
      cacheWriteTokens: 1,
      costsByCurrency: { USD: 0.012 },
    });

    await harness.deactivate();
    const restored = createChatHarnessContext(fixture.store);
    const restoredHarness = await createTestHarness(
      chatPlugin,
      restored.context,
    );
    const restoredDocument = await restored.invoke(chatGetSession, {
      sessionId: created.sessionId,
    });
    expect(restoredDocument.session.usage).toEqual({
      inputTokens: 13,
      outputTokens: 5,
      cachedInputTokens: 2,
      cacheWriteTokens: 1,
      costsByCurrency: { USD: 0.012 },
    });
    await restoredHarness.deactivate();
  });

  it("persists embedded content snapshots without duplicates", async () => {
    const fixture = createChatHarnessContext();
    const harness = await createTestHarness(chatPlugin, fixture.context);
    const created = await fixture.invoke(chatCreateSession, {});
    const registered = {
      sessionId: created.sessionId,
      content: {
        instanceId: "d0cc0266-2235-5fea-965b-dbabe70c3a66",
        rendererId: "borg.mcp-apps",
        title: "Fixture app",
        payload: { version: 1, fixture: true },
        createdAt: "2026-09-03T12:00:00.000Z",
      },
    };
    await fixture.emit(embeddedContentRegistered, registered);
    await fixture.emit(embeddedContentRegistered, registered);

    const document = await fixture.invoke(chatGetSession, {
      sessionId: created.sessionId,
    });
    expect(
      document.entries.filter(
        (entry) => entry.metadata?.kind === "embedded_content",
      ),
    ).toEqual([
      expect.objectContaining({
        role: "event",
        metadata: expect.objectContaining({
          embeddedContent: expect.objectContaining({
            instanceId: registered.content.instanceId,
            rendererId: "borg.mcp-apps",
          }),
        }),
      }),
    ]);

    await harness.deactivate();
    const restored = createChatHarnessContext(fixture.store);
    const restoredHarness = await createTestHarness(
      chatPlugin,
      restored.context,
    );
    const restoredDocument = await restored.invoke(chatGetSession, {
      sessionId: created.sessionId,
    });
    expect(
      restoredDocument.entries.some(
        (entry) => entry.metadata?.kind === "embedded_content",
      ),
    ).toBe(true);
    await restoredHarness.deactivate();
  });

  it("writes the first user turn after loop start so the next assemble can recall it", async () => {
    const memory = new MemoryFacade();
    const stored: MemoryRecord[] = [];
    memory.registerProvider("test.memory", {
      id: "test.memory",
      write: async (record) => {
        stored.push(record);
      },
      retrieve: async () => stored,
    });
    const fixture = createChatHarnessContext();
    const recalled: string[] = [];
    const originalStart = fixture.start.getMockImplementation();
    if (!originalStart) {
      throw new Error("Chat harness loop start mock is missing");
    }
    fixture.start.mockImplementation(async (input: LoopStartInput) => {
      const hits = await memory.retrieve({
        personaId: input.personaId ?? "system/general",
        sessionId: input.sessionId,
        text: input.prompt,
      });
      recalled.push(hits.map((record) => record.text).join("\n"));
      return originalStart(input);
    });
    fixture.context.memory.write = (input: MemoryWriteInput) =>
      memory.write("borg.chat", input);
    fixture.context.memory.retrieve = (query: MemoryQuery) =>
      memory.retrieve(query);

    const harness = await createTestHarness(chatPlugin, fixture.context);
    const created = await fixture.invoke(chatCreateSession, {});
    const first = await fixture.invoke(chatSendMessage, {
      sessionId: created.sessionId,
      text: "The user's favorite color is cerulean.",
    });
    expect(recalled[0]).not.toContain("cerulean");
    await fixture.finish(first.runId, "noted");
    await fixture.invoke(chatSendMessage, {
      sessionId: created.sessionId,
      text: "What is my favorite color?",
    });
    expect(recalled[1]).toContain("The user's favorite color is cerulean.");
    await harness.deactivate();
  });
});
