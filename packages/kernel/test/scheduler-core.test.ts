import { afterEach, describe, expect, it, vi } from "vitest";
import { SchedulerCore } from "../src/scheduler-core";

describe("SchedulerCore", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires a plugin-owned callback at its deadline", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T17:00:00.000Z"));
    const scheduler = new SchedulerCore();
    const callback = vi.fn();

    scheduler.schedule(
      "borg.graphs",
      "delay:one",
      "2026-09-03T17:00:01.000Z",
      callback,
    );
    await vi.advanceTimersByTimeAsync(999);
    expect(callback).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(callback).toHaveBeenCalledOnce();
    expect(callback.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
  });

  it("cancels every outstanding callback owned by a plugin", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T17:00:00.000Z"));
    const scheduler = new SchedulerCore();
    const graphCallback = vi.fn();
    const otherCallback = vi.fn();

    scheduler.schedule(
      "borg.graphs",
      "schedule:first",
      "2026-09-03T17:00:01.000Z",
      graphCallback,
    );
    scheduler.schedule(
      "borg.other",
      "schedule:first",
      "2026-09-03T17:00:01.000Z",
      otherCallback,
    );
    scheduler.cancelOwned("borg.graphs");
    await vi.advanceTimersByTimeAsync(1_000);

    expect(graphCallback).not.toHaveBeenCalled();
    expect(otherCallback).toHaveBeenCalledOnce();
  });

  it("rejects duplicate owner-scoped schedule IDs", () => {
    vi.useFakeTimers();
    const scheduler = new SchedulerCore();
    const runAt = new Date(Date.now() + 1_000).toISOString();
    scheduler.schedule("borg.graphs", "same", runAt, () => undefined);

    expect(() =>
      scheduler.schedule("borg.graphs", "same", runAt, () => undefined),
    ).toThrow("already registered");
  });

  it("contains synchronous callback failures", async () => {
    vi.useFakeTimers();
    const scheduler = new SchedulerCore();
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    scheduler.schedule(
      "borg.graphs",
      "throws",
      new Date(Date.now()).toISOString(),
      () => {
        throw new Error("scheduled failure");
      },
    );

    await vi.runAllTimersAsync();

    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("scheduled callback borg.graphs:throws failed"),
      expect.objectContaining({ message: "scheduled failure" }),
    );
    consoleError.mockRestore();
  });

  it("aborts a callback that is already running", async () => {
    vi.useFakeTimers();
    const scheduler = new SchedulerCore();
    let callbackSignal: AbortSignal | undefined;
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    scheduler.schedule(
      "borg.graphs",
      "running",
      new Date(Date.now()).toISOString(),
      async (signal) => {
        callbackSignal = signal;
        await pending;
      },
    );
    await vi.advanceTimersByTimeAsync(0);

    scheduler.cancelOwned("borg.graphs");

    expect(callbackSignal?.aborted).toBe(true);
    finish();
    await vi.runAllTimersAsync();
  });
});
