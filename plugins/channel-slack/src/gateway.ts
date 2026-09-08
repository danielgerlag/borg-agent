import {
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  CLOSE_ABANDON,
  CLOSE_NORMAL,
  MAX_BACKOFF_EXPONENT,
  MIN_RECONNECT_DELAY_MS,
  SOCKET_HELLO_TIMEOUT_MS,
  STABLE_SESSION_MS,
  boundDiagnostic,
  encodeAck,
  encodePong,
  parseMessageEvent,
  parseSocketEnvelope,
  type SlackInboundMessage,
} from "./protocol";

export type SocketPhase =
  | "idle"
  | "connecting"
  | "ready"
  | "backoff"
  | "fatal";

export interface SocketState {
  readonly phase: SocketPhase;
  readonly generation: number;
  readonly attempt: number;
  readonly error: string | undefined;
}

export interface SocketPolicy {
  readonly allowedChannelIds: readonly string[];
}

export interface SocketEnv {
  readonly random: number;
  readonly policy: SocketPolicy;
}

export type SocketEvent =
  | { readonly type: "connect" }
  | { readonly type: "socketOpen" }
  | { readonly type: "frame"; readonly raw: string }
  | { readonly type: "socketClosed"; readonly code: number }
  | {
      readonly type: "failure";
      readonly reason: string;
      readonly fatal: boolean;
    }
  | { readonly type: "helloTimeout" }
  | { readonly type: "sessionStable" }
  | { readonly type: "stop" };

export type SocketEffect =
  | { readonly type: "openSocket"; readonly generation: number }
  | {
      readonly type: "send";
      readonly generation: number;
      readonly payload: string;
    }
  | {
      readonly type: "closeSocket";
      readonly generation: number;
      readonly code: number;
      readonly reason: string;
    }
  | {
      readonly type: "scheduleReconnect";
      readonly generation: number;
      readonly delayMs: number;
    }
  | {
      readonly type: "scheduleHelloTimeout";
      readonly generation: number;
      readonly delayMs: number;
    }
  | {
      readonly type: "scheduleStable";
      readonly generation: number;
      readonly delayMs: number;
    }
  | { readonly type: "ingest"; readonly message: SlackInboundMessage }
  | {
      readonly type: "log";
      readonly level: "info" | "debug" | "warn";
      readonly message: string;
    }
  | { readonly type: "ready" }
  | { readonly type: "fatal"; readonly reason: string };

export interface SocketTransition {
  readonly state: SocketState;
  readonly effects: readonly SocketEffect[];
}

export function initialSocketState(): SocketState {
  return {
    phase: "idle",
    generation: 0,
    attempt: 0,
    error: undefined,
  };
}

export function fullJitterDelay(attempt: number, random: number): number {
  const exponent = Math.min(Math.max(attempt, 0), MAX_BACKOFF_EXPONENT);
  const ceiling = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** exponent);
  return Math.max(
    MIN_RECONNECT_DELAY_MS,
    Math.floor(clampRandom(random) * ceiling),
  );
}

