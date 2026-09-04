import {
  embeddedContentRegistered,
  mcpAppDiscovered,
  mcpAppSnapshotSchema,
  mcpAppToolResponded,
  mcpAppsCancelTool,
  mcpAppsInvokeTool,
} from "@borg/contracts";
import {
  createTestHarness,
  type JsonValue,
  type PluginBus,
  type PluginContext,
  type StoreEntry,
} from "@borg/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import mcpAppsPlugin from "../src/main";

const appInstanceId = "d0cc0266-2235-5fea-965b-dbabe70c3a66";
const sessionId = "62d524e8-5a22-41a1-ac64-beb55f1e1183";
const invocationId = "f3612840-38f9-4e6d-9d0e-2be45db77476";

function discoveredApp() {
  return mcpAppDiscovered.payload.parse({
    sessionId,
    personaId: "system/general",
    appInstanceId,
    serverId: "fixture",
    resourceUri: "ui://fixture/form",
    sourceToolId: "mcp.fixture.show-form",
    sourceToolName: "show_form",
    toolInput: { title: "Fixture form" },
    callResult: { content: [{ type: "text", text: "Form ready" }] },
    html:
      "<!DOCTYPE html><html><head></head><body><p>Fixture app</p></body></html>",
    csp: {},
    permissions: {
      camera: false,
      microphone: false,
      geolocation: false,
      clipboardWrite: false,
    },
    tools: [
      {
        name: "echo",
        toolId: "mcp.fixture.echo",
        description: "Echo fixture input",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
        },
      },
    ],
    startedAt: "2026-09-03T11:59:59.000Z",
    completedAt: "2026-09-03T12:00:00.000Z",
    discoveredAt: "2026-09-03T12:00:00.000Z",
  });
}

function createContext(
  invokeTool: (
    toolId: string,
    input: unknown,
    options: {
      readonly runId?: string;
      readonly signal?: AbortSignal;
    },
  ) => Promise<JsonValue>,
  failEventId?: string,
  initialStore: ReadonlyMap<string, JsonValue> = new Map(),
) {
  const handlers = new Map<
    string,
    (input: never, signal: AbortSignal) => unknown | Promise<unknown>
  >();
  const subscribers = new Map<string, Set<(payload: never) => unknown>>();
  const emitted = new Map<string, unknown[]>();
  const store = new Map<string, JsonValue>(initialStore);
  const prepare = vi.fn(async () => undefined);
  const dispose = vi.fn();
  const registerExecutionScope = vi.fn(() => ({
    prepare,
    dispose,
  }));
  const bus = {
    handle: (
      command: { readonly id: string },
      handler: (input: never, signal: AbortSignal) => unknown | Promise<unknown>,
    ) => {
      handlers.set(command.id, handler);
      return { dispose: () => handlers.delete(command.id) };
    },
    invoke: async (
      command: { readonly id: string },
      input: unknown,
      signal = new AbortController().signal,
    ) => {
      const handler = handlers.get(command.id);
      if (!handler) {
        throw new Error(`Missing handler ${command.id}`);
      }
      return handler(input as never, signal);
    },
    provides: (command: { readonly id: string }) => handlers.has(command.id),
    emit: async (event: { readonly id: string }, payload: unknown) => {
      if (event.id === failEventId) {
        throw new Error(`Failed to emit ${event.id}`);
      }
      const values = emitted.get(event.id) ?? [];
      values.push(payload);
      emitted.set(event.id, values);
      await Promise.all(
        [...(subscribers.get(event.id) ?? [])].map(async (subscriber) =>
          subscriber(payload as never),
        ),
      );
    },
    on: (
      event: { readonly id: string },
      subscriber: (payload: never) => unknown,
    ) => {
      const values = subscribers.get(event.id) ?? new Set();
      values.add(subscriber);
      subscribers.set(event.id, values);
      return { dispose: () => values.delete(subscriber) };
    },
  } as unknown as PluginBus;
  const context = {
    pluginId: "borg.mcp-apps",
    signal: new AbortController().signal,
    bus,
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
      transaction: async () => undefined,
    },
    tools: {
      registerExecutionScope,
      invoke: invokeTool,
    },
  } as unknown as PluginContext;
  return {
    bus,
    context,
    dispose,
    emitted,
    prepare,
    registerExecutionScope,
    store,
  };
}

