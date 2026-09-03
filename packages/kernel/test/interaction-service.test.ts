import { feedbackAskInputSchema } from "@borg/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  InteractionCancelledError,
  InteractionService,
  InteractionTimedOutError,
} from "../src";

describe("InteractionService", () => {
  it("allows only the first valid terminal response", async () => {
    const service = new InteractionService();
    const snapshots: number[] = [];
    service.subscribe((pending) => {
      snapshots.push(pending.length);
    });
    const wait = service.requestSafety({
      kind: "tool_approval",
      title: "Approve tool",
      prompt: "Allow tools.echo?",
      source: {
        pluginId: "kernel.loop",
        feature: "tool",
      },
    });

    expect(service.listPending()).toHaveLength(1);
    expect(
      service.respond(wait.interaction.id, {
        kind: "approval",
        decision: "allow",
      }),
    ).toBe(true);
    expect(
      service.respond(wait.interaction.id, {
        kind: "approval",
        decision: "deny",
      }),
    ).toBe(false);
    await expect(wait.response).resolves.toEqual({
      kind: "approval",
      decision: "allow",
    });
    await vi.waitFor(() => expect(snapshots).toContain(0));
  });

  it("validates the response against the requested form", () => {
    const service = new InteractionService();
    const wait = service.requestHumanInput("borg.feedback", {
      prompt: "Name?",
      form: "text",
      source: {},
    });
    expect(() =>
      service.respond(wait.interaction.id, {
        kind: "approval",
        decision: "allow",
      }),
    ).toThrow(/text response/);
    service.cancelAll();
    void wait.response.catch(() => undefined);
  });

  it("accepts confirmation and declared choice responses", async () => {
    const service = new InteractionService();
    const confirmation = service.requestHumanInput("borg.feedback", {
      prompt: "Continue?",
      form: "confirm",
      source: {},
    });
    expect(
      service.respond(confirmation.interaction.id, {
        kind: "confirm",
        confirmed: true,
      }),
    ).toBe(true);
    await expect(confirmation.response).resolves.toEqual({
      kind: "confirm",
      confirmed: true,
    });

    const choice = service.requestHumanInput("borg.feedback", {
      prompt: "Pick one",
      form: "choice",
      choices: [
        { id: "first", label: "First" },
        { id: "second", label: "Second" },
      ],
      source: {},
    });
    expect(
      service.respond(choice.interaction.id, {
        kind: "choice",
        choiceId: "second",
      }),
    ).toBe(true);
    await expect(choice.response).resolves.toEqual({
      kind: "choice",
      choiceId: "second",
    });
  });

  it("rejects duplicate choice IDs at the public feedback contract", () => {
    expect(
      feedbackAskInputSchema.safeParse({
        prompt: "Pick one",
        form: "choice",
        choices: [
          { id: "same", label: "First" },
          { id: "same", label: "Second" },
        ],
        source: {},
      }).success,
    ).toBe(false);
  });

  it("cancels pending waits through their abort signal", async () => {
    const service = new InteractionService();
    const controller = new AbortController();
    const wait = service.requestSafety(
      {
        kind: "tool_approval",
        title: "Approve tool",
        prompt: "Allow?",
        source: {
          pluginId: "kernel.loop",
          feature: "tool",
        },
      },
      controller.signal,
    );
    controller.abort();
    await expect(wait.response).rejects.toBeInstanceOf(
      InteractionCancelledError,
    );
  });

  it("times out pending interactions", async () => {
    vi.useFakeTimers();
    try {
      const service = new InteractionService();
      const wait = service.requestSafety({
        kind: "tool_approval",
        title: "Approve tool",
        prompt: "Allow?",
        source: {
          pluginId: "kernel.loop",
          feature: "tool",
        },
        timeoutMs: 10,
      });
      const rejection = expect(wait.response).rejects.toBeInstanceOf(
        InteractionTimedOutError,
      );
      await vi.advanceTimersByTimeAsync(10);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });
});
