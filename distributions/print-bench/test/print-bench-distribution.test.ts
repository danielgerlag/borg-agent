import { describe, expect, it } from "vitest";
import { KERNEL_API_VERSION, satisfiesBorgEngine } from "@borg-agent/kernel";
import { printBenchDistribution } from "../src";

const harnessPluginIds = [
  "borg.anthropic",
  "borg.azure",
  "borg.config.sqlite",
  "borg.copilot",
  "borg.feedback",
  "borg.mock-llm",
  "borg.ollama",
  "borg.openai",
  "borg.openrouter",
  "borg.secrets.dev",
  "borg.secrets.os",
  "borg.security.prompt-injection",
  "borg.themes",
  "example.print-bench",
] as const;

const referenceWorkspaces = ["borg.chat", "borg.bots", "borg.graphs"] as const;

describe("print bench distribution", () => {
  it("loads Design and the provider screens, without the reference workspaces", () => {
    expect(printBenchDistribution.id).toBe("borg.print-bench");
    expect(printBenchDistribution.name).toBe("Print bench");
    expect(printBenchDistribution.version).toBe("0.1.0");
    expect(printBenchDistribution.kernel).toBe("^0.1.0");
    expect(satisfiesBorgEngine(printBenchDistribution.kernel, KERNEL_API_VERSION)).toBe(
      true,
    );
    const ids = printBenchDistribution.plugins.map((plugin) => plugin.id);
    expect(ids).toEqual([...harnessPluginIds]);
    expect(printBenchDistribution.plugins.every((plugin) => plugin.enabled)).toBe(true);
    for (const id of referenceWorkspaces) {
      expect(ids).not.toContain(id);
    }
    expect(printBenchDistribution.defaults).toEqual({
      models: ["borg.mock-llm:mock:scripted"],
    });
    expect(printBenchDistribution.policy).toEqual({});
  });
});
