import {
  slackChannelDisconnect,
  slackChannelGetStatus,
  slackChannelVerify,
  type SlackChannelStatus,
} from "@borg/contracts";
import { createTestHarness } from "@borg/plugin-sdk";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import slackPlugin from "../src/main";
import {
  SLACK_ADAPTER_ID,
  SLACK_APP_TOKEN_SECRET_KEY,
  SLACK_BOT_TOKEN_SECRET_KEY,
} from "../src/protocol";
import {
  createSlackHarness,
  jsonResponse,
  settle,
  type RecordedRequest,
} from "./harness";

const BOT_TOKEN = "xoxb-super-secret-bot-token";
const APP_TOKEN = "xapp-super-secret-app-token";
const CHANNEL_ID = "C01234567";
const OTHER_CHANNEL_ID = "C01234568";
const BOT_USER_ID = "U0BOTUSER1";
const USER_ID = "U01234567";
const SOCKET_URL = "wss://wss-primary.slack.com/link?ticket=test-ticket";

function slackRoutes(
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
    if (request.url.endsWith("/auth.test")) {
      return jsonResponse(200, { ok: true, user_id: BOT_USER_ID });
    }
    if (request.url.endsWith("/apps.connections.open")) {
      return jsonResponse(200, { ok: true, url: SOCKET_URL });
    }
    if (request.url.endsWith("/chat.postMessage")) {
      return jsonResponse(200, { ok: true, ts: "1710000000.000200" });
    }
    return jsonResponse(404, { ok: false, error: "unexpected" });
  };
}

function hello(): string {
  return JSON.stringify({ type: "hello", num_connections: 1 });
}

function eventsApi(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "events_api",
    envelope_id: "env-1",
    payload: {
      event: {
        type: "message",
        channel: CHANNEL_ID,
        user: USER_ID,
        text: "hello borg",
        ts: "1710000000.000100",
        ...overrides,
      },
    },
  });
}

