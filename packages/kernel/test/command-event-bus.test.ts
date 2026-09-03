import {
  defineCommand,
  defineEvent,
  type BusEnvelope,
} from "@borg/contracts";
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

  it("preserves correlation while identifying nested event emitters", async () => {
    const command = defineCommand({
      id: "borg.test.correlated",
      input: z.object({}),
      output: z.object({ done: z.boolean() }),
    });
    const event = defineEvent({
      id: "borg.test.correlated.completed",
      payload: z.object({}),
    });
    const bus = new CommandEventBus();
    let commandEnvelope: BusEnvelope | undefined;
    let eventEnvelope: BusEnvelope | undefined;
    bus.on("borg.listener", event, (_payload, envelope) => {
      eventEnvelope = envelope;
    });
    bus.handle(
      "borg.test",
      new Set([command.id]),
      command,
      async (_input, _signal, envelope) => {
        commandEnvelope = envelope;
        await bus.emit("borg.test", new Set([event.id]), event, {});
        return { done: true };
      },
    );

    await bus.invoke(command, {}, {
      source: { kind: "renderer", id: "17" },
    });
    expect(commandEnvelope).toMatchObject({
      source: { kind: "renderer", id: "17" },
    });
    expect(eventEnvelope).toMatchObject({
      correlationId: commandEnvelope?.correlationId,
      causationId: command.id,
      source: { kind: "plugin", id: "borg.test" },
    });
  });
});
