import { describe, expect, it } from "vitest";
import {
  fullJitterDelay,
  initialSocketState,
  reduceSocket,
  type SocketEffect,
  type SocketEnv,
  type SocketPolicy,
  type SocketState,
} from "../src/gateway";
import {
  BACKOFF_CAP_MS,
  MAX_INBOUND_CONTENT_LENGTH,
  encodeAck,
  encodePong,
} from "../src/protocol";

const CHANNEL_ID = "C01234567";
const OTHER_CHANNEL_ID = "C01234568";
const USER_ID = "U01234567";
const TS = "1710000000.000100";

const policy: SocketPolicy = {
  allowedChannelIds: [CHANNEL_ID],
};

function env(random = 0.5, overrides: Partial<SocketPolicy> = {}): SocketEnv {
  return { random, policy: { ...policy, ...overrides } };
}

function helloFrame(): string {
  return JSON.stringify({ type: "hello", num_connections: 1 });
}

function eventsApi(
  envelopeId = "env-1",
  event: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    type: "events_api",
    envelope_id: envelopeId,
    payload: {
      event: {
        type: "message",
        channel: CHANNEL_ID,
        user: USER_ID,
        text: "hello borg",
        ts: TS,
        ...event,
      },
    },
  });
}

function step(
  state: SocketState,
  raw: string,
  environment = env(),
): { state: SocketState; effects: readonly SocketEffect[] } {
  return reduceSocket(state, { type: "frame", raw }, environment);
}

function connecting(environment = env()): SocketState {
  return reduceSocket(initialSocketState(), { type: "connect" }, environment)
    .state;
}

function ready(environment = env()): SocketState {
  return step(connecting(environment), helloFrame(), environment).state;
}

function effectsOf(
  transition: { effects: readonly SocketEffect[] },
  type: SocketEffect["type"],
): SocketEffect[] {
  return transition.effects.filter((effect) => effect.type === type);
}

function sentPayloads(transition: {
  effects: readonly SocketEffect[];
}): string[] {
  return transition.effects.flatMap((effect) =>
    effect.type === "send" ? [effect.payload] : [],
  );
}