describe("borg.channel.slack plugin", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  async function activate(
    options: Parameters<typeof createSlackHarness>[0] = {},
  ) {
    const harness = createSlackHarness({
      fetch: slackRoutes(),
      ...options,
    });
    const active = await createTestHarness(slackPlugin, harness.context);
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
    expect(slackPlugin).toMatchObject({
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

  it("stays unregistered until it is enabled with both tokens and a channel", async () => {
    const harness = await activate();
    expect(harness.registrations).toHaveLength(0);
    expect(
      await harness.invoke<SlackChannelStatus>(slackChannelGetStatus, {}),
    ).toEqual({
      hasBotToken: false,
      hasAppToken: false,
      connected: false,
      socketState: "idle",
    });
  });

  it("explains itself when the channel is enabled without tokens", async () => {
    const harness = await activate({
      config: { enabled: true, allowedChannelIds: [CHANNEL_ID] },
    });
    expect(harness.registrations).toHaveLength(0);
    expect(
      await harness.invoke<SlackChannelStatus>(slackChannelGetStatus, {}),
    ).toEqual({
      hasBotToken: false,
      hasAppToken: false,
      connected: false,
      socketState: "idle",
      error: "Slack bot token is not saved",
    });
  });

  it("explains itself when only the bot token is saved", async () => {
    const harness = await activate({
      secrets: { [SLACK_BOT_TOKEN_SECRET_KEY]: BOT_TOKEN },
      config: { enabled: true, allowedChannelIds: [CHANNEL_ID] },
    });
    expect(harness.registrations).toHaveLength(0);
    expect(
      await harness.invoke<SlackChannelStatus>(slackChannelGetStatus, {}),
    ).toMatchObject({
      hasBotToken: true,
      hasAppToken: false,
      error: "Slack app-level token is not saved",
    });
  });

  it("registers a private adapter whose destinations are the allowed channels", async () => {
    const harness = await activate({
      secrets: {
        [SLACK_BOT_TOKEN_SECRET_KEY]: BOT_TOKEN,
        [SLACK_APP_TOKEN_SECRET_KEY]: APP_TOKEN,
      },
      config: { enabled: true, allowedChannelIds: [CHANNEL_ID] },
    });

    expect(harness.registrations).toHaveLength(1);
    expect(harness.activeRegistration.adapter).toMatchObject({
      id: SLACK_ADAPTER_ID,
      capacity: "private",
      destinations: [CHANNEL_ID],
    });
  });

  it("re-registers when the channel list changes", async () => {
    const harness = await activate({
      secrets: {
        [SLACK_BOT_TOKEN_SECRET_KEY]: BOT_TOKEN,
        [SLACK_APP_TOKEN_SECRET_KEY]: APP_TOKEN,
      },
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
  });

  it("tears the adapter down when the channel is disabled", async () => {
    const harness = await activate({
      secrets: {
        [SLACK_BOT_TOKEN_SECRET_KEY]: BOT_TOKEN,
        [SLACK_APP_TOKEN_SECRET_KEY]: APP_TOKEN,
      },
      config: { enabled: true, allowedChannelIds: [CHANNEL_ID] },
    });
    const socket = harness.webSockets.last.socket;

    await harness.updateConfig({ enabled: false });
    await settle();

    expect(harness.registrations.every((entry) => entry.disposed)).toBe(true);
    expect(socket.disposed).toBe(true);
  });

  it("delivers an allow-listed Socket Mode message to the scoped ingest", async () => {
    const harness = await activate({
      secrets: {
        [SLACK_BOT_TOKEN_SECRET_KEY]: BOT_TOKEN,
        [SLACK_APP_TOKEN_SECRET_KEY]: APP_TOKEN,
      },
      config: { enabled: true, allowedChannelIds: [CHANNEL_ID] },
    });
    const registration = harness.activeRegistration;
    const socket = harness.webSockets.last.socket;

    socket.deliver(hello());
    await settle();
    socket.deliver(eventsApi());
    await settle();

    expect(registration.drafts).toHaveLength(1);
    expect(registration.drafts[0]).toMatchObject({
      destinationId: CHANNEL_ID,
      externalId: "1710000000.000100",
      classification: "internal",
      text: "hello borg",
      sender: USER_ID,
    });
    expect(JSON.parse(socket.sent[0] ?? "{}")).toEqual({ envelope_id: "env-1" });

    socket.deliver(eventsApi({ bot_id: "B01234567", text: "bot noise", ts: "1.2" }));
    await settle();
    expect(registration.drafts).toHaveLength(1);

    socket.deliver(
      eventsApi({ channel: OTHER_CHANNEL_ID, text: "nope", ts: "1.3" }),
    );
    await settle();
    expect(registration.drafts).toHaveLength(1);
  });

  it("sends to the destination or the default send channel, and throws when disconnected", async () => {
    const harness = await activate({
      secrets: {
        [SLACK_BOT_TOKEN_SECRET_KEY]: BOT_TOKEN,
        [SLACK_APP_TOKEN_SECRET_KEY]: APP_TOKEN,
      },
      config: {
        enabled: true,
        allowedChannelIds: [CHANNEL_ID],
        defaultSendChannelId: CHANNEL_ID,
      },
    });
    const adapter = harness.activeRegistration.adapter;

    await expect(
      adapter.send({
        adapterId: SLACK_ADAPTER_ID,
        destinationId: CHANNEL_ID,
        text: "ping",
        idempotencyKey: "key-1",
      }),
    ).rejects.toThrow("Slack is not connected");

    harness.webSockets.last.socket.deliver(hello());
    await settle();

    await expect(
      adapter.send({
        adapterId: SLACK_ADAPTER_ID,
        destinationId: CHANNEL_ID,
        text: "ping",
        idempotencyKey: "key-2",
      }),
    ).resolves.toMatchObject({ externalId: "1710000000.000200" });

    const post = harness.requests.find((request) =>
      request.url.endsWith("/chat.postMessage"),
    );
    expect(post?.url).toBe("https://slack.com/api/chat.postMessage");
    expect(post?.headers.Authorization).toBe(`Bearer ${BOT_TOKEN}`);
    expect(post?.url).not.toContain(BOT_TOKEN);
    expect(post?.redirect).toBe("error");
    expect(post?.body).toBe(
      JSON.stringify({ channel: CHANNEL_ID, text: "ping" }),
    );

    await expect(
      adapter.send({
        adapterId: SLACK_ADAPTER_ID,
        destinationId: "",
        text: "fallback",
        idempotencyKey: "key-3",
      }),
    ).resolves.toMatchObject({ externalId: "1710000000.000200" });

    await expect(
      adapter.send({
        adapterId: SLACK_ADAPTER_ID,
        destinationId: OTHER_CHANNEL_ID,
        text: "ping",
        idempotencyKey: "key-4",
      }),
    ).rejects.toThrow("Slack destination is not allow-listed");
    await expect(
      adapter.send({
        adapterId: SLACK_ADAPTER_ID,
        destinationId: CHANNEL_ID,
        text: "ping",
        idempotencyKey: "key-5",
        attachments: [
          {
            id: "attachment-1",
            name: "note.txt",
            mimeType: "text/plain",
            size: 4,
          },
        ],
      }),
    ).rejects.toThrow("Slack attachment sending is not supported");
  });

  it("reports socket status and verifies against Slack", async () => {
    const harness = await activate({
      secrets: {
        [SLACK_BOT_TOKEN_SECRET_KEY]: BOT_TOKEN,
        [SLACK_APP_TOKEN_SECRET_KEY]: APP_TOKEN,
      },
      config: { enabled: true, allowedChannelIds: [CHANNEL_ID] },
    });

    const beforeReady = await harness.invoke<SlackChannelStatus>(
      slackChannelGetStatus,
      {},
    );
    expect(beforeReady).toMatchObject({
      hasBotToken: true,
      hasAppToken: true,
      connected: false,
    });
    expect(JSON.stringify(beforeReady)).not.toContain(BOT_TOKEN);
    expect(JSON.stringify(beforeReady)).not.toContain(APP_TOKEN);

    const verifying = harness.invoke<SlackChannelStatus>(
      slackChannelVerify,
      {},
    );
    await settle();
    const socket = harness.webSockets.last.socket;
    socket.deliver(hello());

    await expect(verifying).resolves.toMatchObject({
      hasBotToken: true,
      hasAppToken: true,
      connected: true,
      botUserId: BOT_USER_ID,
      socketState: "ready",
    });
    expect(
      harness.requests.some((request) => request.url.endsWith("/auth.test")),
    ).toBe(true);
    expect(
      harness.requests.some((request) =>
        request.url.endsWith("/apps.connections.open"),
      ),
    ).toBe(true);
  });

  it("surfaces a rejected token from verify without leaking it", async () => {
    const harness = await activate({
      secrets: {
        [SLACK_BOT_TOKEN_SECRET_KEY]: BOT_TOKEN,
        [SLACK_APP_TOKEN_SECRET_KEY]: APP_TOKEN,
      },
      fetch: slackRoutes({
        "/auth.test": () =>
          jsonResponse(200, { ok: false, error: "invalid_auth" }),
      }),
    });

    const failure = await harness
      .invoke(slackChannelVerify, {})
      .catch((error: unknown) => error);
    expect((failure as Error).message).toBe("Slack rejected the bot token");
    expect((failure as Error).message).not.toContain(BOT_TOKEN);
    expect(JSON.stringify(harness.logs)).not.toContain(BOT_TOKEN);
    expect(JSON.stringify(harness.logs)).not.toContain(APP_TOKEN);
  });

  it("disconnect stops the socket and stays down", async () => {
    const harness = await activate({
      secrets: {
        [SLACK_BOT_TOKEN_SECRET_KEY]: BOT_TOKEN,
        [SLACK_APP_TOKEN_SECRET_KEY]: APP_TOKEN,
      },
      config: { enabled: true, allowedChannelIds: [CHANNEL_ID] },
    });
    const socket = harness.webSockets.last.socket;
    socket.deliver(hello());
    await settle();

    await expect(
      harness.invoke<SlackChannelStatus>(slackChannelDisconnect, {}),
    ).resolves.toEqual({
      hasBotToken: true,
      hasAppToken: true,
      connected: false,
      socketState: "idle",
    });
    expect(harness.registrations.every((entry) => entry.disposed)).toBe(true);
    expect(harness.webSockets.connections).toHaveLength(1);
  });

  it("closes the socket and releases the adapter on deactivation", async () => {
    const harness = createSlackHarness({
      fetch: slackRoutes(),
      secrets: {
        [SLACK_BOT_TOKEN_SECRET_KEY]: BOT_TOKEN,
        [SLACK_APP_TOKEN_SECRET_KEY]: APP_TOKEN,
      },
      config: { enabled: true, allowedChannelIds: [CHANNEL_ID] },
    });
    const active = await createTestHarness(slackPlugin, harness.context);
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
