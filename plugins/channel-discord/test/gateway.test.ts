import { describe, expect, it } from "vitest";
import {
  canResume,
  fullJitterDelay,
  initialGatewayState,
  reduceGateway,
  type GatewayEffect,
  type GatewayEnv,
  type GatewayPolicy,
  type GatewayState,
} from "../src/gateway";
import {
  BACKOFF_CAP_MS,
  GATEWAY_INTENTS,
  MAX_INBOUND_CONTENT_LENGTH,
  OP_HEARTBEAT,
  OP_IDENTIFY,
  OP_RESUME,
  encodeOutboundFrame,
  type OutboundFrame,
} from "../src/protocol";

const CHANNEL_ID = "100000000000000001";
const OTHER_CHANNEL_ID = "100000000000000002";
const GUILD_ID = "200000000000000001";
const OTHER_GUILD_ID = "200000000000000002";
const BOT_USER_ID = "300000000000000001";
const HUMAN_ID = "400000000000000001";
const RESUME_URL = "wss://gateway-us-east1-b.discord.gg";

const policy: GatewayPolicy = {
  allowedGuildIds: [],
  allowedChannelIds: [CHANNEL_ID],
  ignoreBots: true,
};

function env(random = 0.5, overrides: Partial<GatewayPolicy> = {}): GatewayEnv {
  return { random, policy: { ...policy, ...overrides } };
}

function helloFrame(interval = 40_000): string {
  return JSON.stringify({ op: 10, d: { heartbeat_interval: interval } });
}

function readyFrame(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    op: 0,
    s: 1,
    t: "READY",
    d: {
      session_id: "session-1",
      user: { id: BOT_USER_ID },
      resume_gateway_url: RESUME_URL,
      ...overrides,
    },
  });
}

