import type {
  ChannelInboundDraft,
  Disposable,
  JsonValue,
  PluginLogger,
  PluginWebSocketConnection,
  PluginWebSockets,
} from "@borg/plugin-sdk";
import {
  initialGatewayState,
  reduceGateway,
  type GatewayEffect,
  type GatewayEvent,
  type GatewayPhase,
  type GatewayPolicy,
  type GatewaySessionRecord,
  type GatewayState,
} from "./gateway";
import {
  CLOSE_NORMAL,
  MAX_GATEWAY_FRAME_CHARS,
  MAX_SESSION_START_WAIT_MS,
  boundDiagnostic,
  encodeOutboundFrame,
  withGatewayQuery,
  type DiscordInboundMessage,
  type OutboundFrame,
} from "./protocol";
import { DiscordRestError, type DiscordRestClient } from "./rest";
import type { GatewaySessionStore } from "./session-store";

const MAX_CLOSE_REASON_CHARS = 100;
const GATEWAY_SEND_LIMIT = 120;
const GATEWAY_SEND_WINDOW_MS = 60_000;

export interface GatewayTimer {
  cancel(): void;
}

export interface GatewayClock {
  setTimer(callback: () => void, delayMs: number): GatewayTimer;
}

export const systemGatewayClock: GatewayClock = {
  setTimer(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    return {
      cancel: () => {
        clearTimeout(timer);
      },
    };
  },
};

export interface DiscordGatewayRuntimeOptions {
  readonly webSockets: PluginWebSockets;
  readonly rest: DiscordRestClient;
  readonly readToken: () => Promise<string | undefined>;
  readonly ingest: (draft: ChannelInboundDraft) => void | Promise<void>;
  readonly policy: GatewayPolicy;
  readonly session: GatewaySessionStore;
  readonly logger: PluginLogger;
  readonly clock?: GatewayClock | undefined;
  readonly random?: (() => number) | undefined;
  readonly now?: (() => number) | undefined;
}

export interface DiscordGatewaySnapshot {
  readonly phase: GatewayPhase;
  readonly connected: boolean;
  readonly botUserId: string | undefined;
  readonly error: string | undefined;
}

interface SocketCycle {
  readonly generation: number;
  readonly controller: AbortController;
  connection: PluginWebSocketConnection | undefined;
  handlers: Disposable[];
  closed: boolean;
}

interface ReadyWaiter {
  resolve(): void;
  reject(error: Error): void;
  timer: GatewayTimer | undefined;
}

/**
 * Drives the pure gateway reducer against the host WebSocket facade. Each
 * socket lifecycle owns a generation, an AbortController, and its own handler
 * disposables, so a socket, timer, or in-flight promise from a previous cycle
 * can never write into the current one.
 */
export class DiscordGatewayRuntime {
  readonly #webSockets: PluginWebSockets;
  readonly #rest: DiscordRestClient;
  readonly #readToken: () => Promise<string | undefined>;
  readonly #ingest: (draft: ChannelInboundDraft) => void | Promise<void>;
  readonly #policy: GatewayPolicy;
  readonly #session: GatewaySessionStore;
  readonly #logger: PluginLogger;
  readonly #clock: GatewayClock;
  readonly #random: () => number;
  readonly #now: () => number;
  readonly #sendTimes: number[] = [];
  readonly #readyWaiters = new Set<ReadyWaiter>();
  readonly #finished: Promise<void>;
  #settleFinished: (() => void) | undefined;
  #state: GatewayState = initialGatewayState();
  #cycle: SocketCycle | undefined;
  #helloTimer: GatewayTimer | undefined;
  #readyTimer: GatewayTimer | undefined;
  #heartbeatTimer: GatewayTimer | undefined;
  #reconnectTimer: GatewayTimer | undefined;
  #started = false;
  #stopped = false;
  #desiredSession: GatewaySessionRecord | null | undefined;
  #persistQueue: Promise<void> = Promise.resolve();

