import {
  mockChannelInject,
  mockChannelSend,
  type CommandDefinition,
} from "@borg/contracts";
import type {
  ChannelAdapter,
  ChannelInboundDraft,
  ChannelSendRequest,
  PluginBus,
  PluginContext,
} from "@borg/plugin-sdk";
import { createTestHarness } from "@borg/plugin-sdk";
import { describe, expect, it } from "vitest";
import plugin, {
  MOCK_CHANNEL_ADAPTER_ID,
  MOCK_CHANNEL_DESTINATION,
  MockChannelDisposedError,
  MockChannelNotStartedError,
  MockChannelRuntime,
} from "../src/main";

type CommandHandler = (
  input: unknown,
  signal: AbortSignal,
) => unknown | Promise<unknown>;

function createChannelFixture() {
  const handlers = new Map<string, CommandHandler>();
  let adapter: ChannelAdapter | undefined;
  const bus = {
    handle: (
      command: { readonly id: string },
      handler: CommandHandler,
    ) => {
      handlers.set(command.id, handler);
      return {
        dispose: () => {
          if (handlers.get(command.id) === handler) {
            handlers.delete(command.id);
          }
        },
      };
    },
    invoke: async (
      command: { readonly id: string },
      input: unknown,
      options?: { readonly signal?: AbortSignal | undefined },
    ) => {
      const handler = handlers.get(command.id);
      if (!handler) {
        throw new Error(`Command ${command.id} is unavailable`);
      }
      return handler(
        input,
        options?.signal ?? new AbortController().signal,
      );
    },
    provides: (command: { readonly id: string }) => handlers.has(command.id),
    emit: async () => undefined,
    on: () => ({ dispose: () => undefined }),
  } as unknown as PluginBus;
  const context = {
    pluginId: "borg.channel.mock",
    signal: new AbortController().signal,
    bus,
    channels: {
      register: (registered: ChannelAdapter) => {
        adapter = registered;
        return {
          dispose: () => {
            if (adapter === registered) {
              adapter = undefined;
            }
          },
        };
      },
      send: async (request: ChannelSendRequest) => {
        if (!adapter) {
          throw new Error("Channel adapter was not registered");
        }
        const receipt = await adapter.send(request);
        return {
          status: "sent" as const,
          messageId: crypto.randomUUID(),
          ...receipt,
        };
      },
    },
  } as unknown as PluginContext;
  return {
    context,
    adapter: () => {
      if (!adapter) {
        throw new Error("Channel adapter was not registered");
      }
      return adapter;
    },
    invoke: <T>(
      command: CommandDefinition,
      input: unknown,
      signal?: AbortSignal,
    ): Promise<T> =>
      bus.invoke(command, input, signal ? { signal } : undefined) as Promise<T>,
    hasCommand: (id: string) => handlers.has(id),
  };
}

function sendRequest(
  overrides: Partial<ChannelSendRequest> = {},
): ChannelSendRequest {
  return {
    adapterId: MOCK_CHANNEL_ADAPTER_ID,
    destinationId: MOCK_CHANNEL_DESTINATION,
    text: "hello from borg",
    idempotencyKey: "send-1",
    ...overrides,
  };
}

async function activateChannel() {
  const fixture = createChannelFixture();
  const harness = await createTestHarness(plugin, fixture.context);
  return { ...fixture, harness };
}

describe("MockChannelRuntime", () => {
  it("records outbound sends by idempotency key and dedupes concurrent duplicates", async () => {
    const runtime = new MockChannelRuntime();
    const request = sendRequest({ idempotencyKey: "dup-key" });
    const [first, second] = await Promise.all([
      runtime.send(request),
      runtime.send(request),
    ]);
    expect(first).toEqual(second);
    expect(first.externalId).toBe("mock:dup-key");
    expect(Date.parse(first.sentAt)).not.toBeNaN();
    expect(runtime.listOutbound()).toHaveLength(1);
    const replay = await runtime.send(request);
    expect(replay).toEqual(first);
    expect(runtime.listOutbound()).toHaveLength(1);
    runtime.dispose();
  });

  it("captures scoped ingest and clears it on start disposal", async () => {
    const runtime = new MockChannelRuntime();
    const drafts: ChannelInboundDraft[] = [];
    const started = runtime.start({
      ingest: (draft) => {
        drafts.push(draft);
      },
      signal: new AbortController().signal,
    });
    const accepted = await runtime.inject({
      text: "inbound draft",
      sender: "tester",
      classification: "public",
    });
    expect(accepted.accepted).toBe(true);
    expect(drafts).toEqual([
      expect.objectContaining({
        text: "inbound draft",
        destinationId: MOCK_CHANNEL_DESTINATION,
        externalId: accepted.externalId,
        sender: "tester",
        classification: "public",
        receivedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      }),
    ]);
    started.dispose();
    await expect(runtime.inject({ text: "stale" })).rejects.toBeInstanceOf(
      MockChannelNotStartedError,
    );
    expect(drafts).toHaveLength(1);
    runtime.dispose();
  });
});

