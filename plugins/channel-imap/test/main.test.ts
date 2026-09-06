import { imapChannelInject, type CommandDefinition } from "@borg/contracts";
import type {
  ChannelAdapter,
  ChannelInboundDraft,
  PluginBus,
  PluginContext,
} from "@borg/plugin-sdk";
import { createTestHarness } from "@borg/plugin-sdk";
import { describe, expect, it } from "vitest";
import plugin, {
  IMAP_CHANNEL_ADAPTER_ID,
  IMAP_DEFAULT_MAILBOX,
  IMAP_PASSWORD_SECRET_KEY,
  ImapFakeTransport,
} from "../src/main";

type CommandHandler = (
  input: unknown,
  signal: AbortSignal,
) => unknown | Promise<unknown>;

function createImapFixture(options?: {
  readonly enabled?: boolean;
  readonly host?: string;
  readonly username?: string;
  readonly password?: string;
}) {
  const handlers = new Map<string, CommandHandler>();
  let adapter: ChannelAdapter | undefined;
  const secrets = new Map<string, string>();
  if (options?.password) {
    secrets.set(IMAP_PASSWORD_SECRET_KEY, options.password);
  }
  let config: Record<string, unknown> = {
    enabled: options?.enabled === true,
    host: options?.host ?? "",
    username: options?.username ?? "",
    mailbox: IMAP_DEFAULT_MAILBOX,
  };
  const listeners = new Set<(document: Record<string, unknown>) => void>();
  const bus = {
    handle: (command: { readonly id: string }, handler: CommandHandler) => {
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
      invokeOptions?: { readonly signal?: AbortSignal | undefined },
    ) => {
      const handler = handlers.get(command.id);
      if (!handler) {
        throw new Error(`Command ${command.id} is unavailable`);
      }
      return handler(
        input,
        invokeOptions?.signal ?? new AbortController().signal,
      );
    },
    provides: (command: { readonly id: string }) => handlers.has(command.id),
    emit: async () => undefined,
    on: () => ({ dispose: () => undefined }),
  } as unknown as PluginBus;
  const context = {
    pluginId: "borg.channel.imap",
    signal: new AbortController().signal,
    bus,
    config: {
      get: async () => config,
      update: async (patch: Readonly<Record<string, unknown>>) => {
        config = { ...config, ...patch };
        for (const listener of [...listeners]) {
          await listener(config);
        }
        return config;
      },
      watch: (handler: (document: Record<string, unknown>) => void) => {
        listeners.add(handler);
        return {
          dispose: () => {
            listeners.delete(handler);
          },
        };
      },
    },
    secrets: {
      get: async (key: string) => secrets.get(key),
      has: async (key: string) => secrets.has(key),
      set: async (key: string, value: string) => {
        secrets.set(key, value);
      },
      delete: async (key: string) => {
        secrets.delete(key);
      },
    },
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
    },
    sandbox: {
      run: async () => {
        throw new Error("Sandbox runs are unused");
      },
    },
  } as unknown as PluginContext;
  return {
    context,
    adapter: () => adapter,
    invoke: <T>(
      command: CommandDefinition,
      input: unknown,
      signal?: AbortSignal,
    ): Promise<T> =>
      bus.invoke(command, input, signal ? { signal } : undefined) as Promise<T>,
  };
}

describe("ImapFakeTransport", () => {
  it("injects inbound drafts into the active ingest", async () => {
    const runtime = new ImapFakeTransport();
    const drafts: ChannelInboundDraft[] = [];
    runtime.start({
      ingest: (draft) => {
        drafts.push(draft);
      },
      signal: new AbortController().signal,
    });
    const accepted = await runtime.inject({
      text: "hello mailbox",
      sender: "alice@example.com",
    });
    expect(accepted.accepted).toBe(true);
    expect(drafts).toEqual([
      expect.objectContaining({
        text: "hello mailbox",
        destinationId: IMAP_DEFAULT_MAILBOX,
        externalId: accepted.externalId,
        sender: "alice@example.com",
      }),
    ]);
    runtime.dispose();
  });
});

describe("borg.channel.imap", () => {
  it("stays unregistered until enabled with host, username, and password", async () => {
    const fixture = createImapFixture();
    const harness = await createTestHarness(plugin, fixture.context);
    expect(fixture.adapter()).toBeUndefined();
    await fixture.context.config.update({
      enabled: true,
      host: "imap.example.com",
      username: "borg@example.com",
    });
    expect(fixture.adapter()).toBeUndefined();
    await fixture.context.secrets.set(IMAP_PASSWORD_SECRET_KEY, "secret");
    await fixture.context.config.update({ enabled: true });
    expect(fixture.adapter()?.id).toBe(IMAP_CHANNEL_ADAPTER_ID);
    expect(fixture.adapter()?.capacity).toBe("private");
    await harness.deactivate();
  });

  it("injects a typed inbound draft through the registered adapter", async () => {
    const fixture = createImapFixture({
      enabled: true,
      host: "imap.example.com",
      username: "borg@example.com",
      password: "secret",
    });
    const harness = await createTestHarness(plugin, fixture.context);
    const adapter = fixture.adapter();
    expect(adapter?.id).toBe(IMAP_CHANNEL_ADAPTER_ID);
    const drafts: ChannelInboundDraft[] = [];
    await adapter?.start?.({
      ingest: (draft) => {
        drafts.push(draft);
      },
      signal: new AbortController().signal,
    });
    const result = await fixture.invoke<{
      accepted: true;
      externalId: string;
    }>(imapChannelInject, {
      text: "from imap",
      externalId: "imap-ext-1",
      sender: "bob@example.com",
      classification: "internal",
    });
    expect(result).toEqual({
      accepted: true,
      externalId: "imap-ext-1",
    });
    expect(drafts).toEqual([
      expect.objectContaining({
        text: "from imap",
        destinationId: IMAP_DEFAULT_MAILBOX,
        externalId: "imap-ext-1",
        sender: "bob@example.com",
        classification: "internal",
      }),
    ]);
    await harness.deactivate();
  });

  it("re-registers destinations when the mailbox changes", async () => {
    const fixture = createImapFixture({
      enabled: true,
      host: "imap.example.com",
      username: "borg@example.com",
      password: "secret",
    });
    const harness = await createTestHarness(plugin, fixture.context);
    await fixture.context.config.update({ mailbox: "Archive" });
    const adapter = fixture.adapter();
    expect(adapter?.destinations).toEqual(["Archive"]);
    const drafts: ChannelInboundDraft[] = [];
    await adapter?.start?.({
      ingest: (draft) => {
        drafts.push(draft);
      },
      signal: new AbortController().signal,
    });
    await fixture.invoke(imapChannelInject, { text: "archived" });
    expect(drafts[0]?.destinationId).toBe("Archive");
    await harness.deactivate();
  });
});
