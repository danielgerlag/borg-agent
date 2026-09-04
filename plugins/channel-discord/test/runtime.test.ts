import type { ChannelInboundDraft } from "@borg/plugin-sdk";
import { describe, expect, it } from "vitest";
import type { GatewayPolicy, GatewaySessionRecord } from "../src/gateway";
import { DiscordRestClient } from "../src/rest";
import { DiscordGatewayRuntime } from "../src/runtime";
import type { GatewaySessionStore } from "../src/session-store";
import {
  FakeWebSockets,
  ManualClock,
  createFakeHttp,
  jsonResponse,
  settle,
  type LogRecord,
  type RecordedRequest,
} from "./harness";

const TOKEN = "MTIzNDU2Nzg5.super-secret-token";
const CHANNEL_ID = "100000000000000001";
const GUILD_ID = "200000000000000001";
const BOT_USER_ID = "300000000000000001";
const HUMAN_ID = "400000000000000001";
const DISCOVERY_URL = "wss://gateway.discord.gg";
const RESUME_URL = "wss://gateway-us-east1-b.discord.gg";

const policy: GatewayPolicy = {
  allowedGuildIds: [GUILD_ID],
  allowedChannelIds: [CHANNEL_ID],
  ignoreBots: true,
};

interface RuntimeFixtureOptions {
  readonly token?: string | undefined;
  readonly session?: GatewaySessionRecord | undefined;
  readonly delayFirstSave?: Promise<void> | undefined;
  readonly fetch?:
    | ((request: RecordedRequest) => Response | Promise<Response>)
    | undefined;
}

function createFixture(options: RuntimeFixtureOptions = {}) {
  const clock = new ManualClock();
  const webSockets = new FakeWebSockets();
  const drafts: ChannelInboundDraft[] = [];
  const saved: (GatewaySessionRecord | null)[] = [];
  const logs: LogRecord[] = [];
  let stored = options.session;
  const token = "token" in options ? options.token : TOKEN;

  const { http, requests } = createFakeHttp(
    options.fetch ??
      (() =>
        jsonResponse(200, {
          url: DISCOVERY_URL,
          session_start_limit: { remaining: 500, reset_after: 0 },
        })),
  );
  const rest = new DiscordRestClient({
    http,
    readToken: async () => token,
    sleep: async () => undefined,
  });
  const session: GatewaySessionStore = {
    load: async () => stored,
    save: async (record) => {
      if (options.delayFirstSave && saved.length === 0) {
        await options.delayFirstSave;
      }
      saved.push(record);
      stored = record ?? undefined;
    },
  };
  const runtime = new DiscordGatewayRuntime({
    webSockets,
    rest,
    readToken: async () => token,
    ingest: (draft) => {
      drafts.push(draft);
    },
    policy,
    session,
    logger: {
      debug: (message, metadata) => logs.push({ level: "debug", message, metadata }),
      info: (message, metadata) => logs.push({ level: "info", message, metadata }),
      warn: (message, metadata) => logs.push({ level: "warn", message, metadata }),
      error: (message, metadata) => logs.push({ level: "error", message, metadata }),
    },
    clock,
    random: () => 0.5,
    now: () => clock.now,
  });
  const host = new AbortController();
  return {
    clock,
    webSockets,
    drafts,
    saved,
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

const hello = JSON.stringify({ op: 10, d: { heartbeat_interval: 40_000 } });
const ready = JSON.stringify({
  op: 0,
  s: 1,
  t: "READY",
  d: {
    session_id: "session-1",
    user: { id: BOT_USER_ID },
    resume_gateway_url: RESUME_URL,
  },
});

function messageFrame(sequence: number, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    op: 0,
    s: sequence,
    t: "MESSAGE_CREATE",
    d: {
      id: "500000000000000001",
      channel_id: CHANNEL_ID,
      guild_id: GUILD_ID,
      author: { id: HUMAN_ID, username: "ada" },
      content: "hello borg",
      ...overrides,
    },
  });
}

