import { z } from "@borg/plugin-sdk";
import { describe, expect, it } from "vitest";
import { GraphContributionRegistry } from "../src";

describe("GraphContributionRegistry", () => {
  it("registers, lists, and removes plugin-owned graph contributions", () => {
    const registry = new GraphContributionRegistry();
    registry.registerStep("borg.child", {
      kind: "custom_task",
      type: "task",
      label: "Custom task",
      configSchema: z.object({ value: z.string() }),
      execute: (config) => (config as { readonly value: string }).value,
    });
    registry.registerTrigger("borg.child", {
      kind: "custom_trigger",
      label: "Custom trigger",
      configSchema: z.object({}),
      subscribe: () => ({ dispose: () => undefined }),
    });

    expect(registry.listSteps().map(({ kind }) => kind)).toEqual([
      "custom_task",
    ]);
    expect(registry.listTriggers().map(({ kind }) => kind)).toEqual([
      "custom_trigger",
    ]);

    registry.removePlugin("borg.child");
    expect(registry.listSteps()).toEqual([]);
    expect(registry.listTriggers()).toEqual([]);
  });

  it("rejects duplicate contribution kinds", () => {
    const registry = new GraphContributionRegistry();
    const contribution = {
      kind: "custom_task",
      type: "task" as const,
      label: "Custom task",
      configSchema: z.object({}),
      execute: () => null,
    };
    registry.registerStep("borg.first", contribution);

    expect(() =>
      registry.registerStep("borg.second", contribution),
    ).toThrow("already registered");
  });

  it("rejects built-in contribution kinds", () => {
    const registry = new GraphContributionRegistry();

    expect(() =>
      registry.registerStep("borg.child", {
        kind: "call_tool",
        type: "task",
        label: "Imposter",
        configSchema: z.object({}),
        execute: () => null,
      }),
    ).toThrow("reserved by Borg");
  });
});
