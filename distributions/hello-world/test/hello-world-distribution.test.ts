import { describe, expect, it } from "vitest";
import { KERNEL_API_VERSION, satisfiesBorgEngine } from "@borg-agent/kernel";
import { helloWorldDistribution } from "../src";

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
  "borg.personas",
  "borg.secrets.dev",
  "borg.secrets.os",
  "borg.security.prompt-injection",
  "borg.themes",
  "example.hello-world",
] as const;

const referenceWorkspaces = ["borg.chat", "borg.bots", "borg.graphs"] as const;

describe("hello world distribution", () => {
  it("loads Hello world and the provider screens, without the reference workspaces", () => {
    expect(helloWorldDistribution.id).toBe("borg.hello-world");
    expect(helloWorldDistribution.name).toBe("Hello world");
    expect(helloWorldDistribution.version).toBe("0.1.0");
    expect(helloWorldDistribution.kernel).toBe("^0.1.0");
    expect(satisfiesBorgEngine(helloWorldDistribution.kernel, KERNEL_API_VERSION)).toBe(true);
    const ids = helloWorldDistribution.plugins.map((plugin) => plugin.id);
    expect(ids).toEqual([...harnessPluginIds]);
    expect(helloWorldDistribution.plugins.every((plugin) => plugin.enabled)).toBe(true);
    for (const id of referenceWorkspaces) {
      expect(ids).not.toContain(id);
    }
    expect(helloWorldDistribution.defaults).toEqual({
      models: ["borg.mock-llm:mock:scripted"],
    });
    expect(helloWorldDistribution.policy).toEqual({});
  });
});
