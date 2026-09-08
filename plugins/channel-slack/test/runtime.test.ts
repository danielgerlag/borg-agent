import type { ChannelInboundDraft } from "@borg/plugin-sdk";
import { describe, expect, it } from "vitest";
import type { SocketPolicy } from "../src/gateway";
import { SlackRestClient } from "../src/rest";
import { SlackSocketRuntime } from "../src/runtime";
import {
  FakeWebSockets,
  ManualClock,
  createFakeHttp,
  jsonResponse,
  settle,
  type LogRecord,
  type RecordedRequest,
} from "./harness";

const BOT_TOKEN = "xoxb-super-secret-bot-token";
const APP_TOKEN = "xapp-super-secret-app-token";
const CHANNEL_ID = "C01234567";
const USER_ID = "U01234567";
const SOCKET_URL = "wss://wss-primary.slack.com/link?ticket=test-ticket";

const policy: SocketPolicy = {
  allowedChannelIds: [CHANNEL_ID],
};

function createFixture(
  options: {
    readonly appToken?: string | undefined;
    readonly fetch?:
      | ((request: RecordedRequest) => Response | Promise<Response>)
      | undefined;
  } = {},
) {
  const clock = new ManualClock();
  const webSockets = new FakeWebSockets();
  const drafts: ChannelInboundDraft[] = [];
  const logs: LogRecord[] = [];
  const appToken = "appToken" in options ? options.appToken : APP_TOKEN;

  const { http, requests } = createFakeHttp(
    options.fetch ??
      (() => jsonResponse(200, { ok: true, url: SOCKET_URL })),
  );
  const rest = new SlackRestClient({
    http,
    readBotToken: async () => BOT_TOKEN,
    readAppToken: async () => appToken,
    sleep: async () => undefined,
  });
  const runtime = new SlackSocketRuntime({
    webSockets,
    rest,
    ingest: (draft) => {
      drafts.push(draft);
    },
    policy,
    logger: {
      debug: (message, metadata) => logs.push({ level: "debug", message, metadata }),
      info: (message, metadata) => logs.push({ level: "info", message, metadata }),
      warn: (message, metadata) => logs.push({ level: "warn", message, metadata }),
      error: (message, metadata) => logs.push({ level: "error", message, metadata }),
    },
    clock,
    random: () => 0.5,
  });
  const host = new AbortController();
  return {
    clock,
    webSockets,
    drafts,
    logs,
    requests,
    runtime,
    host,
    start: async (): Promise<void> => {
      void runtime.run(host.signal);
      await settle();
    },
  };
}

const hello = JSON.stringify({ type: "hello", num_connections: 1 });

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

