import {
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  CLOSE_ABANDON,
  CLOSE_NORMAL,
  FATAL_CLOSE_CODES,
  GATEWAY_HELLO_TIMEOUT_MS,
  GATEWAY_READY_TIMEOUT_MS,
  INVALID_SESSION_MAX_DELAY_MS,
  INVALID_SESSION_MIN_DELAY_MS,
  MAX_BACKOFF_EXPONENT,
  MIN_RECONNECT_DELAY_MS,
  NON_RESUMABLE_CLOSE_CODES,
  OP_DISPATCH,
  OP_HEARTBEAT,
  OP_HEARTBEAT_ACK,
  OP_HELLO,
  OP_INVALID_SESSION,
  OP_RECONNECT,
  RESUMABLE_CLOSE_CODES,
  boundDiagnostic,
  buildHeartbeatFrame,
  buildIdentifyFrame,
  buildResumeFrame,
  isBotAuthor,
  parseGatewayFrame,
  parseHelloInterval,
  parseMessageCreate,
  parseReadyPayload,
  type DiscordInboundMessage,
  type OutboundFrame,
} from "./protocol";

export type GatewayPhase =
  | "idle"
  | "connecting"
  | "identifying"
  | "resuming"
  | "ready"
  | "backoff"
  | "fatal";

export interface GatewaySessionRecord {
  readonly sessionId: string;
  readonly sequence: number;
  readonly resumeGatewayUrl: string;
}

export interface GatewayState {
  readonly phase: GatewayPhase;
  /**
   * Increments whenever the machine starts or abandons a socket lifecycle.
   * Every effect and every event carries the generation it belongs to so a
   * late callback from a discarded socket or timer can never mutate the
   * current cycle.
   */
  readonly generation: number;
  readonly attempt: number;
  readonly heartbeatIntervalMs: number | undefined;
  readonly awaitingAck: boolean;
  readonly sequence: number | null;
  readonly sessionId: string | undefined;
  readonly resumeGatewayUrl: string | undefined;
  readonly botUserId: string | undefined;
  readonly error: string | undefined;
}

export interface GatewayPolicy {
  readonly allowedGuildIds: readonly string[];
  readonly allowedChannelIds: readonly string[];
  readonly ignoreBots: boolean;
}

export interface GatewayEnv {
  /** A value in [0, 1). Injected so jitter is deterministic under test. */
  readonly random: number;
  readonly policy: GatewayPolicy;
}

export type GatewayEvent =
  | { readonly type: "connect" }
  | { readonly type: "socketOpen" }
  | { readonly type: "frame"; readonly raw: string }
  | { readonly type: "socketClosed"; readonly code: number }
  | {
      readonly type: "failure";
      readonly reason: string;
      readonly fatal: boolean;
    }
  | { readonly type: "heartbeatDue" }
  | { readonly type: "helloTimeout" }
  | { readonly type: "readyTimeout" }
  | { readonly type: "stop"; readonly clearSession: boolean };

export type GatewayEffect =
  | {
      readonly type: "openSocket";
      readonly generation: number;
      readonly resume: boolean;
    }
  | {
      readonly type: "send";
      readonly generation: number;
      readonly frame: OutboundFrame;
    }
  | {
      readonly type: "closeSocket";
      readonly generation: number;
      readonly code: number;
      readonly reason: string;
    }
  | {
      readonly type: "scheduleHeartbeat";
      readonly generation: number;
      readonly delayMs: number;
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
      readonly type: "scheduleReadyTimeout";
      readonly generation: number;
      readonly delayMs: number;
    }
  | { readonly type: "ingest"; readonly message: DiscordInboundMessage }
  | {
      readonly type: "persistSession";
      readonly session: GatewaySessionRecord | null;
    }
  | { readonly type: "ready" }
  | { readonly type: "fatal"; readonly reason: string };

export interface GatewayTransition {
  readonly state: GatewayState;
  readonly effects: readonly GatewayEffect[];
}

export function initialGatewayState(
  session?: GatewaySessionRecord | undefined,
): GatewayState {
  return {
    phase: "idle",
    generation: 0,
    attempt: 0,
    heartbeatIntervalMs: undefined,
    awaitingAck: false,
    sequence: session ? session.sequence : null,
    sessionId: session?.sessionId,
    resumeGatewayUrl: session?.resumeGatewayUrl,
    botUserId: undefined,
    error: undefined,
  };
}

