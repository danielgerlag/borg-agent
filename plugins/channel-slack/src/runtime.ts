import type {
  ChannelInboundDraft,
  Disposable,
  JsonValue,
  PluginLogger,
  PluginWebSocketConnection,
  PluginWebSockets,
} from "@borg/plugin-sdk";
import {
  initialSocketState,
  reduceSocket,
  type SocketEffect,
  type SocketEvent,
  type SocketPhase,
  type SocketPolicy,
  type SocketState,
} from "./gateway";
import {
  CLOSE_NORMAL,
  MAX_ENVELOPE_CHARS,
  boundDiagnostic,
  type SlackInboundMessage,
} from "./protocol";
import { SlackRestError, type SlackRestClient } from "./rest";

const MAX_CLOSE_REASON_CHARS = 100;

export interface SocketTimer {
  cancel(): void;
}

export interface SocketClock {
  setTimer(callback: () => void, delayMs: number): SocketTimer;
}

export const systemSocketClock: SocketClock = {
  setTimer(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    return {
      cancel: () => {
        clearTimeout(timer);
      },
    };
  },
};

export interface SlackSocketRuntimeOptions {
  readonly webSockets: PluginWebSockets;
  readonly rest: SlackRestClient;
  readonly ingest: (draft: ChannelInboundDraft) => void | Promise<void>;
  readonly policy: SocketPolicy;
  readonly logger: PluginLogger;
  readonly clock?: SocketClock | undefined;
  readonly random?: (() => number) | undefined;
}

export interface SlackSocketSnapshot {
  readonly phase: SocketPhase;
  readonly connected: boolean;
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
  timer: SocketTimer | undefined;
}

export class SlackSocketRuntime {
  readonly #webSockets: PluginWebSockets;
  readonly #rest: SlackRestClient;
  readonly #ingest: (draft: ChannelInboundDraft) => void | Promise<void>;
  readonly #policy: SocketPolicy;
  readonly #logger: PluginLogger;
  readonly #clock: SocketClock;
  readonly #random: () => number;
  readonly #readyWaiters = new Set<ReadyWaiter>();
  readonly #finished: Promise<void>;
  #settleFinished: (() => void) | undefined;
  #state: SocketState = initialSocketState();
  #cycle: SocketCycle | undefined;
  #helloTimer: SocketTimer | undefined;
  #reconnectTimer: SocketTimer | undefined;
  #stableTimer: SocketTimer | undefined;
  #started = false;
  #stopped = false;