describe("borg.channel.mock", () => {
  it("registers a public default adapter and injects a typed inbound draft", async () => {
    const { adapter, invoke, harness } = await activateChannel();
    expect(adapter().id).toBe(MOCK_CHANNEL_ADAPTER_ID);
    expect(adapter().capacity).toBe("public");
    expect([...adapter().destinations]).toEqual([MOCK_CHANNEL_DESTINATION]);

    const drafts: ChannelInboundDraft[] = [];
    const started = await adapter().start?.({
      ingest: (draft) => {
        drafts.push(draft);
      },
      signal: new AbortController().signal,
    });
    const result = await invoke<{ accepted: true; externalId: string }>(
      mockChannelInject,
      {
        text: "graph trigger please",
        externalId: "stable-ext-1",
        sender: "fixture",
        classification: "internal",
      },
    );
    expect(result).toEqual({
      accepted: true,
      externalId: "stable-ext-1",
    });
    expect(drafts).toEqual([
      expect.objectContaining({
        text: "graph trigger please",
        destinationId: "default",
        externalId: "stable-ext-1",
        sender: "fixture",
        classification: "internal",
      }),
    ]);
    started?.dispose();
    await harness.deactivate();
  });

  it("generates an external id and default destination when omitted", async () => {
    const { adapter, invoke, harness } = await activateChannel();
    const drafts: ChannelInboundDraft[] = [];
    await adapter().start?.({
      ingest: (draft) => {
        drafts.push(draft);
      },
      signal: new AbortController().signal,
    });
    const result = await invoke<{ accepted: true; externalId: string }>(
      mockChannelInject,
      { text: "no extras" },
    );
    expect(result).toEqual({
      accepted: true,
      externalId: expect.stringMatching(/^mock-in:/),
    });
    expect(drafts[0]).toMatchObject({
      destinationId: "default",
      externalId: result.externalId,
    });
    await harness.deactivate();
  });

  it("returns a stable adapter receipt and does not duplicate concurrent outbound sends", async () => {
    const { adapter, invoke, harness } = await activateChannel();
    const request = sendRequest({ idempotencyKey: "plugin-dup" });
    const [first, second] = await Promise.all([
      adapter().send(request),
      adapter().send(request),
    ]);
    expect(first.externalId).toBe("mock:plugin-dup");
    expect(first).toEqual(second);
    expect(await adapter().send(request)).toEqual(first);
    await expect(
      invoke(mockChannelSend, {
        destinationId: MOCK_CHANNEL_DESTINATION,
        text: "through the kernel facade",
        classification: "confidential",
        idempotencyKey: "command-send",
      }),
    ).resolves.toMatchObject({
      status: "sent",
      externalId: "mock:command-send",
    });
    await harness.deactivate();
  });

  it("prevents stale inject after start disposal or plugin deactivation", async () => {
    const { adapter, invoke, hasCommand, harness } = await activateChannel();
    const registered = adapter();
    const drafts: ChannelInboundDraft[] = [];
    const started = await registered.start?.({
      ingest: (draft) => {
        drafts.push(draft);
      },
      signal: new AbortController().signal,
    });
    started?.dispose();
    await expect(invoke(mockChannelInject, { text: "after start" })).rejects.toBeInstanceOf(
      MockChannelNotStartedError,
    );

    const restarted = await registered.start?.({
      ingest: (draft) => {
        drafts.push(draft);
      },
      signal: new AbortController().signal,
    });
    await invoke(mockChannelInject, { text: "live again", externalId: "live-1" });
    expect(drafts.map((draft) => draft.externalId)).toEqual(["live-1"]);
    restarted?.dispose();

    await harness.deactivate();
    expect(hasCommand(mockChannelInject.id)).toBe(false);
    await expect(invoke(mockChannelInject, { text: "after stop" })).rejects.toThrow(
      /unavailable/,
    );
    await expect(
      registered.send(sendRequest({ idempotencyKey: "after-stop" })),
    ).rejects.toBeInstanceOf(MockChannelDisposedError);
  });
});
