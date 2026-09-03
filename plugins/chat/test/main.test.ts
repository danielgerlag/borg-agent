import {
  chatCreateSession,
  chatDeleteSession,
  chatGetSession,
  chatListSessions,
  chatSendMessage,
  chatSpawnSubAgent,
  personaSchema,
  type ChatSession,
  type LoopEvent,
  type LoopRunSnapshot,
  type LoopStartInput,
} from "@borg/contracts";
import {
  createTestHarness,
  type Disposable,
  type JsonValue,
  type PluginBus,
  type PluginContext,
  type StoreEntry,
  type StoreTransactionOperation,
} from "@borg/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import chatPlugin from "../src/main";

function createChatHarnessContext(
  store = new Map<string, JsonValue>(),
) {
  const handlers = new Map<
    string,
    (input: unknown, signal: AbortSignal) => unknown | Promise<unknown>
  >();
  const eventHandlers = new Map<string, Set<(payload: unknown) => unknown>>();
  const emittedEvents: string[] = [];
  const runs = new Map<string, LoopRunSnapshot>();
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
  const release = vi.fn(async () => undefined);
  const bus = {
    handle: (command: { readonly id: string }, handler: typeof handlers extends Map<string, infer T> ? T : never) => {
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
      emittedEvents.push(event.id);
      await Promise.allSettled(
        [...(eventHandlers.get(event.id) ?? [])].map(async (handler) =>
          handler(payload),
        ),
      );
    },
    on: (event: { readonly id: string }, handler: (payload: unknown) => unknown) => {
      const subscribers = eventHandlers.get(event.id) ?? new Set();
      subscribers.add(handler);
      eventHandlers.set(event.id, subscribers);
      return {
        dispose: () => subscribers.delete(handler),
      };
    },
  } as unknown as PluginBus;
  const general = personaSchema.parse({
    id: "system/general",
    name: "General",
    instructions: "Be useful.",
    preferredModels: ["borg.mock-llm:mock:scripted"],
  });
  const context = {
    pluginId: "borg.chat",
    signal: new AbortController().signal,
    bus,
    store: {
      get: async (key: string) => store.get(key),
      set: async (key: string, value: JsonValue) => {
        if (failingStoreSets > 0) {
          failingStoreSets -= 1;
          throw new Error("Injected store failure");
        }
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
        if (failingTransactions > 0) {
          failingTransactions -= 1;
          throw new Error("Injected transaction failure");
        }
        for (const operation of operations) {
          if (operation.type === "set") {
            store.set(operation.key, operation.value);
          } else {
            store.delete(operation.key);
          }
        }
      },
    },
    personas: {
      get: (id: string) => (id === general.id ? general : undefined),
      getDefault: () => general,
      list: () => [general],
    },
    workspace: {
      allocate: (sessionId: string) => ({
        sessionId,
        rootPath: `/tmp/${sessionId}`,
      }),
      get: () => undefined,
      listFiles: async () => [],
      release,
    },
    loops: {
      start,
      get: (runId: string) => runs.get(runId),
      list: () => [...runs.values()],
      pause: () => false,
      resume: () => false,
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
    config: {},
    secrets: {},
    persistence: {},
    tools: {},
    models: {},
    interactions: {},
    cost: {},
    window: { show: () => undefined },
    dataDir: "/tmp/borg-chat-test",
    notify: () => undefined,
    logger: {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
    host: { version: "0.1.0", platform: "test" },
  } as unknown as PluginContext;

  const invoke = async <T>(command: { readonly id: string }, input: unknown) =>
    bus.invoke(command as never, input as never) as Promise<T>;
  const finish = async (runId: string, output: string): Promise<void> => {
    const run = runs.get(runId)!;
    runs.set(runId, {
      ...run,
      status: "completed",
      output,
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
  };
}

describe("borg.chat harness", () => {
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
      await fixture.invoke<{ sessions: readonly ChatSession[] }>(
        chatListSessions,
        {},
      ),
    ).toEqual({ sessions: [] });
    expect(fixture.release).toHaveBeenCalledOnce();

    fixture.failNextLoopStart();
    const created = await fixture.invoke<{
      sessionId: string;
      startError?: string;
    }>(
      chatCreateSession,
      { initialMessage: "Keep this accepted message" },
    );
    expect(created.startError).toContain("Injected loop start failure");
    const document = await fixture.invoke<{
      session: ChatSession;
      entries: readonly { role: string; content: string }[];
    }>(chatGetSession, { sessionId: created.sessionId });
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
    const created = await fixture.invoke<{ sessionId: string }>(
      chatCreateSession,
      {},
    );
    const sent = await fixture.invoke<{ runId: string }>(chatSendMessage, {
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
    await harness.deactivate();
    const restored = createChatHarnessContext(fixture.store);
    const restoredHarness = await createTestHarness(
      chatPlugin,
      restored.context,
    );
    await vi.waitFor(async () => {
      const document = await restored.invoke<{
        entries: readonly { role: string; content: string }[];
      }>(chatGetSession, { sessionId: created.sessionId });
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

  it("serializes active-session deletion and cancels its loop", async () => {
    const fixture = createChatHarnessContext();
    const harness = await createTestHarness(chatPlugin, fixture.context);
    const created = await fixture.invoke<{ sessionId: string }>(
      chatCreateSession,
      {},
    );
    const sent = await fixture.invoke<{ runId: string }>(chatSendMessage, {
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
    const created = await fixture.invoke<{ sessionId: string }>(
      chatCreateSession,
      {},
    );
    const sent = await fixture.invoke<{ runId: string }>(chatSendMessage, {
      sessionId: created.sessionId,
      text: "hello",
    });
    fixture.failNextStoreSets(3);

    await fixture.finish(sent.runId, "volatile reply");
    const document = await fixture.invoke<{
      session: { status: string; activeRunId?: string };
      entries: readonly { content: string }[];
    }>(chatGetSession, { sessionId: created.sessionId });
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
    await harness.deactivate();
  });

  it("keeps an active session intact when durable deletion fails", async () => {
    const fixture = createChatHarnessContext();
    const harness = await createTestHarness(chatPlugin, fixture.context);
    const created = await fixture.invoke<{ sessionId: string }>(
      chatCreateSession,
      {},
    );
    const sent = await fixture.invoke<{ runId: string }>(chatSendMessage, {
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
    const parent = await fixture.invoke<{ sessionId: string }>(
      chatCreateSession,
      {},
    );
    const child = await fixture.invoke<{ childSessionId: string; runId: string }>(
      chatSpawnSubAgent,
      { parentSessionId: parent.sessionId, task: "child task" },
    );
    await fixture.finish(child.runId, "child reply");

    await fixture.invoke(chatDeleteSession, { sessionId: parent.sessionId });
    const listed = await fixture.invoke<{
      sessions: readonly { id: string; parentSessionId?: string }[];
    }>(chatListSessions, {});
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
    const parent = await fixture.invoke<{ sessionId: string }>(
      chatCreateSession,
      {},
    );
    fixture.failNextLoopStart();

    await expect(
      fixture.invoke(chatSpawnSubAgent, {
        parentSessionId: parent.sessionId,
        task: "child task",
      }),
    ).rejects.toThrow("Injected loop start failure");
    expect(fixture.emittedEvents).toContain("borg.chat.session.deleted");
    const listed = await fixture.invoke<{
      sessions: readonly { id: string }[];
    }>(chatListSessions, { includeChildren: true });
    expect(listed.sessions.map(({ id }) => id)).toEqual([parent.sessionId]);
    await harness.deactivate();
  });
});