export function canResume(state: GatewayState): boolean {
  return (
    state.sessionId !== undefined &&
    state.resumeGatewayUrl !== undefined &&
    state.sequence !== null
  );
}

export function gatewaySessionOf(
  state: GatewayState,
): GatewaySessionRecord | null {
  if (
    state.sessionId === undefined ||
    state.resumeGatewayUrl === undefined
  ) {
    return null;
  }
  return {
    sessionId: state.sessionId,
    sequence: state.sequence ?? 0,
    resumeGatewayUrl: state.resumeGatewayUrl,
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

export function reduceGateway(
  state: GatewayState,
  event: GatewayEvent,
  env: GatewayEnv,
): GatewayTransition {
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
    case "heartbeatDue":
      return heartbeatDue(state, env);
    case "helloTimeout":
      return state.phase === "connecting"
        ? backoff(state, env, {
            reason: "gateway hello timed out",
            clearSession: false,
          })
        : unchanged(state);
    case "readyTimeout":
      return state.phase === "identifying" || state.phase === "resuming"
        ? backoff(state, env, {
            reason: "gateway session handshake timed out",
            clearSession: false,
          })
        : unchanged(state);
    case "stop":
      return stop(state, event.clearSession);
    default:
      return unchanged(state);
  }
}

function unchanged(state: GatewayState): GatewayTransition {
  return { state, effects: [] };
}

function socketOpen(state: GatewayState): GatewayTransition {
  if (state.phase !== "connecting") {
    return unchanged(state);
  }
  return {
    state,
    effects: [
      {
        type: "scheduleHelloTimeout",
        generation: state.generation,
        delayMs: GATEWAY_HELLO_TIMEOUT_MS,
      },
    ],
  };
}

function isLive(phase: GatewayPhase): boolean {
  return (
    phase === "connecting" ||
    phase === "identifying" ||
    phase === "resuming" ||
    phase === "ready"
  );
}

function clampRandom(random: number): number {
  if (!Number.isFinite(random)) {
    return 0.5;
  }
  return Math.min(Math.max(random, 0), 0.999_999);
}

function connect(state: GatewayState): GatewayTransition {
  if (isLive(state.phase)) {
    return unchanged(state);
  }
  const generation = state.generation + 1;
  return {
    state: {
      ...state,
      phase: "connecting",
      generation,
      heartbeatIntervalMs: undefined,
      awaitingAck: false,
      error: undefined,
    },
    effects: [{ type: "openSocket", generation, resume: canResume(state) }],
  };
}

function stop(state: GatewayState, clearSession: boolean): GatewayTransition {
  const generation = state.generation + 1;
  const base = clearSession ? forgetSession(state) : state;
  return {
    state: {
      ...base,
      phase: "idle",
      generation,
      attempt: 0,
      heartbeatIntervalMs: undefined,
      awaitingAck: false,
      error: undefined,
    },
    effects: [
      {
        type: "closeSocket",
        generation: state.generation,
        code: CLOSE_NORMAL,
        reason: "stopped",
      },
      ...(clearSession
        ? [{ type: "persistSession" as const, session: null }]
        : []),
    ],
  };
}

function forgetSession(state: GatewayState): GatewayState {
  return {
    ...state,
    sessionId: undefined,
    resumeGatewayUrl: undefined,
    sequence: null,
  };
}

interface BackoffOptions {
  readonly reason: string;
  readonly clearSession: boolean;
  readonly delayMs?: number | undefined;
  readonly closeCode?: number | undefined;
}

function backoff(
  state: GatewayState,
  env: GatewayEnv,
  options: BackoffOptions,
): GatewayTransition {
  const base = options.clearSession ? forgetSession(state) : state;
  const delayMs = options.delayMs ?? fullJitterDelay(state.attempt, env.random);
  return {
    state: {
      ...base,
      phase: "backoff",
      attempt: Math.min(state.attempt + 1, MAX_BACKOFF_EXPONENT + 1),
      heartbeatIntervalMs: undefined,
      awaitingAck: false,
      error: boundDiagnostic(options.reason),
    },
    effects: [
      {
        type: "closeSocket",
        generation: state.generation,
        code: options.closeCode ?? CLOSE_ABANDON,
        reason: options.reason,
      },
      ...(options.clearSession
        ? [{ type: "persistSession" as const, session: null }]
        : []),
      {
        type: "scheduleReconnect",
        generation: state.generation,
        delayMs,
      },
    ],
  };
}

function toFatal(state: GatewayState, reason: string): GatewayTransition {
  return {
    state: {
      ...forgetSession(state),
      phase: "fatal",
      heartbeatIntervalMs: undefined,
      awaitingAck: false,
      error: boundDiagnostic(reason),
    },
    effects: [
      {
        type: "closeSocket",
        generation: state.generation,
        code: CLOSE_NORMAL,
        reason,
      },
      { type: "persistSession", session: null },
      { type: "fatal", reason: boundDiagnostic(reason) },
    ],
  };
}

function closed(
  state: GatewayState,
  code: number,
  env: GatewayEnv,
): GatewayTransition {
  if (!isLive(state.phase)) {
    return unchanged(state);
  }
  if (FATAL_CLOSE_CODES.has(code)) {
    return toFatal(state, `gateway closed with code ${code}`);
  }
  // Documented resumable codes always resume; any other abnormal transport
  // close resumes only while a session exists. Everything else identifies
  // fresh.
  const resumable =
    !NON_RESUMABLE_CLOSE_CODES.has(code) &&
    (RESUMABLE_CLOSE_CODES.has(code) ||
      (canResume(state) && code !== CLOSE_NORMAL));
  return backoff(state, env, {
    reason: `gateway closed with code ${code}`,
    clearSession: !resumable,
  });
}

function failure(
  state: GatewayState,
  reason: string,
  fatal: boolean,
  env: GatewayEnv,
): GatewayTransition {
  if (!isLive(state.phase)) {
    return unchanged(state);
  }
  if (fatal) {
    return toFatal(state, reason);
  }
  return backoff(state, env, { reason, clearSession: false });
}

function heartbeatDue(
  state: GatewayState,
  env: GatewayEnv,
): GatewayTransition {
  const interval = state.heartbeatIntervalMs;
  if (interval === undefined || !isLive(state.phase)) {
    return unchanged(state);
  }
  if (state.awaitingAck) {
    // The previous heartbeat was never acknowledged: the connection is a
    // zombie, so drop it and resume on a fresh socket.
    return backoff(state, env, {
      reason: "heartbeat acknowledgement timed out",
      clearSession: false,
    });
  }
  return {
    state: { ...state, awaitingAck: true },
    effects: [
      {
        type: "send",
        generation: state.generation,
        frame: buildHeartbeatFrame(state.sequence),
      },
      {
        type: "scheduleHeartbeat",
        generation: state.generation,
        delayMs: interval,
      },
    ],
  };
}

function frame(
  state: GatewayState,
  raw: string,
  env: GatewayEnv,
): GatewayTransition {
  const parsed = parseGatewayFrame(raw);
  if (!parsed || !isLive(state.phase)) {
    return unchanged(state);
  }
  switch (parsed.op) {
    case OP_HELLO:
      return hello(state, parsed.d, env);
    case OP_HEARTBEAT:
      return heartbeatRequest(state);
    case OP_HEARTBEAT_ACK:
      return state.awaitingAck
        ? { state: { ...state, awaitingAck: false }, effects: [] }
        : unchanged(state);
    case OP_RECONNECT:
      return backoff(state, env, {
        reason: "gateway requested a reconnect",
        clearSession: false,
      });
    case OP_INVALID_SESSION:
      return invalidSession(state, parsed.d === true, env);
    case OP_DISPATCH:
      return dispatch(state, parsed.s, parsed.t, parsed.d, env);
    default:
      return unchanged(state);
  }
}

function hello(
  state: GatewayState,
  data: unknown,
  env: GatewayEnv,
): GatewayTransition {
  if (state.phase !== "connecting") {
    return unchanged(state);
  }
  const interval = parseHelloInterval(data);
  if (interval === undefined) {
    return backoff(state, env, {
      reason: "gateway hello had an unusable heartbeat interval",
      clearSession: false,
    });
  }
  const resume = canResume(state);
  const outbound: OutboundFrame = resume
    ? buildResumeFrame(state.sessionId as string, state.sequence as number)
    : buildIdentifyFrame();
  return {
    state: {
      ...state,
      phase: resume ? "resuming" : "identifying",
      heartbeatIntervalMs: interval,
      awaitingAck: false,
    },
    effects: [
      {
        type: "scheduleHeartbeat",
        generation: state.generation,
        // Discord asks the first heartbeat to be jittered across the interval
        // so fleets do not beat in lockstep.
        delayMs: Math.floor(clampRandom(env.random) * interval),
      },
      { type: "send", generation: state.generation, frame: outbound },
      {
        type: "scheduleReadyTimeout",
        generation: state.generation,
        delayMs: GATEWAY_READY_TIMEOUT_MS,
      },
    ],
  };
}

function heartbeatRequest(state: GatewayState): GatewayTransition {
  const interval = state.heartbeatIntervalMs;
  return {
    state: { ...state, awaitingAck: true },
    effects: [
      {
        type: "send",
        generation: state.generation,
        frame: buildHeartbeatFrame(state.sequence),
      },
      ...(interval === undefined
        ? []
        : [
            {
              type: "scheduleHeartbeat" as const,
              generation: state.generation,
              delayMs: interval,
            },
          ]),
    ],
  };
}

function invalidSession(
  state: GatewayState,
  resumable: boolean,
  env: GatewayEnv,
): GatewayTransition {
  const delayMs =
    INVALID_SESSION_MIN_DELAY_MS +
    Math.floor(
      clampRandom(env.random) *
        (INVALID_SESSION_MAX_DELAY_MS - INVALID_SESSION_MIN_DELAY_MS),
    );
  return backoff(state, env, {
    reason: "gateway invalidated the session",
    clearSession: !(resumable && canResume(state)),
    delayMs,
  });
}

function dispatch(
  state: GatewayState,
  sequence: number | null,
  name: string | null,
  data: unknown,
  env: GatewayEnv,
): GatewayTransition {
  if (sequence === null || sequence <= (state.sequence ?? -1)) {
    return unchanged(state);
  }
  const advanced = { ...state, sequence };
  switch (name) {
    case "READY":
      return ready(advanced, data, env);
    case "RESUMED":
      return resumed(advanced);
    case "MESSAGE_CREATE":
      return messageCreate(advanced, data, env);
    default:
      return unchanged(advanced);
  }
}

function ready(
  state: GatewayState,
  data: unknown,
  env: GatewayEnv,
): GatewayTransition {
  const payload = parseReadyPayload(data);
  if (!payload) {
    return backoff(state, env, {
      reason: "gateway ready payload was unusable",
      clearSession: true,
    });
  }
  const next: GatewayState = {
    ...state,
    phase: "ready",
    attempt: 0,
    awaitingAck: state.awaitingAck,
    sessionId: payload.sessionId,
    botUserId: payload.botUserId,
    resumeGatewayUrl: payload.resumeGatewayUrl,
    error: undefined,
  };
  return {
    state: next,
    effects: [
      { type: "persistSession", session: gatewaySessionOf(next) },
      { type: "ready" },
    ],
  };
}

function resumed(state: GatewayState): GatewayTransition {
  const next: GatewayState = {
    ...state,
    phase: "ready",
    attempt: 0,
    error: undefined,
  };
  const session = gatewaySessionOf(next);
  return {
    state: next,
    effects: [
      ...(session === null
        ? []
        : [{ type: "persistSession" as const, session }]),
      { type: "ready" },
    ],
  };
}

function messageCreate(
  state: GatewayState,
  data: unknown,
  env: GatewayEnv,
): GatewayTransition {
  if (state.phase !== "ready" && state.phase !== "resuming") {
    return unchanged(state);
  }
  const message = parseMessageCreate(data);
  if (!message) {
    return unchanged(state);
  }
  if (message.authorId === state.botUserId) {
    return unchanged(state);
  }
  if (isBotAuthor(data)) {
    return unchanged(state);
  }
  if (!env.policy.allowedChannelIds.includes(message.channelId)) {
    return unchanged(state);
  }
  if (
    message.guildId !== undefined &&
    env.policy.allowedGuildIds.length > 0 &&
    !env.policy.allowedGuildIds.includes(message.guildId)
  ) {
    return unchanged(state);
  }
  return { state, effects: [{ type: "ingest", message }] };
}
