import { describe, expect, it } from "vitest";
import { KERNEL_API_VERSION, satisfiesBorgEngine } from "@borg-agent/kernel";
import { desktopDistribution } from "../src";

const baselinePluginIds = [
  "borg.a2a",
  "borg.anthropic",
  "borg.azure",
  "borg.bots",
  "borg.channel.discord",
  "borg.channel.google",
  "borg.channel.imap",
  "borg.channel.m365",
  "borg.channel.mock",
  "borg.channel.slack",
  "borg.chat",
  "borg.coinbase",
  "borg.config.sqlite",
  "borg.context-map",
  "borg.copilot",
  "borg.feedback",
  "borg.graphs",
  "borg.hello",
  "borg.mcp",
  "borg.mcp-apps",
  "borg.memory.knowledge",
  "borg.mock-llm",
  "borg.ollama",
  "borg.openai",
  "borg.openrouter",
  "borg.remote",
  "borg.search.brave",
  "borg.search.tavily",
  "borg.secrets.dev",
  "borg.secrets.os",
  "borg.security.prompt-injection",
  "borg.themes",
  "borg.tools.core",
  "borg.tools.echo",
  "borg.usage",
] as const;

describe("desktop distribution", () => {
  it("lists the baseline plugins, all enabled, on this kernel", () => {
    expect(desktopDistribution.id).toBe("borg.desktop");
    expect(desktopDistribution.name).toBe("Borg Desktop");
    expect(desktopDistribution.version).toBe("0.1.0");
    expect(desktopDistribution.kernel).toBe("^0.1.0");
    expect(satisfiesBorgEngine(desktopDistribution.kernel, KERNEL_API_VERSION)).toBe(
      true,
    );
    expect(desktopDistribution.plugins.map((plugin) => plugin.id)).toEqual([
      ...baselinePluginIds,
    ]);
    expect(desktopDistribution.plugins.every((plugin) => plugin.enabled)).toBe(true);
    expect(desktopDistribution.defaults).toEqual({
      models: ["borg.mock-llm:mock:scripted"],
    });
    expect(desktopDistribution.policy).toEqual({
      detachedResults: [
        { pluginId: "borg.chat", subjectKinds: ["chat-session", "chat-turn"] },
        { pluginId: "borg.bots", subjectKinds: ["bot", "bot-attempt"] },
        { pluginId: "borg.graphs", subjectKinds: ["graph-instance"] },
        { pluginId: "borg.a2a", subjectKinds: ["a2a-task"] },
      ],
    });
  });
});
