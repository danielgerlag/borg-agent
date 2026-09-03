import type { Disposable } from "@borg/plugin-sdk";

const MAX_TIMER_DELAY_MS = 2_147_000_000;

interface ScheduledCallback {
  readonly ownerPluginId: string;
  readonly id: string;
  readonly runAt: number;
  readonly controller: AbortController;
  readonly callback: (signal: AbortSignal) => void | Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
}

export class SchedulerCore {
  readonly #callbacks = new Map<string, ScheduledCallback>();
  readonly #runningCallbacks = new Set<ScheduledCallback>();
  #stopped = false;

  schedule(
    ownerPluginId: string,
    id: string,
    runAt: string,
    callback: (signal: AbortSignal) => void | Promise<void>,
  ): Disposable {
    if (this.#stopped) {
      throw new Error("Scheduler is stopped");
    }
    if (id.trim().length === 0) {
      throw new Error("Schedule ID is required");
    }
    const timestamp = Date.parse(runAt);
    if (!Number.isFinite(timestamp)) {
      throw new Error(`Schedule ${id} has an invalid deadline`);
    }
    const key = this.#key(ownerPluginId, id);
    if (this.#callbacks.has(key)) {
      throw new Error(`Schedule ${id} is already registered by ${ownerPluginId}`);
    }
    const entry: ScheduledCallback = {
      ownerPluginId,
      id,
      runAt: timestamp,
      controller: new AbortController(),
      callback,
    };
    this.#callbacks.set(key, entry);
    this.#arm(key, entry);
    return {
      dispose: () => {
        this.#cancelEntry(
          entry,
          new Error(`Schedule ${id} was cancelled`),
        );
      },
    };
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
        void Promise.resolve()
          .then(() => entry.callback(entry.controller.signal))
          .catch((error: unknown) =>
            console.error(
              `[kernel] scheduled callback ${entry.ownerPluginId}:${entry.id} failed`,
              error,
            ),
          )
          .finally(() => {
            this.#runningCallbacks.delete(entry);
          });
      },
      Math.min(remaining, MAX_TIMER_DELAY_MS),
    );
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
      entry.controller.abort(reason);
      return true;
    }
    return false;
  }

  #key(ownerPluginId: string, id: string): string {
    return `${ownerPluginId}\u0000${id}`;
  }
}