  constructor(options: SlackSocketRuntimeOptions) {
    this.#webSockets = options.webSockets;
    this.#rest = options.rest;
    this.#ingest = options.ingest;
    this.#policy = options.policy;
    this.#logger = options.logger;
    this.#clock = options.clock ?? systemSocketClock;
    this.#random = options.random ?? Math.random;
    this.#finished = new Promise<void>((resolve) => {
      this.#settleFinished = resolve;
    });
  }

  get state(): SocketState {
    return this.#state;
  }

  snapshot(): SlackSocketSnapshot {
    return {
      phase: this.#state.phase,
      connected: this.#state.phase === "ready",
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
      void this.stop();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      if (!this.#stopped) {
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
      return Promise.reject(new Error("Slack Socket Mode is not running"));
    }
    if (this.#state.phase === "fatal") {
      return Promise.reject(
        new Error(this.#state.error ?? "Slack Socket Mode stopped permanently"),
      );
    }
    return new Promise<void>((resolve, reject) => {
      const waiter: ReadyWaiter = { resolve, reject, timer: undefined };
      waiter.timer = this.#clock.setTimer(() => {
        this.#readyWaiters.delete(waiter);
        reject(new Error("Slack Socket Mode did not become ready in time"));
      }, timeoutMs);
      this.#readyWaiters.add(waiter);
    });
  }

  async stop(): Promise<void> {
    if (this.#stopped) {
      await this.#finished;
      return;
    }
    this.#stopped = true;
    this.#dispatch({ type: "stop" }, this.#state.generation);
    this.#cancelTimers();
    this.#rejectWaiters(new Error("Slack Socket Mode stopped"));
    this.#finish();
    await this.#finished;
  }

  #finish(): void {
    this.#stopped = true;
    const settle = this.#settleFinished;
    this.#settleFinished = undefined;
    settle?.();
  }

  #dispatch(event: SocketEvent, generation: number): void {
    if (generation !== this.#state.generation) {
      return;
    }
    if (this.#stopped && event.type !== "stop") {
      return;
    }
    const transition = reduceSocket(this.#state, event, {
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
    if (previousPhase === "ready" && this.#state.phase !== "ready") {
      this.#stableTimer?.cancel();
      this.#stableTimer = undefined;
    }
    for (const effect of transition.effects) {
      this.#apply(effect);
    }
  }

  #apply(effect: SocketEffect): void {
    switch (effect.type) {
      case "openSocket": {
        const cycle: SocketCycle = {
          generation: effect.generation,
          controller: new AbortController(),
          connection: undefined,
          handlers: [],
          closed: false,
        };
        this.#cycle = cycle;
        void this.#openSocket(cycle);
        return;
      }
      case "send":
        void this.#send(effect.generation, effect.payload);
        return;
      case "closeSocket":
        this.#closeCycle(this.#cycle, effect.code, effect.reason);
        return;
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
      case "scheduleStable": {
        this.#stableTimer?.cancel();
        const generation = effect.generation;
        this.#stableTimer = this.#clock.setTimer(() => {
          this.#stableTimer = undefined;
          this.#dispatch({ type: "sessionStable" }, generation);
        }, effect.delayMs);
        return;
      }
      case "ingest":
        this.#emitInbound(effect.message);
        return;
      case "log":
        this.#logger[effect.level](effect.message);
        return;
      case "ready":
        this.#resolveWaiters();
        return;
      case "fatal":
        this.#logger.error("Slack Socket Mode stopped permanently", {
          reason: effect.reason,
        });
        this.#rejectWaiters(new Error(effect.reason));
        return;
      default: {
        const _exhaustive: never = effect;
        return _exhaustive;
      }
    }
  }

  async #openSocket(cycle: SocketCycle): Promise<void> {
    try {
      const opened = await this.#rest.openConnection(cycle.controller.signal);
      if (this.#isStale(cycle)) {
        return;
      }
      const connection = await this.#webSockets.connect(opened.url, {
        signal: cycle.controller.signal,
        maxMessageBytes: MAX_ENVELOPE_CHARS,
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
      const fatal = error instanceof SlackRestError && error.fatal;
      this.#dispatch(
        { type: "failure", reason: describeFailure(error), fatal },
        cycle.generation,
      );
    }
  }

  async #send(generation: number, payload: string): Promise<void> {
    const cycle = this.#cycle;
    if (!cycle || cycle.generation !== generation || cycle.closed) {
      return;
    }
    if (this.#isStale(cycle) || cycle.connection === undefined) {
      return;
    }
    try {
      cycle.connection.send(payload);
    } catch (error) {
      this.#dispatch(
        { type: "failure", reason: describeFailure(error), fatal: false },
        generation,
      );
    }
  }

  #emitInbound(message: SlackInboundMessage): void {
    const metadata: Record<string, JsonValue> = {
      source: "slack",
      ts: message.ts,
      channelId: message.channelId,
      userId: message.userId,
    };
    if (message.userName !== undefined) {
      metadata.userName = message.userName;
    }
    if (message.threadTs !== undefined) {
      metadata.threadTs = message.threadTs;
    }
    const draft: ChannelInboundDraft = {
      text: message.text,
      destinationId: message.channelId,
      externalId: message.ts,
      sender: message.userId,
      classification: "internal",
      metadata,
    };
    void Promise.resolve()
      .then(() => this.#ingest(draft))
      .catch((error: unknown) => {
        this.#logger.warn("Slack inbound message was not accepted", {
          reason: describeFailure(error),
        });
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
    this.#reconnectTimer?.cancel();
    this.#reconnectTimer = undefined;
    this.#stableTimer?.cancel();
    this.#stableTimer = undefined;
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
  return "Slack Socket Mode failed";
}