export function reduceSocket(
  state: SocketState,
  event: SocketEvent,
  env: SocketEnv,
): SocketTransition {
  switch (event.type) {
    case "connect":
      return connect(state);
    case "socketOpen":
      return socketOpen(state);
    case "frame":
      return frame(state, event.raw, env);
    case "socketClosed":
      return closed(state, event.code, env);
    case "failure":
      return failure(state, event.reason, event.fatal, env);
    case "helloTimeout":
      return state.phase === "connecting"
        ? backoff(state, env, { reason: "Socket Mode hello timed out" })
        : unchanged(state);
    case "sessionStable":
      return state.phase === "ready"
        ? { state: { ...state, attempt: 0 }, effects: [] }
        : unchanged(state);
    case "stop":
      return stop(state);
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

function unchanged(state: SocketState): SocketTransition {
  return { state, effects: [] };
}

function isLive(phase: SocketPhase): boolean {
  return phase === "connecting" || phase === "ready";
}

function clampRandom(random: number): number {
  if (!Number.isFinite(random)) {
    return 0.5;
  }
  return Math.min(Math.max(random, 0), 0.999_999);
}

function connect(state: SocketState): SocketTransition {
  if (isLive(state.phase)) {
    return unchanged(state);
  }
  const generation = state.generation + 1;
  return {
    state: {
      ...state,
      phase: "connecting",
      generation,
      error: undefined,
    },
    effects: [{ type: "openSocket", generation }],
  };
}

function socketOpen(state: SocketState): SocketTransition {
  if (state.phase !== "connecting") {
    return unchanged(state);
  }
  return {
    state,
    effects: [
      {
        type: "scheduleHelloTimeout",
        generation: state.generation,
        delayMs: SOCKET_HELLO_TIMEOUT_MS,
      },
    ],
  };
}

function stop(state: SocketState): SocketTransition {
  const generation = state.generation + 1;
  return {
    state: {
      ...state,
      phase: "idle",
      generation,
      attempt: 0,
      error: undefined,
    },
    effects: [
      {
        type: "closeSocket",
        generation: state.generation,
        code: CLOSE_NORMAL,
        reason: "stopped",
      },
    ],
  };
}

function backoff(
  state: SocketState,
  env: SocketEnv,
  options: { readonly reason: string },
): SocketTransition {
  const delayMs = fullJitterDelay(state.attempt, env.random);
  return {
    state: {
      ...state,
      phase: "backoff",
      attempt: Math.min(state.attempt + 1, MAX_BACKOFF_EXPONENT + 1),
      error: boundDiagnostic(options.reason),
    },
    effects: [
      {
        type: "closeSocket",
        generation: state.generation,
        code: CLOSE_ABANDON,
        reason: options.reason,
      },
      {
        type: "scheduleReconnect",
        generation: state.generation,
        delayMs,
      },
    ],
  };
}

function toFatal(state: SocketState, reason: string): SocketTransition {
  return {
    state: {
      ...state,
      phase: "fatal",
      error: boundDiagnostic(reason),
    },
    effects: [
      {
        type: "closeSocket",
        generation: state.generation,
        code: CLOSE_NORMAL,
        reason,
      },
      { type: "fatal", reason: boundDiagnostic(reason) },
    ],
  };
}

function closed(
  state: SocketState,
  code: number,
  env: SocketEnv,
): SocketTransition {
  if (!isLive(state.phase)) {
    return unchanged(state);
  }
  return backoff(state, env, {
    reason: `Socket Mode closed with code ${code}`,
  });
}

function failure(
  state: SocketState,
  reason: string,
  fatal: boolean,
  env: SocketEnv,
): SocketTransition {
  if (!isLive(state.phase)) {
    return unchanged(state);
  }
  if (fatal) {
    return toFatal(state, reason);
  }
  return backoff(state, env, { reason });
}

function frame(
  state: SocketState,
  raw: string,
  env: SocketEnv,
): SocketTransition {
  const parsed = parseSocketEnvelope(raw);
  if (!parsed || !isLive(state.phase)) {
    return unchanged(state);
  }
  switch (parsed.type) {
    case "hello":
      return hello(state);
    case "disconnect":
      return disconnect(state, env);
    case "events_api":
      return eventsApi(state, parsed.envelopeId, parsed.payload, env);
    case "interactive":
      return ackOnly(state, parsed.envelopeId);
    case "ping":
      return ping(state, parsed.envelopeId);
    default:
      return ackOnly(state, parsed.envelopeId);
  }
}

function hello(state: SocketState): SocketTransition {
  const log: SocketEffect = {
    type: "log",
    level: "info",
    message: "Slack Socket Mode: received hello",
  };
  if (state.phase !== "connecting") {
    return { state, effects: [log] };
  }
  return {
    state: {
      ...state,
      phase: "ready",
      error: undefined,
    },
    effects: [
      log,
      { type: "ready" },
      {
        type: "scheduleStable",
        generation: state.generation,
        delayMs: STABLE_SESSION_MS,
      },
    ],
  };
}

function disconnect(state: SocketState, env: SocketEnv): SocketTransition {
  const transition = backoff(state, env, {
    reason: "Slack requested a disconnect",
  });
  return {
    state: transition.state,
    effects: [
      {
        type: "log",
        level: "info",
        message: "Slack Socket Mode: received disconnect, reconnecting",
      },
      ...transition.effects,
    ],
  };
}

function ackOnly(
  state: SocketState,
  envelopeId: string | undefined,
): SocketTransition {
  if (envelopeId === undefined) {
    return unchanged(state);
  }
  return {
    state,
    effects: [
      {
        type: "send",
        generation: state.generation,
        payload: encodeAck(envelopeId),
      },
    ],
  };
}

function ping(
  state: SocketState,
  envelopeId: string | undefined,
): SocketTransition {
  return {
    state,
    effects: [
      {
        type: "send",
        generation: state.generation,
        payload:
          envelopeId === undefined ? encodePong() : encodeAck(envelopeId),
      },
    ],
  };
}

function eventsApi(
  state: SocketState,
  envelopeId: string | undefined,
  payload: unknown,
  env: SocketEnv,
): SocketTransition {
  const effects: SocketEffect[] = [];
  if (envelopeId !== undefined) {
    effects.push({
      type: "send",
      generation: state.generation,
      payload: encodeAck(envelopeId),
    });
  }
  if (state.phase !== "ready") {
    return { state, effects };
  }
  const message = parseMessageEvent(payload);
  if (!message) {
    return { state, effects };
  }
  if (!env.policy.allowedChannelIds.includes(message.channelId)) {
    return { state, effects };
  }
  effects.push({ type: "ingest", message });
  return { state, effects };
}