  constructor(options: DiscordGatewayRuntimeOptions) {
    this.#webSockets = options.webSockets;
    this.#rest = options.rest;
    this.#readToken = options.readToken;
    this.#ingest = options.ingest;
    this.#policy = options.policy;
    this.#session = options.session;
    this.#logger = options.logger;
    this.#clock = options.clock ?? systemGatewayClock;
    this.#random = options.random ?? Math.random;
    this.#now = options.now ?? Date.now;
    this.#finished = new Promise<void>((resolve) => {
      this.#settleFinished = resolve;
    });
  }

  get state(): GatewayState {
    return this.#state;
  }

  snapshot(): DiscordGatewaySnapshot {
    return {
      phase: this.#state.phase,
      connected: this.#state.phase === "ready",
      botUserId: this.#state.botUserId,
      error: this.#state.error,
    };
  }

  async run(signal: AbortSignal): Promise<void> {
    if (this.#started) {
      await this.#finished;
      return;
    }
    this.#started = true;
    if (signal.aborted) {
      this.#finish();
      return;
    }
    const onAbort = (): void => {
      void this.stop({ clearSession: false });
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const restored = await this.#session.load();
      if (!this.#stopped) {
        this.#state = initialGatewayState(restored);
        this.#dispatch({ type: "connect" }, this.#state.generation);
      }
      await this.#finished;
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  whenReady(timeoutMs: number): Promise<void> {
    if (this.#state.phase === "ready") {
      return Promise.resolve();
    }
    if (this.#stopped) {
      return Promise.reject(new Error("Discord gateway is not running"));
    }
    if (this.#state.phase === "fatal") {
      return Promise.reject(
        new Error(this.#state.error ?? "Discord gateway stopped permanently"),
      );
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: ReadyWaiter = { resolve, reject, timer: undefined };
      waiter.timer = this.#clock.setTimer(() => {
        this.#readyWaiters.delete(waiter);
        reject(new Error("Discord gateway did not become ready in time"));
      }, timeoutMs);
      this.#readyWaiters.add(waiter);
    });
  }

  async stop(options: { readonly clearSession: boolean }): Promise<void> {
    if (this.#stopped) {
      await this.#finished;
      return;
    }
    this.#stopped = true;
    this.#dispatch(
      { type: "stop", clearSession: options.clearSession },
      this.#state.generation,
    );
    this.#cancelTimers();
    this.#rejectWaiters(new Error("Discord gateway stopped"));
    this.#finish();
    await this.#finished;
  }

  #finish(): void {
    this.#stopped = true;
    const settle = this.#settleFinished;
    this.#settleFinished = undefined;
    settle?.();
  }

  #dispatch(event: GatewayEvent, generation: number): void {
    if (generation !== this.#state.generation) {
      return;
    }
    if (this.#stopped && event.type !== "stop") {
      return;
    }
    const transition = reduceGateway(this.#state, event, {
      random: this.#random(),
      policy: this.#policy,
    });
    const previousPhase = this.#state.phase;
    this.#state = transition.state;
    if (
      previousPhase === "connecting" &&
      this.#state.phase !== "connecting"
    ) {
      this.#helloTimer?.cancel();
      this.#helloTimer = undefined;
    }
    if (
      (previousPhase === "identifying" || previousPhase === "resuming") &&
      this.#state.phase !== "identifying" &&
      this.#state.phase !== "resuming"
    ) {
      this.#readyTimer?.cancel();
      this.#readyTimer = undefined;
    }
    if (this.#state.heartbeatIntervalMs === undefined) {
      this.#heartbeatTimer?.cancel();
      this.#heartbeatTimer = undefined;
    }
    for (const effect of transition.effects) {
      this.#apply(effect);
    }
  }

  #apply(effect: GatewayEffect): void {
    switch (effect.type) {
      case "openSocket": {
        this.#sendTimes.length = 0;
        const cycle: SocketCycle = {
          generation: effect.generation,
          controller: new AbortController(),
          connection: undefined,
          handlers: [],
          closed: false,
        };
        this.#cycle = cycle;
        void this.#openSocket(cycle, effect.resume);
        return;
      }
      case "send":
        void this.#send(effect.generation, effect.frame);
        return;
      case "closeSocket":
        this.#closeCycle(this.#cycle, effect.code, effect.reason);
        return;
      case "scheduleHeartbeat": {
        this.#heartbeatTimer?.cancel();
        const generation = effect.generation;
        this.#heartbeatTimer = this.#clock.setTimer(() => {
          this.#heartbeatTimer = undefined;
          this.#dispatch({ type: "heartbeatDue" }, generation);
        }, effect.delayMs);
        return;
      }
      case "scheduleReconnect": {
        this.#reconnectTimer?.cancel();
        const generation = effect.generation;
        this.#reconnectTimer = this.#clock.setTimer(() => {
          this.#reconnectTimer = undefined;
          this.#dispatch({ type: "connect" }, generation);
        }, effect.delayMs);
        return;
      }
      case "scheduleHelloTimeout": {
        this.#helloTimer?.cancel();
        const generation = effect.generation;
        this.#helloTimer = this.#clock.setTimer(() => {
          this.#helloTimer = undefined;
          this.#dispatch({ type: "helloTimeout" }, generation);
        }, effect.delayMs);
        return;
      }
      case "scheduleReadyTimeout": {
        this.#readyTimer?.cancel();
        const generation = effect.generation;
        this.#readyTimer = this.#clock.setTimer(() => {
          this.#readyTimer = undefined;
          this.#dispatch({ type: "readyTimeout" }, generation);
        }, effect.delayMs);
        return;
      }
      case "ingest":
        this.#emitInbound(effect.message);
        return;
      case "persistSession":
        this.#enqueuePersist(effect.session);
        return;
      case "ready":
        this.#resolveWaiters();
        return;
      case "fatal":
        this.#logger.error("Discord gateway stopped permanently", {
          reason: effect.reason,
        });
        this.#rejectWaiters(new Error(effect.reason));
        return;
      default:
        return;
    }
  }

  async #openSocket(cycle: SocketCycle, resume: boolean): Promise<void> {
    try {
      const target = await this.#resolveGatewayUrl(cycle, resume);
      if (this.#isStale(cycle)) {
        return;
      }
      const connection = await this.#webSockets.connect(target, {
        signal: cycle.controller.signal,
        maxMessageBytes: MAX_GATEWAY_FRAME_CHARS,
      });
      if (this.#isStale(cycle)) {
        closeQuietly(connection, CLOSE_NORMAL, "stale");
        return;
      }
      cycle.connection = connection;
      cycle.handlers = [
        connection.onMessage((data) => {
          this.#dispatch({ type: "frame", raw: data }, cycle.generation);
        }),
        connection.onClose((code) => {
          this.#dispatch({ type: "socketClosed", code }, cycle.generation);
        }),
        connection.onError((error) => {
          this.#dispatch(
            {
              type: "failure",
              reason: boundDiagnostic(error.message),
              fatal: false,
            },
            cycle.generation,
          );
        }),
      ];
      await connection.ready;
      if (this.#isStale(cycle)) {
        this.#closeCycle(cycle, CLOSE_NORMAL, "stale");
        return;
      }
      this.#dispatch({ type: "socketOpen" }, cycle.generation);
    } catch (error) {
      if (this.#isStale(cycle)) {
        return;
      }
      const fatal = error instanceof DiscordRestError && error.fatal;
      this.#dispatch(
        { type: "failure", reason: describeFailure(error), fatal },
        cycle.generation,
      );
    }
  }

  async #resolveGatewayUrl(
    cycle: SocketCycle,
    resume: boolean,
  ): Promise<string> {
    const resumeUrl = this.#state.resumeGatewayUrl;
    if (resume && resumeUrl !== undefined) {
      return withGatewayQuery(resumeUrl);
    }
    const discovery = await this.#rest.discoverGateway(cycle.controller.signal);
    const limit = discovery.sessionStartLimit;
    if (limit !== undefined && limit.remaining <= 0) {
      const waitMs = Math.min(limit.resetAfterMs, MAX_SESSION_START_WAIT_MS);
      this.#logger.warn("Discord session starts are exhausted", {
        waitMs,
      });
      await this.#wait(cycle, waitMs);
      if (limit.resetAfterMs > MAX_SESSION_START_WAIT_MS) {
        throw new Error("Discord session start limit remains exhausted");
      }
    }
    return withGatewayQuery(discovery.url);
  }

  #wait(cycle: SocketCycle, delayMs: number): Promise<void> {
    if (delayMs <= 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const timer = this.#clock.setTimer(() => {
        cycle.controller.signal.removeEventListener("abort", onAbort);
        resolve();
      }, delayMs);
      const onAbort = (): void => {
        timer.cancel();
        resolve();
      };
      cycle.controller.signal.addEventListener("abort", onAbort, {
        once: true,
      });
    });
  }

  async #send(generation: number, frame: OutboundFrame): Promise<void> {
    const cycle = this.#cycle;
    if (!cycle || cycle.generation !== generation || cycle.closed) {
      return;
    }
    const now = this.#now();
    while (
      this.#sendTimes.length > 0 &&
      (this.#sendTimes[0] ?? now) <= now - GATEWAY_SEND_WINDOW_MS
    ) {
      this.#sendTimes.shift();
    }
    if (this.#sendTimes.length >= GATEWAY_SEND_LIMIT) {
      this.#dispatch(
        {
          type: "failure",
          reason: "Discord gateway send rate limit reached",
          fatal: false,
        },
        generation,
      );
      return;
    }
    let token = "";
    if ("withToken" in frame) {
      try {
        token = (await this.#readToken()) ?? "";
      } catch {
        token = "";
      }
      if (token.length === 0) {
        this.#dispatch(
          {
            type: "failure",
            reason: "Discord bot token is not saved",
            fatal: true,
          },
          generation,
        );
        return;
      }
    }
    if (this.#isStale(cycle) || cycle.connection === undefined) {
      return;
    }
    try {
      cycle.connection.send(encodeOutboundFrame(frame, token));
      this.#sendTimes.push(now);
    } catch (error) {
      this.#dispatch(
        { type: "failure", reason: describeFailure(error), fatal: false },
        generation,
      );
    }
  }

  #emitInbound(message: DiscordInboundMessage): void {
    const metadata: Record<string, JsonValue> = {
      source: "discord",
      messageId: message.id,
      channelId: message.channelId,
      authorId: message.authorId,
      authorName: message.authorName,
    };
    if (message.guildId !== undefined) {
      metadata.guildId = message.guildId;
    }
    if (message.threadId !== undefined) {
      metadata.threadId = message.threadId;
    }
    const draft: ChannelInboundDraft = {
      text: message.content,
      destinationId: message.channelId,
      externalId: message.id,
      sender: message.authorId,
      classification: "internal",
      metadata,
    };
    void Promise.resolve()
      .then(() => this.#ingest(draft))
      .catch((error: unknown) => {
        this.#logger.warn("Discord inbound message was not accepted", {
          reason: describeFailure(error),
        });
      });
  }

  #enqueuePersist(session: GatewaySessionRecord | null): void {
    this.#desiredSession = session;
    this.#persistQueue = this.#persistQueue
      .then(async () => {
        if (this.#desiredSession === undefined) {
          return;
        }
        const next = this.#desiredSession;
        this.#desiredSession = undefined;
        await this.#session.save(next);
      })
      .catch(() => {
        this.#logger.warn("Discord gateway session could not be persisted");
      });
  }

  #isStale(cycle: SocketCycle): boolean {
    return (
      this.#stopped ||
      this.#cycle !== cycle ||
      cycle.closed ||
      cycle.generation !== this.#state.generation
    );
  }

  #closeCycle(
    cycle: SocketCycle | undefined,
    code: number,
    reason: string,
  ): void {
    if (!cycle || cycle.closed) {
      return;
    }
    cycle.closed = true;
    for (const handler of cycle.handlers) {
      try {
        void handler.dispose();
      } catch {
      }
    }
    cycle.handlers = [];
    const connection = cycle.connection;
    cycle.connection = undefined;
    if (connection) {
      closeQuietly(connection, code, reason);
    }
    if (!cycle.controller.signal.aborted) {
      cycle.controller.abort(new Error(boundDiagnostic(reason)));
    }
    if (this.#cycle === cycle) {
      this.#cycle = undefined;
    }
  }

  #cancelTimers(): void {
    this.#helloTimer?.cancel();
    this.#helloTimer = undefined;
    this.#readyTimer?.cancel();
    this.#readyTimer = undefined;
    this.#heartbeatTimer?.cancel();
    this.#heartbeatTimer = undefined;
    this.#reconnectTimer?.cancel();
    this.#reconnectTimer = undefined;
  }

  #resolveWaiters(): void {
    for (const waiter of [...this.#readyWaiters]) {
      this.#readyWaiters.delete(waiter);
      waiter.timer?.cancel();
      waiter.resolve();
    }
  }

  #rejectWaiters(error: Error): void {
    for (const waiter of [...this.#readyWaiters]) {
      this.#readyWaiters.delete(waiter);
      waiter.timer?.cancel();
      waiter.reject(error);
    }
  }
}

function closeQuietly(
  connection: PluginWebSocketConnection,
  code: number,
  reason: string,
): void {
  try {
    connection.close(code, reason.slice(0, MAX_CLOSE_REASON_CHARS));
  } catch {
  }
  try {
    void connection.dispose();
  } catch {
  }
}

function describeFailure(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return boundDiagnostic(error.message);
  }
  return "Discord gateway failed";
}
