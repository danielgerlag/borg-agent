import { defineCommand } from "@borg/contracts";
import { z } from "@borg/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import { CommandEventBus } from "../src";

describe("CommandEventBus cancellation", () => {
  it("propagates an invoking operation's abort signal to the handler", async () => {
    const command = defineCommand({
      id: "borg.test.wait",
      input: z.object({}),
      output: z.object({ done: z.boolean() }),
      timeoutMs: 1_000,
    });
    const bus = new CommandEventBus();
    let handlerSignal: AbortSignal | undefined;
    bus.handle(
      "borg.test",
      new Set([command.id]),
      command,
      (_input, signal) =>
        new Promise((_resolve, reject) => {
          handlerSignal = signal;
          signal.addEventListener(
            "abort",
            () => reject(signal.reason),
            { once: true },
          );
        }),
    );
    const controller = new AbortController();
    const invocation = bus.invoke(command, {}, { signal: controller.signal });
    await vi.waitFor(() => expect(handlerSignal).toBeDefined());
    controller.abort(new Error("caller stopped"));

    await expect(invocation).rejects.toMatchObject({
      code: "failed",
    });
    expect(handlerSignal?.aborted).toBe(true);
  });

  it("keeps cancellation authoritative when an abort-aware handler resolves", async () => {
    const command = defineCommand({
      id: "borg.test.cooperative-cancel",
      input: z.object({}),
      output: z.object({ done: z.boolean() }),
      timeoutMs: 1_000,
    });
    const bus = new CommandEventBus();
    bus.handle(
      "borg.test",
      new Set([command.id]),
      command,
      (_input, signal) =>
        new Promise((resolve) => {
          signal.addEventListener(
            "abort",
            () => resolve({ done: true }),
            { once: true },
          );
        }),
    );
    const controller = new AbortController();
    const invocation = bus.invoke(command, {}, { signal: controller.signal });
    controller.abort(new Error("caller stopped"));

    await expect(invocation).rejects.toMatchObject({
      code: "failed",
    });
  });
});
