import {
  channelInboundMessage,
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

  it("marks kernel emissions as kernel-sourced and keeps plugin claims plugin-sourced", async () => {
    const event = defineEvent({
      id: "borg.test.kernel-sourced",
      payload: z.object({ value: z.string() }).strict(),
    });
    const bus = new CommandEventBus();
    const envelopes: BusEnvelope[] = [];
    bus.on("borg.listener", event, (_payload, envelope) => {
      envelopes.push(envelope);
    });

    await bus.emitKernel(event, { value: "from kernel" });
    await bus.emit("borg.impostor", new Set([event.id]), event, {
      value: "from plugin",
    });

    expect(envelopes.map(({ source }) => source)).toEqual([
      { kind: "kernel", id: "kernel" },
      { kind: "plugin", id: "borg.impostor" },
    ]);
    await expect(
      bus.emitKernel(event, { value: 7 } as unknown as { value: string }),
    ).rejects.toThrow(/did not match its contract/);
    expect(envelopes).toHaveLength(2);
  });

  it("rejects plugin emission of kernel-only inbound channel events", async () => {
    const bus = new CommandEventBus();
    const received: unknown[] = [];
    bus.onById("borg.graphs", channelInboundMessage.id, (payload) => {
      received.push(payload);
    });

    await expect(
      bus.emit(
        "borg.impostor",
        new Set([channelInboundMessage.id]),
        channelInboundMessage,
        {
          id: "11111111-1111-4111-8111-111111111111",
          channelId: "borg.channel.mock:default",
          text: "forged inbound",
          metadata: {},
          receivedAt: new Date().toISOString(),
        },
      ),
    ).rejects.toThrow(/reserved for kernel emission/);
    expect(received).toEqual([]);
  });
});