function messageFrame(
  sequence: number,
  overrides: Record<string, unknown> = {},
): string {
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

function step(
  state: GatewayState,
  raw: string,
  environment = env(),
): { state: GatewayState; effects: readonly GatewayEffect[] } {
  return reduceGateway(state, { type: "frame", raw }, environment);
}

function connecting(environment = env()): GatewayState {
  return reduceGateway(initialGatewayState(), { type: "connect" }, environment)
    .state;
}

function identifying(environment = env()): GatewayState {
  return step(connecting(environment), helloFrame(), environment).state;
}

function ready(environment = env()): GatewayState {
  return step(identifying(environment), readyFrame(), environment).state;
}

function effectsOf(
  transition: { effects: readonly GatewayEffect[] },
  type: GatewayEffect["type"],
): GatewayEffect[] {
  return transition.effects.filter((effect) => effect.type === type);
}

function sentFrames(transition: {
  effects: readonly GatewayEffect[];
}): OutboundFrame[] {
  return transition.effects.flatMap((effect) =>
    effect.type === "send" ? [effect.frame] : [],
  );
}

function reconnectDelays(transition: {
  effects: readonly GatewayEffect[];
}): number[] {
  return transition.effects.flatMap((effect) =>
    effect.type === "scheduleReconnect" ? [effect.delayMs] : [],
  );
}

describe("discord gateway reducer", () => {
  it("opens a fresh socket and bumps the generation on connect", () => {
    const transition = reduceGateway(
      initialGatewayState(),
      { type: "connect" },
      env(),
    );
    expect(transition.state.phase).toBe("connecting");
    expect(transition.state.generation).toBe(1);
    expect(transition.effects).toEqual([
      { type: "openSocket", generation: 1, resume: false },
    ]);
  });

  it("identifies with the four required intents and a jittered first heartbeat", () => {
    const transition = step(connecting(), helloFrame(40_000), env(0.25));
    expect(transition.state.phase).toBe("identifying");
    expect(transition.state.heartbeatIntervalMs).toBe(40_000);
    expect(effectsOf(transition, "scheduleHeartbeat")).toEqual([
      { type: "scheduleHeartbeat", generation: 1, delayMs: 10_000 },
    ]);
    const [frame] = sentFrames(transition);
    expect(frame).toEqual({
      op: OP_IDENTIFY,
      d: {
        intents: GATEWAY_INTENTS,
        properties: { os: "borg", browser: "borg-agent", device: "borg-agent" },
      },
      withToken: true,
    });
    expect(GATEWAY_INTENTS).toBe(1 + 512 + 4_096 + 32_768);
    expect(JSON.parse(encodeOutboundFrame(frame as OutboundFrame, "t0ken"))).toEqual({
      op: OP_IDENTIFY,
      d: {
        intents: GATEWAY_INTENTS,
        properties: { os: "borg", browser: "borg-agent", device: "borg-agent" },
        token: "t0ken",
      },
    });
  });

  it("refuses a heartbeat interval outside the accepted window", () => {
    for (const interval of [0, 999, 120_001]) {
      const transition = step(connecting(), helloFrame(interval));
      expect(transition.state.phase).toBe("backoff");
      expect(effectsOf(transition, "scheduleReconnect")).toHaveLength(1);
    }
  });

  it("beats on the interval, clears the flag on ack, and reschedules", () => {
    const state = ready();
    const beat = reduceGateway(state, { type: "heartbeatDue" }, env());
    expect(beat.state.awaitingAck).toBe(true);
    expect(beat.effects).toEqual([
      { type: "send", generation: 1, frame: { op: OP_HEARTBEAT, d: 1 } },
      { type: "scheduleHeartbeat", generation: 1, delayMs: 40_000 },
    ]);
    const acked = step(beat.state, JSON.stringify({ op: 11 }));
    expect(acked.state.awaitingAck).toBe(false);
    expect(acked.effects).toEqual([]);
  });

  it("treats a missing ack on the next interval as a zombie connection", () => {
    const beat = reduceGateway(ready(), { type: "heartbeatDue" }, env());
    const zombie = reduceGateway(beat.state, { type: "heartbeatDue" }, env(0.5));
    expect(zombie.state.phase).toBe("backoff");
    expect(zombie.state.awaitingAck).toBe(false);
    expect(canResume(zombie.state)).toBe(true);
    expect(effectsOf(zombie, "closeSocket")).toEqual([
      {
        type: "closeSocket",
        generation: 1,
        code: 4_000,
        reason: "heartbeat acknowledgement timed out",
      },
    ]);
    expect(effectsOf(zombie, "persistSession")).toEqual([]);
  });

  it("answers an op 1 heartbeat request immediately", () => {
    const transition = step(ready(), JSON.stringify({ op: 1, d: null }));
    expect(transition.state.awaitingAck).toBe(true);
    expect(transition.effects).toEqual([
      { type: "send", generation: 1, frame: { op: OP_HEARTBEAT, d: 1 } },
      { type: "scheduleHeartbeat", generation: 1, delayMs: 40_000 },
    ]);
  });

  it("advances the sequence only forward", () => {
    let state = ready();
    expect(state.sequence).toBe(1);
    state = step(state, messageFrame(7)).state;
    expect(state.sequence).toBe(7);
    const replay = step(state, messageFrame(3));
    state = replay.state;
    expect(state.sequence).toBe(7);
    expect(replay.effects).toEqual([]);
    state = step(state, JSON.stringify({ op: 0, s: null, t: "TYPING_START", d: {} })).state;
    expect(state.sequence).toBe(7);
  });

  it("stores the ready session and asks for it to be persisted", () => {
    const transition = step(identifying(), readyFrame());
    expect(transition.state.phase).toBe("ready");
    expect(transition.state.botUserId).toBe(BOT_USER_ID);
    expect(transition.state.attempt).toBe(0);
    expect(transition.effects).toEqual([
      {
        type: "persistSession",
        session: {
          sessionId: "session-1",
          sequence: 1,
          resumeGatewayUrl: RESUME_URL,
        },
      },
      { type: "ready" },
    ]);
  });

  it("rejects a ready payload whose resume url is unsafe", () => {
    for (const url of [
      "https://discord.gg",
      "ws://gateway.discord.gg",
      "wss://user:secret@gateway.discord.gg",
      "not a url",
    ]) {
      const transition = step(
        identifying(),
        readyFrame({ resume_gateway_url: url }),
      );
      expect(transition.state.phase).toBe("backoff");
      expect(transition.state.sessionId).toBeUndefined();
      expect(effectsOf(transition, "persistSession")).toEqual([
        { type: "persistSession", session: null },
      ]);
    }
  });

  it("resumes with the stored session instead of identifying", () => {
    const restored = initialGatewayState({
      sessionId: "session-9",
      sequence: 42,
      resumeGatewayUrl: RESUME_URL,
    });
    const connect = reduceGateway(restored, { type: "connect" }, env());
    expect(connect.effects).toEqual([
      { type: "openSocket", generation: 1, resume: true },
    ]);
    const hello = step(connect.state, helloFrame());
    expect(hello.state.phase).toBe("resuming");
    expect(sentFrames(hello)).toEqual([
      {
        op: OP_RESUME,
        d: { session_id: "session-9", seq: 42 },
        withToken: true,
      },
    ]);
    const resumed = step(
      hello.state,
      JSON.stringify({ op: 0, s: 43, t: "RESUMED", d: null }),
    );
    expect(resumed.state.phase).toBe("ready");
    expect(resumed.state.attempt).toBe(0);
    expect(effectsOf(resumed, "ready")).toHaveLength(1);
  });

  it("reconnects on op 7 while keeping the session", () => {
    const transition = step(ready(), JSON.stringify({ op: 7, d: null }));
    expect(transition.state.phase).toBe("backoff");
    expect(canResume(transition.state)).toBe(true);
    expect(effectsOf(transition, "persistSession")).toEqual([]);
    expect(effectsOf(transition, "scheduleReconnect")).toHaveLength(1);
  });

  it("waits one to five seconds after an invalid session", () => {
    const resumable = step(ready(), JSON.stringify({ op: 9, d: true }), env(0));
    expect(canResume(resumable.state)).toBe(true);
    expect(effectsOf(resumable, "scheduleReconnect")).toEqual([
      { type: "scheduleReconnect", generation: 1, delayMs: 1_000 },
    ]);

    const fresh = step(ready(), JSON.stringify({ op: 9, d: false }), env(0.999));
    expect(fresh.state.sessionId).toBeUndefined();
    expect(fresh.state.sequence).toBeNull();
    expect(effectsOf(fresh, "persistSession")).toEqual([
      { type: "persistSession", session: null },
    ]);
    const [delayMs] = reconnectDelays(fresh);
    expect(delayMs).toBeGreaterThanOrEqual(1_000);
    expect(delayMs).toBeLessThanOrEqual(5_000);
  });

  it("applies the documented close code matrix", () => {
    for (const code of [4_004, 4_010, 4_011, 4_012, 4_013, 4_014]) {
      const transition = reduceGateway(
        ready(),
        { type: "socketClosed", code },
        env(),
      );
      expect(transition.state.phase).toBe("fatal");
      expect(transition.state.sessionId).toBeUndefined();
      expect(effectsOf(transition, "scheduleReconnect")).toEqual([]);
      expect(effectsOf(transition, "fatal")).toHaveLength(1);
    }

    for (const code of [4_000, 4_001, 4_002, 4_003, 4_005, 4_006, 4_008]) {
      const transition = reduceGateway(
        ready(),
        { type: "socketClosed", code },
        env(),
      );
      expect(transition.state.phase).toBe("backoff");
      expect(canResume(transition.state)).toBe(true);
    }
    for (const code of [4_007, 4_009]) {
      const transition = reduceGateway(
        ready(),
        { type: "socketClosed", code },
        env(),
      );
      expect(transition.state.phase).toBe("backoff");
      expect(canResume(transition.state)).toBe(false);
      expect(effectsOf(transition, "persistSession")).toEqual([
        { type: "persistSession", session: null },
      ]);
    }

    const abnormal = reduceGateway(ready(), { type: "socketClosed", code: 1_006 }, env());
    expect(canResume(abnormal.state)).toBe(true);

    const sessionless = reduceGateway(
      identifying(),
      { type: "socketClosed", code: 1_000 },
      env(),
    );
    expect(sessionless.state.phase).toBe("backoff");
    expect(canResume(sessionless.state)).toBe(false);
  });

  it("ignores a close that arrives after the machine already gave up", () => {
    const first = reduceGateway(ready(), { type: "socketClosed", code: 1_006 }, env());
    const second = reduceGateway(
      first.state,
      { type: "socketClosed", code: 1_006 },
      env(),
    );
    expect(second.effects).toEqual([]);
    expect(second.state).toBe(first.state);
  });

  it("uses full jitter that grows with attempts and stays under the cap", () => {
    expect(fullJitterDelay(0, 0.999_999)).toBeLessThanOrEqual(1_000);
    expect(fullJitterDelay(3, 1)).toBeLessThanOrEqual(8_000);
    expect(fullJitterDelay(50, 0.999_999)).toBeLessThanOrEqual(BACKOFF_CAP_MS);
    expect(fullJitterDelay(50, 0)).toBeGreaterThan(0);
    expect(fullJitterDelay(2, 0.5)).toBeGreaterThan(fullJitterDelay(0, 0.5));
  });

  it("bounds the attempt counter and resets it once ready", () => {
    let state = ready();
    for (let index = 0; index < 20; index += 1) {
      state = reduceGateway(state, { type: "socketClosed", code: 1_006 }, env()).state;
      state = reduceGateway(state, { type: "connect" }, env()).state;
      state = step(state, helloFrame()).state;
    }
    expect(state.attempt).toBeLessThanOrEqual(7);
    const resumed = step(
      state,
      JSON.stringify({ op: 0, s: 99, t: "RESUMED", d: null }),
    );
    expect(resumed.state.attempt).toBe(0);
  });

  it("ingests only allow-listed human messages", () => {
    const state = ready();
    const accepted = step(state, messageFrame(2));
    expect(accepted.effects).toEqual([
      {
        type: "ingest",
        message: {
          id: "500000000000000001",
          channelId: CHANNEL_ID,
          authorId: HUMAN_ID,
          authorName: "ada",
          content: "hello borg",
          guildId: GUILD_ID,
          threadId: undefined,
        },
      },
    ]);

    expect(step(state, messageFrame(3, { channel_id: OTHER_CHANNEL_ID })).effects).toEqual([]);
    expect(
      step(state, messageFrame(4), env(0.5, { allowedGuildIds: [OTHER_GUILD_ID] }))
        .effects,
    ).toEqual([]);
    expect(
      step(state, messageFrame(5), env(0.5, { allowedGuildIds: [GUILD_ID] })).effects,
    ).toHaveLength(1);
    expect(
      step(state, messageFrame(6, { author: { id: HUMAN_ID, bot: true } })).effects,
    ).toEqual([]);
    expect(
      step(
        state,
        messageFrame(7, { author: { id: HUMAN_ID, bot: true } }),
        env(0.5, { ignoreBots: false }),
      ).effects,
    ).toEqual([]);
    expect(
      step(state, messageFrame(8, { author: { id: BOT_USER_ID } })).effects,
    ).toEqual([]);
    expect(
      step(state, messageFrame(9, { content: "x".repeat(MAX_INBOUND_CONTENT_LENGTH + 1) }))
        .effects,
    ).toEqual([]);
    expect(step(state, messageFrame(10, { content: 42 })).effects).toEqual([]);
    expect(step(state, messageFrame(11, { id: "nope" })).effects).toEqual([]);
    expect(step(state, messageFrame(12, { guild_id: "not-a-snowflake" })).effects).toEqual(
      [],
    );
  });

  it("accepts direct messages that target an allow-listed channel", () => {
    const transition = step(ready(), messageFrame(2, { guild_id: undefined }));
    expect(transition.effects).toEqual([
      {
        type: "ingest",
        message: expect.objectContaining({ guildId: undefined }),
      },
    ]);
  });

  it("carries the thread id when Discord provides one", () => {
    const transition = step(
      ready(),
      messageFrame(2, { thread: { id: "600000000000000001" } }),
    );
    expect(transition.effects).toEqual([
      {
        type: "ingest",
        message: expect.objectContaining({ threadId: "600000000000000001" }),
      },
    ]);
  });

  it("ignores malformed and oversized frames", () => {
    const state = ready();
    for (const raw of [
      "",
      "{",
      "[]",
      JSON.stringify({ op: "0" }),
      JSON.stringify({ op: 0, s: -1, t: "READY", d: {} }),
      JSON.stringify({ op: 0, s: 1, t: "x".repeat(65), d: {} }),
      `{"op":0,"s":2,"t":"MESSAGE_CREATE","d":"${"x".repeat(300_000)}"}`,
    ]) {
      const transition = step(state, raw);
      expect(transition.effects).toEqual([]);
      expect(transition.state).toBe(state);
    }
  });

  it("stops without touching the stored session unless asked", () => {
    const keep = reduceGateway(ready(), { type: "stop", clearSession: false }, env());
    expect(keep.state.phase).toBe("idle");
    expect(keep.state.generation).toBe(2);
    expect(canResume(keep.state)).toBe(true);
    expect(keep.effects).toEqual([
      { type: "closeSocket", generation: 1, code: 1_000, reason: "stopped" },
    ]);

    const clear = reduceGateway(ready(), { type: "stop", clearSession: true }, env());
    expect(clear.state.sessionId).toBeUndefined();
    expect(effectsOf(clear, "persistSession")).toEqual([
      { type: "persistSession", session: null },
    ]);
  });

  it("goes fatal on an unrecoverable failure and keeps quiet afterwards", () => {
    const transition = reduceGateway(
      identifying(),
      { type: "failure", reason: "Discord bot token is not saved", fatal: true },
      env(),
    );
    expect(transition.state.phase).toBe("fatal");
    expect(transition.state.error).toBe("Discord bot token is not saved");
    expect(effectsOf(transition, "scheduleReconnect")).toEqual([]);

    const ignored = reduceGateway(
      transition.state,
      { type: "failure", reason: "late", fatal: false },
      env(),
    );
    expect(ignored.effects).toEqual([]);
  });
});