describe("slack socket runtime", () => {
  it("opens a fresh connections.open url and ingests through the scoped callback", async () => {
    const fixture = createFixture();
    await fixture.start();

    expect(fixture.requests.map((request) => request.url)).toEqual([
      "https://slack.com/api/apps.connections.open",
    ]);
    expect(fixture.requests[0]?.headers.Authorization).toBe(`Bearer ${APP_TOKEN}`);
    expect(fixture.requests[0]?.redirect).toBe("error");
    const connection = fixture.webSockets.last;
    expect(connection.url).toBe(SOCKET_URL);
    expect(connection.url).not.toContain(BOT_TOKEN);
    expect(connection.url).not.toContain(APP_TOKEN);
    expect(connection.maxMessageBytes).toBe(262_144);

    connection.socket.deliver(hello);
    await settle();
    expect(fixture.runtime.snapshot()).toMatchObject({
      phase: "ready",
      connected: true,
    });
    expect(
      fixture.logs.some(
        (entry) => entry.message === "Slack Socket Mode: received hello",
      ),
    ).toBe(true);

    connection.socket.deliver(eventsApi());
    await settle();
    expect(connection.socket.sent).toEqual([
      JSON.stringify({ envelope_id: "env-1" }),
    ]);
    expect(fixture.drafts).toEqual([
      {
        text: "hello borg",
        destinationId: CHANNEL_ID,
        externalId: "1710000000.000100",
        sender: USER_ID,
        classification: "internal",
        metadata: {
          source: "slack",
          ts: "1710000000.000100",
          channelId: CHANNEL_ID,
          userId: USER_ID,
        },
      },
    ]);
  });

  it("resolves whenReady once hello arrives", async () => {
    const fixture = createFixture();
    await fixture.start();
    const waiting = fixture.runtime.whenReady(5_000);
    fixture.webSockets.last.socket.deliver(hello);
    await expect(waiting).resolves.toBeUndefined();
  });

  it("reconnects on disconnect with a fresh connections.open", async () => {
    const fixture = createFixture();
    await fixture.start();
    const first = fixture.webSockets.last.socket;
    first.deliver(hello);
    await settle();

    first.deliver(JSON.stringify({ type: "disconnect", reason: "warning" }));
    await settle();
    expect(first.closeCalls.at(-1)?.reason).toBe("Slack requested a disconnect");
    expect(fixture.runtime.state.phase).toBe("backoff");

    fixture.clock.advance(60_000);
    await settle();
    expect(fixture.webSockets.connections).toHaveLength(2);
    expect(fixture.requests).toHaveLength(2);
    expect(fixture.requests.every((request) =>
      request.url.endsWith("/apps.connections.open"),
    )).toBe(true);
    expect(first.messageHandlerCount).toBe(0);

    first.deliver(eventsApi({ text: "zombie" }));
    await settle();
    expect(fixture.drafts).toEqual([]);
  });

  it("reconnects when Slack never sends Hello", async () => {
    const fixture = createFixture();
    await fixture.start();
    const socket = fixture.webSockets.last.socket;

    fixture.clock.advance(15_000);
    await settle();

    expect(socket.closeCalls.at(-1)).toEqual({
      code: 4_000,
      reason: "Socket Mode hello timed out",
    });
    expect(fixture.runtime.state.phase).toBe("backoff");
  });

  it("ignores every callback from a socket that was already abandoned", async () => {
    const fixture = createFixture();
    await fixture.start();
    const first = fixture.webSockets.last.socket;
    first.deliver(hello);
    await settle();

    first.deliverClose(1_006);
    await settle();
    fixture.clock.advance(60_000);
    await settle();
    expect(fixture.webSockets.connections).toHaveLength(2);
    const second = fixture.webSockets.last.socket;

    first.deliver(eventsApi({ text: "late" }));
    first.deliverError("late failure");
    await settle();

    expect(fixture.drafts).toEqual([]);
    expect(fixture.runtime.state.phase).not.toBe("fatal");
    expect(first.messageHandlerCount).toBe(0);
    expect(second.messageHandlerCount).toBe(1);
  });

  it("closes the socket and stops timers when the host aborts", async () => {
    const fixture = createFixture();
    await fixture.start();
    const socket = fixture.webSockets.last.socket;
    socket.deliver(hello);
    await settle();

    fixture.host.abort(new Error("deactivated"));
    await settle();

    expect(socket.closeCalls).toEqual([{ code: 1_000, reason: "stopped" }]);
    expect(socket.disposed).toBe(true);
    expect(fixture.clock.pending).toBe(0);
    expect(fixture.runtime.state.phase).toBe("idle");

    socket.deliver(eventsApi());
    fixture.clock.advance(600_000);
    await settle();
    expect(fixture.drafts).toEqual([]);
    expect(fixture.webSockets.connections).toHaveLength(1);
  });

  it("does not reconnect after stop, even if a timer was already armed", async () => {
    const fixture = createFixture();
    await fixture.start();
    const socket = fixture.webSockets.last.socket;
    socket.deliver(hello);
    await settle();
    socket.deliverClose(1_006);
    await settle();
    expect(fixture.runtime.state.phase).toBe("backoff");

    await fixture.runtime.stop();
    fixture.clock.advance(600_000);
    await settle();

    expect(fixture.webSockets.connections).toHaveLength(1);
  });

  it("stops permanently when the app token is missing", async () => {
    const fixture = createFixture({ appToken: undefined });
    await fixture.start();

    expect(fixture.webSockets.connections).toHaveLength(0);
    expect(fixture.runtime.state.phase).toBe("fatal");
    expect(fixture.runtime.state.error).toBe("Slack app-level token is not saved");
    fixture.clock.advance(600_000);
    await settle();
    expect(fixture.webSockets.connections).toHaveLength(0);
  });

  it("backs off when the socket cannot be opened", async () => {
    const fixture = createFixture();
    fixture.webSockets.failNextConnect = "socket limit reached";
    await fixture.start();

    expect(fixture.runtime.state.phase).toBe("backoff");
    fixture.clock.advance(60_000);
    await settle();
    expect(fixture.webSockets.connections).toHaveLength(1);
  });

  it("keeps tokens out of every log record", async () => {
    const fixture = createFixture({
      fetch: () => jsonResponse(401, { ok: false, error: "invalid_auth" }),
    });
    await fixture.start();
    fixture.clock.advance(600_000);
    await settle();

    expect(fixture.runtime.state.phase).toBe("fatal");
    const serialized = JSON.stringify(fixture.logs);
    expect(serialized).not.toContain(BOT_TOKEN);
    expect(serialized).not.toContain(APP_TOKEN);
    expect(serialized).toContain("Slack rejected the app token");
  });
});
