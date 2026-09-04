import {
  discordChannelDisconnect,
  discordChannelGetStatus,
  discordChannelVerify,
  type DiscordChannelStatus,
} from "@borg/contracts";
import { createTestHarness } from "@borg/plugin-sdk";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import discordPlugin from "../src/main";
import { DISCORD_ADAPTER_ID, DISCORD_TOKEN_SECRET_KEY } from "../src/protocol";
import {
  createDiscordHarness,
  jsonResponse,
  settle,
  type RecordedRequest,
} from "./harness";

const TOKEN = "MTIzNDU2Nzg5.super-secret-token";
const CHANNEL_ID = "100000000000000001";
const OTHER_CHANNEL_ID = "100000000000000002";
const BOT_USER_ID = "300000000000000001";

function discordRoutes(
  overrides: Readonly<
    Record<string, (request: RecordedRequest) => Response | Promise<Response>>
  > = {},
) {
  return (request: RecordedRequest): Response | Promise<Response> => {
    for (const [suffix, handler] of Object.entries(overrides)) {
      if (request.url.endsWith(suffix)) {
        return handler(request);
      }
    }
    if (request.url.endsWith("/users/@me")) {
      return jsonResponse(200, { id: BOT_USER_ID, username: "borg" });
    }
    if (request.url.endsWith("/gateway/bot")) {
      return jsonResponse(200, {
        url: "wss://gateway.discord.gg",
        session_start_limit: { remaining: 100, reset_after: 0 },
      });
    }
    if (request.url.includes("/messages")) {
      return jsonResponse(200, { id: "700000000000000001" });
    }
    return jsonResponse(404, { message: "unexpected" });
  };
}