describe("discord gateway runtime", () => {
  it("discovers, identifies, and ingests through the scoped callback", async () => {
    const fixture = createFixture();
    await fixture.start();

    expect(fixture.requests.map((request) => request.url)).toEqual([
      "https://discord.com/api/v10/gateway/bot",
    ]);
    const connection = fixture.webSockets.last;
    expect(connection.url).toBe(`${DISCOVERY_URL}?v=10&encoding=json`);
    expect(connection.url).not.toContain(TOKEN);
    expect(connection.maxMessageBytes).toBe(262_144);

    connection.socket.deliver(hello);
    await settle();
    const identify = JSON.parse(connection.socket.sent[0] ?? "{}") as {
      op: number;
      d: { token: string; intents: number };
    };
    expect(identify.op).toBe(2);
    expect(identify.d.token).toBe(TOKEN);
    expect(identify.d.intents).toBe(37_377);

    connection.socket.deliver(ready);
    await settle();
    expect(fixture.runtime.snapshot()).toMatchObject({
      phase: "ready",
      connected: true,
      botUserId: BOT_USER_ID,
    });
    expect(fixture.saved).toEqual([
      {
        sessionId: "session-1",
        sequence: 1,
        resumeGatewayUrl: RESUME_URL,
      },
    ]);

    connection.socket.deliver(messageFrame(2));
    await settle();
    expect(fixture.drafts).toEqual([
      {
        text: "hello borg",
        destinationId: CHANNEL_ID,
        externalId: "500000000000000001",
        sender: HUMAN_ID,
        classification: "internal",
        metadata: {
          source: "discord",
          messageId: "500000000000000001",
          channelId: CHANNEL_ID,
          authorId: HUMAN_ID,
          authorName: "ada",
          guildId: GUILD_ID,
        },
      },
    ]);
  });

  it("resolves whenReady once the gateway is live", async () => {
    const fixture = createFixture();
    await fixture.start();
    const waiting = fixture.runtime.whenReady(5_000);
    fixture.webSockets.last.socket.deliver(hello);
    await settle();
    fixture.webSockets.last.socket.deliver(ready);
    await expect(waiting).resolves.toBeUndefined();
  });

  it("reconnects when Discord never sends Hello", async () => {
    const fixture = createFixture();
    await fixture.start();
    const socket = fixture.webSockets.last.socket;

    fixture.clock.advance(15_000);
    await settle();

    expect(socket.closeCalls.at(-1)).toEqual({
      code: 4_000,
      reason: "gateway hello timed out",
    });
    expect(fixture.runtime.state.phase).toBe("backoff");
  });

  it("reconnects when session negotiation never becomes ready", async () => {
    const fixture = createFixture();
    await fixture.start();
    const socket = fixture.webSockets.last.socket;
    socket.deliver(hello);
    await settle();

    fixture.clock.advance(30_000);
    await settle();

    expect(socket.closeCalls.at(-1)).toEqual({
      code: 4_000,
      reason: "gateway session handshake timed out",
    });
    expect(fixture.runtime.state.phase).toBe("backoff");
  });

  it("beats on the jittered schedule and drops a zombie socket", async () => {
    const fixture = createFixture();
    await fixture.start();
    const first = fixture.webSockets.last.socket;
    first.deliver(hello);
    await settle();
    first.deliver(ready);
    await settle();

    fixture.clock.advance(20_000);
    await settle();
    expect(JSON.parse(first.sent[1] ?? "{}")).toEqual({ op: 1, d: 1 });

    fixture.clock.advance(40_000);
    await settle();
    expect(first.closeCalls).toEqual([
      { code: 4_000, reason: "heartbeat acknowledgement timed out" },
    ]);
    expect(first.messageHandlerCount).toBe(0);
    expect(fixture.runtime.state.phase).toBe("backoff");

    fixture.clock.advance(60_000);
    await settle();
    expect(fixture.webSockets.connections).toHaveLength(2);
    expect(fixture.webSockets.last.url).toBe(`${RESUME_URL}?v=10&encoding=json`);
    expect(fixture.requests).toHaveLength(1);
  });

  it("stops the heartbeat once an ack arrives", async () => {
    const fixture = createFixture();
    await fixture.start();
    const socket = fixture.webSockets.last.socket;
    socket.deliver(hello);
    await settle();
    socket.deliver(ready);
    await settle();

    fixture.clock.advance(20_000);
    await settle();
    socket.deliver(JSON.stringify({ op: 11 }));
    await settle();
    fixture.clock.advance(40_000);
    await settle();

    expect(socket.closeCalls).toEqual([]);
    expect(fixture.runtime.state.phase).toBe("ready");
    expect(socket.sent).toHaveLength(3);
  });

  it("reconnects before exceeding Discord's gateway send window", async () => {
    const fixture = createFixture();
    await fixture.start();
    const socket = fixture.webSockets.last.socket;
    socket.deliver(hello);
    await settle();
    socket.deliver(ready);
    await settle();

    for (let index = 0; index < 120; index += 1) {
      socket.deliver(JSON.stringify({ op: 1 }));
    }
    await settle();

    expect(socket.sent).toHaveLength(120);
    expect(socket.closeCalls.at(-1)).toEqual({
      code: 4_000,
      reason: "Discord gateway send rate limit reached",
    });
    expect(fixture.runtime.state.phase).toBe("backoff");

    fixture.clock.advance(60_000);
    await settle();
    const replacement = fixture.webSockets.last.socket;
    replacement.deliver(hello);
    await settle();
    expect(replacement.sent).toHaveLength(1);
    expect(JSON.parse(replacement.sent[0] ?? "{}").op).toBe(6);
  });

  it("never reconnects after a fatal close", async () => {
    const fixture = createFixture();
    await fixture.start();
    const socket = fixture.webSockets.last.socket;
    socket.deliver(hello);
    await settle();
    socket.deliver(ready);
    await settle();

    socket.deliverClose(4_014, "disallowed intent");
    await settle();
    fixture.clock.advance(600_000);
    await settle();

    expect(fixture.runtime.state.phase).toBe("fatal");
    expect(fixture.webSockets.connections).toHaveLength(1);
    expect(fixture.saved.at(-1)).toBeNull();
    await expect(fixture.runtime.whenReady(1_000)).rejects.toThrow(
      /gateway closed with code 4014/,
    );
  });

  it("ignores every callback from a socket that was already abandoned", async () => {
    const fixture = createFixture();
    await fixture.start();
    const first = fixture.webSockets.last.socket;
    first.deliver(hello);
    await settle();
    first.deliver(ready);
    await settle();

    first.deliverClose(1_006);
    await settle();
    fixture.clock.advance(60_000);
    await settle();
    expect(fixture.webSockets.connections).toHaveLength(2);
    const second = fixture.webSockets.last.socket;

    first.deliver(messageFrame(9));
    first.deliverClose(4_004);
    first.deliverError("late failure");
    await settle();

    expect(fixture.drafts).toEqual([]);
    expect(fixture.runtime.state.phase).not.toBe("fatal");
    expect(fixture.webSockets.connections).toHaveLength(2);
    expect(first.messageHandlerCount).toBe(0);
    expect(second.messageHandlerCount).toBe(1);
  });

  it("closes the socket and stops timers when the host aborts", async () => {
    const fixture = createFixture();
    await fixture.start();
    const socket = fixture.webSockets.last.socket;
    socket.deliver(hello);
    await settle();
    socket.deliver(ready);
    await settle();

    fixture.host.abort(new Error("deactivated"));
    await settle();

    expect(socket.closeCalls).toEqual([{ code: 1_000, reason: "stopped" }]);
    expect(socket.disposed).toBe(true);
    expect(fixture.clock.pending).toBe(0);
    expect(fixture.runtime.state.phase).toBe("idle");

    socket.deliver(messageFrame(9));
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

    await fixture.runtime.stop({ clearSession: true });
    fixture.clock.advance(600_000);
    await settle();

    expect(fixture.webSockets.connections).toHaveLength(1);
    expect(fixture.saved.at(-1)).toBeNull();
  });

  it("does not resurrect a session after a later clear", async () => {
    let releaseFirstSave = (): void => undefined;
    const delayFirstSave = new Promise<void>((resolve) => {
      releaseFirstSave = resolve;
    });
    const fixture = createFixture({ delayFirstSave });
    await fixture.start();
    const socket = fixture.webSockets.last.socket;
    socket.deliver(hello);
    await settle();
    socket.deliver(ready);
    await settle();
    expect(fixture.saved).toEqual([]);

    await fixture.runtime.stop({ clearSession: true });
    releaseFirstSave();
    await settle();

    expect(fixture.saved.at(-1)).toBeNull();
  });

  it("resumes a persisted session without asking Discord for a url", async () => {
    const fixture = createFixture({
      session: {
        sessionId: "session-9",
        sequence: 42,
        resumeGatewayUrl: RESUME_URL,
      },
    });
    await fixture.start();

    expect(fixture.requests).toHaveLength(0);
    expect(fixture.webSockets.last.url).toBe(`${RESUME_URL}?v=10&encoding=json`);
    fixture.webSockets.last.socket.deliver(hello);
    await settle();
    expect(JSON.parse(fixture.webSockets.last.socket.sent[0] ?? "{}")).toEqual({
      op: 6,
      d: { session_id: "session-9", seq: 42, token: TOKEN },
    });
  });

  it("waits for the session start limit to reset before identifying", async () => {
    const fixture = createFixture({
      fetch: () =>
        jsonResponse(200, {
          url: DISCOVERY_URL,
          session_start_limit: { remaining: 0, reset_after: 5_000 },
        }),
    });
    await fixture.start();

    expect(fixture.webSockets.connections).toHaveLength(0);
    fixture.clock.advance(5_000);
    await settle();
    expect(fixture.webSockets.connections).toHaveLength(1);
    expect(
      fixture.logs.some(
        (entry) => entry.message === "Discord session starts are exhausted",
      ),
    ).toBe(true);
  });

  it("stops permanently when the token is missing", async () => {
    const fixture = createFixture({ token: undefined });
    await fixture.start();

    expect(fixture.webSockets.connections).toHaveLength(0);
    expect(fixture.runtime.state.phase).toBe("fatal");
    expect(fixture.runtime.state.error).toBe("Discord bot token is not saved");
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

  it("keeps the token out of every log record", async () => {
    const fixture = createFixture({
      fetch: () => jsonResponse(401, { message: "unauthorized" }),
    });
    await fixture.start();
    fixture.clock.advance(600_000);
    await settle();

    expect(fixture.runtime.state.phase).toBe("fatal");
    const serialized = JSON.stringify(fixture.logs);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).toContain("Discord rejected the bot token");
  });
});
