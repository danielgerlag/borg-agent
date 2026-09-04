import type { Disposable } from "@borg/plugin-sdk";
import { nextCronOccurrence } from "./cron";

const MAX_TIMER_DELAY_MS = 2_147_000_000;

export interface SchedulerRunLog {
  readonly ownerPluginId: string;
  readonly id: string;
  readonly schedule: "once" | "cron";
  readonly phase: "started" | "completed" | "failed";
  readonly at: string;
  readonly error?: string;
}

interface ScheduledCallback {
  readonly ownerPluginId: string;
  readonly id: string;
  readonly schedule: "once" | "cron";
  readonly cron?: string;
  runAt: number;
  readonly controller: AbortController;
  readonly callback: (signal: AbortSignal) => void | Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
}

export class SchedulerCore {
  readonly #callbacks = new Map<string, ScheduledCallback>();
  readonly #runningCallbacks = new Set<ScheduledCallback>();
  readonly #listeners = new Set<(log: SchedulerRunLog) => void>();
  #stopped = false;

  schedule(
    ownerPluginId: string,
    id: string,
    runAt: string,
    callback: (signal: AbortSignal) => void | Promise<void>,
  ): Disposable {
    const timestamp = Date.parse(runAt);
    if (!Number.isFinite(timestamp)) {
      throw new Error(`Schedule ${id} has an invalid deadline`);
    }
    return this.#register({
      ownerPluginId,
      id,
      schedule: "once",
      runAt: timestamp,
      callback,
    });
  }

  scheduleCron(
    ownerPluginId: string,
    id: string,
    expression: string,
    callback: (signal: AbortSignal) => void | Promise<void>,
  ): Disposable {
    return this.#register({
      ownerPluginId,
      id,
      schedule: "cron",
      cron: expression,
      runAt: nextCronOccurrence(expression, Date.now()),
      callback,
    });
  }

  cancel(ownerPluginId: string, id: string): boolean {
    const reason = new Error(`Schedule ${id} was cancelled`);
    let cancelled = false;
    const pending = this.#callbacks.get(this.#key(ownerPluginId, id));
    if (pending) {
      cancelled = this.#cancelEntry(pending, reason) || cancelled;
    }
    for (const entry of [...this.#runningCallbacks]) {
      if (entry.ownerPluginId === ownerPluginId && entry.id === id) {
        cancelled = this.#cancelEntry(entry, reason) || cancelled;
      }
    }
    return cancelled;
  }

  cancelOwned(ownerPluginId: string): void {
    for (const entry of [...this.#callbacks.values()]) {
      if (entry.ownerPluginId === ownerPluginId) {
        this.#cancelEntry(
          entry,
          new Error(`Plugin ${ownerPluginId} was deactivated`),
        );
      }
    }
    for (const entry of [...this.#runningCallbacks]) {
      if (entry.ownerPluginId === ownerPluginId) {
        this.#cancelEntry(
          entry,
          new Error(`Plugin ${ownerPluginId} was deactivated`),
        );
      }
    }
  }

  subscribe(listener: (log: SchedulerRunLog) => void): Disposable {
    this.#listeners.add(listener);
    return {
      dispose: () => {
        this.#listeners.delete(listener);
      },
    };
  }

  shutdown(): void {
    if (this.#stopped) {
      return;
    }
    this.#stopped = true;
    for (const entry of [
      ...this.#callbacks.values(),
      ...this.#runningCallbacks,
    ]) {
      this.#cancelEntry(entry, new Error("Scheduler is shutting down"));
    }
    this.#listeners.clear();
  }

  #register(input: {
    readonly ownerPluginId: string;
    readonly id: string;
    readonly schedule: "once" | "cron";
    readonly cron?: string;
    readonly runAt: number;
    readonly callback: (signal: AbortSignal) => void | Promise<void>;
  }): Disposable {
    if (this.#stopped) {
      throw new Error("Scheduler is stopped");
    }
    if (input.id.trim().length === 0) {
      throw new Error("Schedule ID is required");
    }
    const key = this.#key(input.ownerPluginId, input.id);
    if (this.#callbacks.has(key)) {
      throw new Error(
        `Schedule ${input.id} is already registered by ${input.ownerPluginId}`,
      );
    }
    const entry: ScheduledCallback = {
      ownerPluginId: input.ownerPluginId,
      id: input.id,
      schedule: input.schedule,
      ...(input.cron ? { cron: input.cron } : {}),
      runAt: input.runAt,
      controller: new AbortController(),
      callback: input.callback,
    };
    this.#callbacks.set(key, entry);
    this.#arm(key, entry);
    return {
      dispose: () => {
        this.cancel(input.ownerPluginId, input.id);
      },
    };
  }

  #arm(key: string, entry: ScheduledCallback): void {
    const remaining = Math.max(0, entry.runAt - Date.now());
    entry.timer = setTimeout(
      () => {
        if (
          this.#callbacks.get(key) !== entry ||
          entry.controller.signal.aborted
        ) {
          return;
        }
        if (entry.runAt > Date.now()) {
          this.#arm(key, entry);
          return;
        }
        this.#callbacks.delete(key);
        delete entry.timer;
        this.#runningCallbacks.add(entry);
        this.#emit(entry, "started");
        void Promise.resolve()
          .then(() => entry.callback(entry.controller.signal))
          .then(() => {
            this.#emit(entry, "completed");
          })
          .catch((error: unknown) => {
            this.#emit(entry, "failed", error);
            console.error(
              `[kernel] scheduled callback ${entry.ownerPluginId}:${entry.id} failed`,
              error,
            );
          })
          .finally(() => {
            this.#runningCallbacks.delete(entry);
            this.#rearmCron(key, entry);
          });
      },
      Math.min(remaining, MAX_TIMER_DELAY_MS),
    );
  }

  #rearmCron(key: string, entry: ScheduledCallback): void {
    if (
      entry.schedule !== "cron" ||
      !entry.cron ||
      this.#stopped ||
      entry.controller.signal.aborted
    ) {
      return;
    }
    const next: ScheduledCallback = {
      ownerPluginId: entry.ownerPluginId,
      id: entry.id,
      schedule: "cron",
      cron: entry.cron,
      runAt: nextCronOccurrence(entry.cron, Date.now()),
      controller: new AbortController(),
      callback: entry.callback,
    };
    this.#callbacks.set(key, next);
    this.#arm(key, next);
  }

  #cancelEntry(entry: ScheduledCallback, reason: Error): boolean {
    const key = this.#key(entry.ownerPluginId, entry.id);
    const pending = this.#callbacks.get(key) === entry;
    const running = this.#runningCallbacks.delete(entry);
    if (pending) {
      this.#callbacks.delete(key);
    }
    if (entry.timer) {
      clearTimeout(entry.timer);
      delete entry.timer;
    }
    if (pending || running) {
      if (!entry.controller.signal.aborted) {
        entry.controller.abort(reason);
      }
      return true;
    }
    return false;
  }

  #emit(
    entry: ScheduledCallback,
    phase: SchedulerRunLog["phase"],
    error?: unknown,
  ): void {
    const log: SchedulerRunLog = {
      ownerPluginId: entry.ownerPluginId,
      id: entry.id,
      schedule: entry.schedule,
      phase,
      at: new Date().toISOString(),
      ...(error === undefined
        ? {}
        : {
            error:
              error instanceof Error ? error.message : String(error),
          }),
    };
    for (const listener of this.#listeners) {
      try {
        listener(log);
      } catch (listenerError) {
        console.error("[kernel] scheduler run-log listener failed", listenerError);
      }
    }
  }

  #key(ownerPluginId: string, id: string): string {
    return `${ownerPluginId}\u0000${id}`;
  }
}