describe("borg.channel.discord plugin", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  async function activate(
    options: Parameters<typeof createDiscordHarness>[0] = {},
  ) {
    const harness = createDiscordHarness({
      fetch: discordRoutes(),
      ...options,
    });
    const active = await createTestHarness(discordPlugin, harness.context);
    cleanups.push(async () => {
      await active.deactivate();
    });
    await settle();
    return harness;
  }

  it("agrees with its static manifest", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../borg.plugin.json", import.meta.url), "utf8"),
    ) as Record<string, unknown>;
    expect(discordPlugin).toMatchObject({
      id: manifest.id,
      version: manifest.version,
      permissions: manifest.permissions,
      contributes: manifest.contributes,
    });
    expect(manifest.permissions).toEqual([
      "channels.register",
      "network:dynamic",
      "network:websocket",
      "runtime.background",
      "secrets:read",
      "secrets:write",
      "ui.settings",
    ]);
  });

  it("stays unregistered until it is enabled with a token and a channel", async () => {
    const harness = await activate();
    expect(harness.registrations).toHaveLength(0);
    expect(
      await harness.invoke<DiscordChannelStatus>(discordChannelGetStatus, {}),
    ).toEqual({
      hasToken: false,
      connected: false,
      gatewayState: "idle",
    });
  });

  it("explains itself when the channel is enabled without a token", async () => {
    const harness = await activate({
      config: { enabled: true, allowedChannelIds: [CHANNEL_ID] },
    });
    expect(harness.registrations).toHaveLength(0);
    expect(
      await harness.invoke<DiscordChannelStatus>(discordChannelGetStatus, {}),
    ).toEqual({
      hasToken: false,
      connected: false,
      gatewayState: "idle",
      error: "Discord bot token is not saved",
    });
  });

  it("registers a private adapter whose destinations are the allowed channels", async () => {
    const harness = await activate({
      secrets: { [DISCORD_TOKEN_SECRET_KEY]: TOKEN },
      config: { enabled: true, allowedChannelIds: [CHANNEL_ID] },
    });

    expect(harness.registrations).toHaveLength(1);
    expect(harness.activeRegistration.adapter).toMatchObject({
      id: DISCORD_ADAPTER_ID,
      capacity: "private",
      destinations: [CHANNEL_ID],
    });
  });

  it("re-registers and restarts the gateway when the channel list changes", async () => {
    const harness = await activate({
      secrets: { [DISCORD_TOKEN_SECRET_KEY]: TOKEN },
      config: { enabled: true, allowedChannelIds: [CHANNEL_ID] },
    });
    const first = harness.activeRegistration;
    const firstSocket = harness.webSockets.last.socket;

    await harness.updateConfig({
      allowedChannelIds: [CHANNEL_ID, OTHER_CHANNEL_ID],
    });
    await settle();

    expect(first.disposed).toBe(true);
    expect(firstSocket.closeCalls).toEqual([{ code: 1_000, reason: "stopped" }]);
    expect(firstSocket.messageHandlerCount).toBe(0);
    expect(harness.registrations).toHaveLength(2);
    expect(harness.activeRegistration.adapter.destinations).toEqual([
      CHANNEL_ID,
      OTHER_CHANNEL_ID,
    ]);
    expect(harness.webSockets.connections).toHaveLength(2);

    firstSocket.deliver(
      JSON.stringify({
        op: 0,
        s: 5,
        t: "MESSAGE_CREATE",
        d: {
          id: "500000000000000009",
          channel_id: CHANNEL_ID,
          author: { id: "400000000000000001" },
          content: "zombie",
        },
      }),
    );
    await settle();
    expect(first.drafts).toEqual([]);
  });

  it("tears the adapter down when the channel is disabled", async () => {
    const harness = await activate({
      secrets: { [DISCORD_TOKEN_SECRET_KEY]: TOKEN },
      config: { enabled: true, allowedChannelIds: [CHANNEL_ID] },
    });
    const socket = harness.webSockets.last.socket;

    await harness.updateConfig({ enabled: false });
    await settle();

    expect(harness.registrations.every((entry) => entry.disposed)).toBe(true);
    expect(socket.disposed).toBe(true);
  });

  it("delivers an allow-listed gateway message to the scoped ingest", async () => {
    const harness = await activate({
      secrets: { [DISCORD_TOKEN_SECRET_KEY]: TOKEN },
      config: { enabled: true, allowedChannelIds: [CHANNEL_ID] },
    });
    const registration = harness.activeRegistration;
    const socket = harness.webSockets.last.socket;

    socket.deliver(JSON.stringify({ op: 10, d: { heartbeat_interval: 40_000 } }));
    await settle();
    socket.deliver(
      JSON.stringify({
        op: 0,
        s: 1,
        t: "READY",
        d: {
          session_id: "session-1",
          user: { id: BOT_USER_ID },
          resume_gateway_url: "wss://gateway-us-east1-b.discord.gg",
        },
      }),
    );
    await settle();
    socket.deliver(
      JSON.stringify({
        op: 0,
        s: 2,
        t: "MESSAGE_CREATE",
        d: {
          id: "500000000000000001",
          channel_id: CHANNEL_ID,
          author: { id: "400000000000000001", username: "ada" },
          content: "hello borg",
        },
      }),
    );
    await settle();

    expect(registration.drafts).toHaveLength(1);
    expect(registration.drafts[0]).toMatchObject({
      destinationId: CHANNEL_ID,
      externalId: "500000000000000001",
      classification: "internal",
      text: "hello borg",
    });

    socket.deliver(
      JSON.stringify({
        op: 0,
        s: 3,
        t: "MESSAGE_CREATE",
        d: {
          id: "500000000000000002",
          channel_id: CHANNEL_ID,
          author: { id: BOT_USER_ID, username: "borg" },
          content: "my own reply",
        },
      }),
    );
    await settle();
    expect(registration.drafts).toHaveLength(1);
  });

  it("sends only to configured destinations", async () => {
    const harness = await activate({
      secrets: { [DISCORD_TOKEN_SECRET_KEY]: TOKEN },
      config: { enabled: true, allowedChannelIds: [CHANNEL_ID] },
    });
    const adapter = harness.activeRegistration.adapter;

    await expect(
      adapter.send({
        adapterId: DISCORD_ADAPTER_ID,
        destinationId: CHANNEL_ID,
        text: "ping",
        idempotencyKey: "key-1",
      }),
    ).resolves.toMatchObject({ externalId: "700000000000000001" });

    const post = harness.requests.find((request) => request.method === "POST");
    expect(post?.url).toBe(
      `https://discord.com/api/v10/channels/${CHANNEL_ID}/messages`,
    );
    expect(post?.headers.Authorization).toBe(`Bot ${TOKEN}`);
    expect(post?.url).not.toContain(TOKEN);

    await expect(
      adapter.send({
        adapterId: DISCORD_ADAPTER_ID,
        destinationId: OTHER_CHANNEL_ID,
        text: "ping",
        idempotencyKey: "key-2",
      }),
    ).rejects.toThrow("Discord destination is not allow-listed");
    await expect(
      adapter.send({
        adapterId: DISCORD_ADAPTER_ID,
        destinationId: CHANNEL_ID,
        text: "ping",
        idempotencyKey: "key-3",
        attachments: [
          {
            id: "attachment-1",
            name: "note.txt",
            mimeType: "text/plain",
            size: 4,
          },
        ],
      }),
    ).rejects.toThrow("Discord attachment sending is not supported");
  });

  it("reports gateway status and verifies against Discord", async () => {
    const harness = await activate({
      secrets: { [DISCORD_TOKEN_SECRET_KEY]: TOKEN },
      config: { enabled: true, allowedChannelIds: [CHANNEL_ID] },
    });

    const beforeReady = await harness.invoke<DiscordChannelStatus>(
      discordChannelGetStatus,
      {},
    );
    expect(beforeReady).toMatchObject({ hasToken: true, connected: false });

    const verifying = harness.invoke<DiscordChannelStatus>(
      discordChannelVerify,
      {},
    );
    await settle();
    const socket = harness.webSockets.last.socket;
    socket.deliver(JSON.stringify({ op: 10, d: { heartbeat_interval: 40_000 } }));
    await settle();
    socket.deliver(
      JSON.stringify({
        op: 0,
        s: 1,
        t: "READY",
        d: {
          session_id: "session-1",
          user: { id: BOT_USER_ID },
          resume_gateway_url: "wss://gateway-us-east1-b.discord.gg",
        },
      }),
    );

    await expect(verifying).resolves.toMatchObject({
      hasToken: true,
      connected: true,
      botUserId: BOT_USER_ID,
      gatewayState: "ready",
    });
    expect(
      harness.requests.some((request) => request.url.endsWith("/users/@me")),
    ).toBe(true);
    expect(
      harness.requests.some((request) => request.url.endsWith("/gateway/bot")),
    ).toBe(true);
  });

  it("surfaces a rejected token from verify without leaking it", async () => {
    const harness = await activate({
      secrets: { [DISCORD_TOKEN_SECRET_KEY]: TOKEN },
      fetch: discordRoutes({
        "/users/@me": () => jsonResponse(401, { message: "401: Unauthorized" }),
      }),
    });

    const failure = await harness
      .invoke(discordChannelVerify, {})
      .catch((error: unknown) => error);
    expect((failure as Error).message).toBe("Discord rejected the bot token");
    expect(JSON.stringify(harness.logs)).not.toContain(TOKEN);
  });

  it("disconnect stops the gateway, clears the session, and stays down", async () => {
    const harness = await activate({
      secrets: { [DISCORD_TOKEN_SECRET_KEY]: TOKEN },
      config: { enabled: true, allowedChannelIds: [CHANNEL_ID] },
    });
    const socket = harness.webSockets.last.socket;
    socket.deliver(JSON.stringify({ op: 10, d: { heartbeat_interval: 40_000 } }));
    await settle();
    socket.deliver(
      JSON.stringify({
        op: 0,
        s: 1,
        t: "READY",
        d: {
          session_id: "session-1",
          user: { id: BOT_USER_ID },
          resume_gateway_url: "wss://gateway-us-east1-b.discord.gg",
        },
      }),
    );
    await settle();
    expect(harness.store.get("gateway/session")).toBeDefined();

    await expect(
      harness.invoke<DiscordChannelStatus>(discordChannelDisconnect, {}),
    ).resolves.toEqual({
      hasToken: true,
      connected: false,
      gatewayState: "idle",
    });
    expect(harness.store.get("gateway/session")).toBeUndefined();
    expect(harness.registrations.every((entry) => entry.disposed)).toBe(true);
    expect(harness.webSockets.connections).toHaveLength(1);
  });

  it("closes the socket and releases the adapter on deactivation", async () => {
    const harness = createDiscordHarness({
      fetch: discordRoutes(),
      secrets: { [DISCORD_TOKEN_SECRET_KEY]: TOKEN },
      config: { enabled: true, allowedChannelIds: [CHANNEL_ID] },
    });
    const active = await createTestHarness(discordPlugin, harness.context);
    await settle();
    const socket = harness.webSockets.last.socket;

    await active.deactivate();
    await settle();

    expect(socket.closeCalls).toEqual([{ code: 1_000, reason: "stopped" }]);
    expect(socket.disposed).toBe(true);
    expect(harness.registrations.every((entry) => entry.disposed)).toBe(true);
    expect(harness.spawned.every((controller) => controller.signal.aborted)).toBe(
      true,
    );
  });
});
