import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createKernel, defineDistribution, type Kernel, type PluginSource } from "@borg-agent/kernel";
import type { BorgPluginManifest } from "@borg-agent/plugin-sdk";
import configSqlite from "@borg/plugin-config-sqlite/main";
import secretsDev from "@borg/plugin-secrets-dev/main";
import channelMock from "@borg/plugin-channel-mock/main";
import promptInjection from "@borg/plugin-security-prompt-injection/main";
import feedback from "@borg/plugin-feedback/main";
import anthropic from "@borg/plugin-anthropic/main";
import azure from "@borg/plugin-azure/main";
import copilot from "@borg/plugin-copilot/main";
import mockLlm from "@borg/plugin-mock-llm/main";
import ollama from "@borg/plugin-ollama/main";
import openai from "@borg/plugin-openai/main";
import openrouter from "@borg/plugin-openrouter/main";
import printBench from "./main.js";

const require = createRequire(import.meta.url);

function manifestFromPackage(packageName: string): BorgPluginManifest {
  const mainPath = require.resolve(`${packageName}/main`);
  return JSON.parse(
    readFileSync(join(dirname(dirname(mainPath)), "borg.plugin.json"), "utf8"),
  ) as BorgPluginManifest;
}

function ownManifest(): BorgPluginManifest {
  const fileDir = dirname(fileURLToPath(import.meta.url));
  return JSON.parse(
    readFileSync(join(dirname(fileDir), "borg.plugin.json"), "utf8"),
  ) as BorgPluginManifest;
}

function packaged(
  packageName: string,
  main: Awaited<ReturnType<PluginSource["loadMain"]>>,
): PluginSource {
  return {
    manifest: manifestFromPackage(packageName),
    loadMain: async () => main,
  };
}

const packagedPlugins: readonly PluginSource[] = [
  packaged("@borg/plugin-config-sqlite", configSqlite),
  packaged("@borg/plugin-secrets-dev", secretsDev),
  packaged("@borg/plugin-channel-mock", channelMock),
  packaged("@borg/plugin-security-prompt-injection", promptInjection),
  packaged("@borg/plugin-feedback", feedback),
  packaged("@borg/plugin-anthropic", anthropic),
  packaged("@borg/plugin-azure", azure),
  packaged("@borg/plugin-copilot", copilot),
  packaged("@borg/plugin-mock-llm", mockLlm),
  packaged("@borg/plugin-ollama", ollama),
  packaged("@borg/plugin-openai", openai),
  packaged("@borg/plugin-openrouter", openrouter),
];

export async function startPrintBench(dataDirectory: string): Promise<Kernel> {
  const distribution = defineDistribution({
    id: "example.print-bench",
    name: "Print bench",
    version: "0.1.0",
    kernel: "^0.1.0",
    plugins: [
      "borg.config.sqlite",
      "borg.secrets.dev",
      "borg.channel.mock",
      "borg.security.prompt-injection",
      "borg.feedback",
      "borg.anthropic",
      "borg.azure",
      "borg.copilot",
      "borg.mock-llm",
      "borg.ollama",
      "borg.openai",
      "borg.openrouter",
      "example.print-bench",
    ],
    defaults: { models: ["borg.mock-llm:mock:scripted"] },
  });
  const kernel = createKernel({
    distribution,
    plugins: [
      ...packagedPlugins,
      { manifest: ownManifest(), loadMain: async () => printBench },
    ],
    host: { dataDirectory },
    resolveSecretStore: async () => "borg.secrets.dev",
  });
  await kernel.start();
  return kernel;
}