describe("MCP Apps main plugin", () => {
  it("replays loaded snapshots once after activation", async () => {
    const snapshot = mcpAppSnapshotSchema.parse({
      ...discoveredApp(),
      version: 1,
    });
    const harnessContext = createContext(
      async () => ({}),
      undefined,
      new Map([[`apps/${appInstanceId}`, snapshot]]),
    );
    const harness = await createTestHarness(
      mcpAppsPlugin,
      harnessContext.context,
    );

    expect(
      harnessContext.emitted.get(embeddedContentRegistered.id),
    ).toHaveLength(1);
    await harnessContext.bus.emit(mcpAppDiscovered, discoveredApp());
    expect(
      harnessContext.emitted.get(embeddedContentRegistered.id),
    ).toHaveLength(1);
    await harness.deactivate();
  });

  it("rolls back a stored discovery when publication fails", async () => {
    const harnessContext = createContext(
      async () => ({}),
      embeddedContentRegistered.id,
    );
    const harness = await createTestHarness(
      mcpAppsPlugin,
      harnessContext.context,
    );

    await expect(
      harnessContext.bus.emit(mcpAppDiscovered, discoveredApp()),
    ).rejects.toThrow(/Failed to emit/);
    expect(harnessContext.store.size).toBe(0);
    await harness.deactivate();
  });

  it("persists discoveries and invokes app tools through a run scope", async () => {
    const invokeTool = vi.fn(async () => ({ echoed: "hello" }));
    const harnessContext = createContext(invokeTool);
    const harness = await createTestHarness(
      mcpAppsPlugin,
      harnessContext.context,
    );

    await harnessContext.bus.emit(mcpAppDiscovered, discoveredApp());
    expect(harnessContext.store.size).toBe(1);
    expect(
      harnessContext.emitted.get(embeddedContentRegistered.id),
    ).toHaveLength(1);

    const response = await harnessContext.bus.invoke(mcpAppsInvokeTool, {
      appInstanceId,
      invocationId,
      requestId: "request-1",
      toolName: "echo",
      arguments: { text: "hello" },
    });
    expect(response).toEqual({
      requestId: "request-1",
      result: { echoed: "hello" },
    });
    expect(harnessContext.registerExecutionScope).toHaveBeenCalledWith({
      runId: invocationId,
      sessionId,
      personaId: "system/general",
      allowedTools: ["mcp.fixture.echo"],
    });
    expect(harnessContext.prepare).toHaveBeenCalledOnce();
    expect(invokeTool).toHaveBeenCalledWith(
      "mcp.fixture.echo",
      { text: "hello" },
      expect.objectContaining({ runId: invocationId }),
    );
    expect(
      harnessContext.emitted.get(mcpAppToolResponded.id)?.at(-1),
    ).toMatchObject({
      appInstanceId,
      invocationId,
      response: { status: "succeeded", result: { echoed: "hello" } },
    });
    expect(harnessContext.dispose).toHaveBeenCalledOnce();
    await harness.deactivate();
  });

  it("cancels active tool calls and records a cancelled response", async () => {
    const invokeTool = vi.fn(
      async (
        _toolId: string,
        _input: unknown,
        options: { readonly signal?: AbortSignal },
      ): Promise<JsonValue> =>
        new Promise((_, reject) => {
          options.signal?.addEventListener(
            "abort",
            () => reject(options.signal?.reason),
            { once: true },
          );
        }),
    );
    const harnessContext = createContext(invokeTool);
    const harness = await createTestHarness(
      mcpAppsPlugin,
      harnessContext.context,
    );
    await harnessContext.bus.emit(mcpAppDiscovered, discoveredApp());

    const running = harnessContext.bus.invoke(mcpAppsInvokeTool, {
      appInstanceId,
      invocationId,
      requestId: 7,
      toolName: "echo",
      arguments: {},
    });
    await vi.waitFor(() => expect(invokeTool).toHaveBeenCalledOnce());
    await expect(
      harnessContext.bus.invoke(mcpAppsCancelTool, {
        appInstanceId,
        invocationId,
      }),
    ).resolves.toEqual({ cancelled: true });
    await expect(running).rejects.toThrow("cancelled");
    expect(
      harnessContext.emitted.get(mcpAppToolResponded.id)?.at(-1),
    ).toMatchObject({
      requestId: 7,
      response: { status: "cancelled" },
    });
    await harness.deactivate();
  });

  it("maps denied tool invocations to forbidden responses", async () => {
    const denied = Object.assign(new Error("Tool invocation denied"), {
      code: "denied",
    });
    const harnessContext = createContext(async () => {
      throw denied;
    });
    const harness = await createTestHarness(
      mcpAppsPlugin,
      harnessContext.context,
    );
    await harnessContext.bus.emit(mcpAppDiscovered, discoveredApp());

    await expect(
      harnessContext.bus.invoke(mcpAppsInvokeTool, {
        appInstanceId,
        invocationId,
        requestId: "request-denied",
        toolName: "echo",
        arguments: {},
      }),
    ).rejects.toThrow("denied");
    expect(
      harnessContext.emitted.get(mcpAppToolResponded.id)?.at(-1),
    ).toMatchObject({
      response: {
        status: "failed",
        error: { code: "forbidden", message: "Tool invocation denied" },
      },
    });
    await harness.deactivate();
  });
});