describe("slack socket reducer", () => {
  it("opens a fresh socket and bumps the generation on connect", () => {
    const transition = reduceSocket(
      initialSocketState(),
      { type: "connect" },
      env(),
    );
    expect(transition.state.phase).toBe("connecting");
    expect(transition.state.generation).toBe(1);
    expect(transition.effects).toEqual([
      { type: "openSocket", generation: 1 },
    ]);
  });

  it("treats hello as log-only and becomes ready", () => {
    const transition = step(connecting(), helloFrame());
    expect(transition.state.phase).toBe("ready");
    expect(effectsOf(transition, "ingest")).toEqual([]);
    expect(effectsOf(transition, "send")).toEqual([]);
    expect(effectsOf(transition, "log")).toEqual([
      {
        type: "log",
        level: "info",
        message: "Slack Socket Mode: received hello",
      },
    ]);
    expect(effectsOf(transition, "ready")).toHaveLength(1);
    expect(effectsOf(transition, "scheduleStable")).toHaveLength(1);
  });

  it("acks events_api immediately then ingests an allow-listed human message", () => {
    const transition = step(ready(), eventsApi());
    expect(sentPayloads(transition)).toEqual([encodeAck("env-1")]);
    expect(effectsOf(transition, "ingest")).toEqual([
      {
        type: "ingest",
        message: {
          ts: TS,
          channelId: CHANNEL_ID,
          userId: USER_ID,
          userName: undefined,
          text: "hello borg",
          threadTs: undefined,
        },
      },
    ]);
  });

  it("skips bot_id messages after acking", () => {
    const transition = step(
      ready(),
      eventsApi("env-bot", { bot_id: "B01234567", text: "bot noise" }),
    );
    expect(sentPayloads(transition)).toEqual([encodeAck("env-bot")]);
    expect(effectsOf(transition, "ingest")).toEqual([]);
  });

  it("drops non-allowlisted channels after acking", () => {
    const transition = step(
      ready(),
      eventsApi("env-other", { channel: OTHER_CHANNEL_ID }),
    );
    expect(sentPayloads(transition)).toEqual([encodeAck("env-other")]);
    expect(effectsOf(transition, "ingest")).toEqual([]);
  });

  it("skips subtype events after acking", () => {
    const transition = step(
      ready(),
      eventsApi("env-sub", { subtype: "message_changed" }),
    );
    expect(sentPayloads(transition)).toEqual([encodeAck("env-sub")]);
    expect(effectsOf(transition, "ingest")).toEqual([]);
  });

  it("acks interactive envelopes without ingesting Block Kit", () => {
    const transition = step(
      ready(),
      JSON.stringify({
        type: "interactive",
        envelope_id: "env-int",
        payload: { type: "block_actions", actions: [{ action_id: "ok" }] },
      }),
    );
    expect(sentPayloads(transition)).toEqual([encodeAck("env-int")]);
    expect(effectsOf(transition, "ingest")).toEqual([]);
  });

  it("acks unknown envelope types so Slack does not retry", () => {
    const transition = step(
      ready(),
      JSON.stringify({ type: "slash_commands", envelope_id: "env-unk" }),
    );
    expect(sentPayloads(transition)).toEqual([encodeAck("env-unk")]);
  });

  it("answers ping with pong or an envelope ack", () => {
    const pong = step(ready(), JSON.stringify({ type: "ping" }));
    expect(sentPayloads(pong)).toEqual([encodePong()]);
    const acked = step(
      ready(),
      JSON.stringify({ type: "ping", envelope_id: "env-ping" }),
    );
    expect(sentPayloads(acked)).toEqual([encodeAck("env-ping")]);
  });

  it("reconnects on disconnect with a fresh socket", () => {
    const transition = step(
      ready(),
      JSON.stringify({ type: "disconnect", reason: "warning" }),
    );
    expect(transition.state.phase).toBe("backoff");
    expect(effectsOf(transition, "closeSocket")).toHaveLength(1);
    expect(effectsOf(transition, "scheduleReconnect")).toHaveLength(1);
    expect(effectsOf(transition, "log")).toEqual([
      {
        type: "log",
        level: "info",
        message: "Slack Socket Mode: received disconnect, reconnecting",
      },
    ]);
  });

  it("reconnects when Slack never sends hello", () => {
    const opened = reduceSocket(connecting(), { type: "socketOpen" }, env());
    expect(effectsOf(opened, "scheduleHelloTimeout")).toEqual([
      { type: "scheduleHelloTimeout", generation: 1, delayMs: 15_000 },
    ]);
    const timedOut = reduceSocket(
      opened.state,
      { type: "helloTimeout" },
      env(),
    );
    expect(timedOut.state.phase).toBe("backoff");
  });

  it("resets backoff after a stable session", () => {
    let state = ready();
    state = reduceSocket(
      state,
      { type: "socketClosed", code: 1_006 },
      env(),
    ).state;
    expect(state.attempt).toBe(1);
    state = reduceSocket(state, { type: "connect" }, env()).state;
    state = step(state, helloFrame()).state;
    expect(state.attempt).toBe(1);
    const stable = reduceSocket(state, { type: "sessionStable" }, env());
    expect(stable.state.attempt).toBe(0);
  });

  it("uses full jitter that grows with attempts and stays under the cap", () => {
    expect(fullJitterDelay(0, 0.999_999)).toBeLessThanOrEqual(1_000);
    expect(fullJitterDelay(3, 1)).toBeLessThanOrEqual(8_000);
    expect(fullJitterDelay(50, 0.999_999)).toBeLessThanOrEqual(BACKOFF_CAP_MS);
    expect(fullJitterDelay(50, 0)).toBeGreaterThan(0);
    expect(fullJitterDelay(2, 0.5)).toBeGreaterThan(fullJitterDelay(0, 0.5));
  });

  it("ignores oversized inbound text", () => {
    const transition = step(
      ready(),
      eventsApi("env-big", {
        text: "x".repeat(MAX_INBOUND_CONTENT_LENGTH + 1),
      }),
    );
    expect(effectsOf(transition, "ingest")).toEqual([]);
  });

  it("goes fatal on an unrecoverable failure and keeps quiet afterwards", () => {
    const transition = reduceSocket(
      connecting(),
      {
        type: "failure",
        reason: "Slack app-level token is not saved",
        fatal: true,
      },
      env(),
    );
    expect(transition.state.phase).toBe("fatal");
    expect(transition.state.error).toBe("Slack app-level token is not saved");
    expect(effectsOf(transition, "scheduleReconnect")).toEqual([]);

    const ignored = reduceSocket(
      transition.state,
      { type: "failure", reason: "late", fatal: false },
      env(),
    );
    expect(ignored.effects).toEqual([]);
  });

  it("stops without reconnecting", () => {
    const keep = reduceSocket(ready(), { type: "stop" }, env());
    expect(keep.state.phase).toBe("idle");
    expect(keep.state.generation).toBe(2);
    expect(keep.effects).toEqual([
      { type: "closeSocket", generation: 1, code: 1_000, reason: "stopped" },
    ]);
  });
});
