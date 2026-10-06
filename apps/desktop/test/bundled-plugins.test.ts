import { describe, expect, it } from "vitest";
import { desktopDistribution } from "@borg/distribution-desktop";
import { printBenchDistribution } from "@borg/distribution-print-bench";
import { bundledMainPlugins } from "../src/main/bundled-plugins";
import { bundledUiPlugins } from "../src/renderer/bundled-ui-plugins";

function bundledPluginIds(): string[] {
  return [
    ...new Set([
      ...desktopDistribution.plugins.map((plugin) => plugin.id),
      ...printBenchDistribution.plugins.map((plugin) => plugin.id),
    ]),
  ].sort((left, right) => left.localeCompare(right));
}

const baselineUiIds = [
  "borg.a2a",
  "borg.anthropic",
  "borg.azure",
  "borg.bots",
  "borg.channel.discord",
  "borg.channel.google",
  "borg.channel.imap",
  "borg.channel.m365",
  "borg.channel.slack",
  "borg.chat",
  "borg.coinbase",
  "borg.copilot",
  "borg.feedback",
  "borg.graphs",
  "borg.hello",
  "borg.mcp",
  "borg.mcp-apps",
  "borg.mock-llm",
  "borg.ollama",
  "borg.openai",
  "borg.openrouter",
  "borg.remote",
  "borg.search.brave",
  "borg.search.tavily",
  "borg.secrets.dev",
  "borg.secrets.os",
  "borg.themes",
  "borg.usage",
  "example.print-bench",
] as const;

function manifestId(manifest: unknown): string {
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    !("id" in manifest) ||
    typeof manifest.id !== "string"
  ) {
    throw new Error("Bundled plugin manifest is missing id");
  }
  return manifest.id;
}

describe("bundled plugins", () => {
  it("matches the union of the host distributions and the UI baseline", () => {
    expect(bundledMainPlugins.map((source) => manifestId(source.manifest))).toEqual(
      bundledPluginIds(),
    );
    expect(Object.keys(bundledUiPlugins)).toEqual([...baselineUiIds]);
  });
});
