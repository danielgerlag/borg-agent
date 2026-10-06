/**
 * Starts the test kernel: the hosted plugins from the catalog, then the print bench.
 */

import { readFileSync } from "node:fs";
import { createKernel, defineDistribution, type Kernel, type PluginSource } from "@borg-agent/kernel";
import { pluginManifestSchema } from "@borg-agent/plugin-sdk";
import configSqlite from "@borg/plugin-config-sqlite/main";
import secretsDev from "@borg/plugin-secrets-dev/main";
import promptInjection from "@borg/plugin-security-prompt-injection/main";
import feedback from "@borg/plugin-feedback/main";
import anthropic from "@borg/plugin-anthropic/main";
import azure from "@borg/plugin-azure/main";
import copilot from "@borg/plugin-copilot/main";
import mockLlm from "@borg/plugin-mock-llm/main";
import ollama from "@borg/plugin-ollama/main";
import openai from "@borg/plugin-openai/main";
import openrouter from "@borg/plugin-openrouter/main";
import { benchPlugins, type BenchPackageName } from "./catalog.js";
import printBench from "./main.js";

type PluginMain = Awaited<ReturnType<PluginSource["loadMain"]>>;

const mains = {
  "@borg/plugin-config-sqlite": configSqlite,
  "@borg/plugin-secrets-dev": secretsDev,
  "@borg/plugin-security-prompt-injection": promptInjection,
  "@borg/plugin-feedback": feedback,
  "@borg/plugin-anthropic": anthropic,
  "@borg/plugin-azure": azure,
  "@borg/plugin-copilot": copilot,
  "@borg/plugin-mock-llm": mockLlm,
  "@borg/plugin-ollama": ollama,
  "@borg/plugin-openai": openai,
  "@borg/plugin-openrouter": openrouter,
} satisfies Record<BenchPackageName, PluginMain>;

function readOwnManifest(): unknown {
  const parsed: unknown = JSON.parse(
    readFileSync(new URL("../borg.plugin.json", import.meta.url), "utf8"),
  );
  return parsed;
}

const ownManifest = pluginManifestSchema.parse(readOwnManifest());

export function printBenchPluginIds(): readonly string[] {
  return [...benchPlugins.map((plugin) => plugin.manifest.id), ownManifest.id];
}

export async function startPrintBench(dataDirectory: string): Promise<Kernel> {
  const distribution = defineDistribution({
    id: "example.print-bench",
    name: "Print bench",
    version: "0.1.0",
    kernel: "^0.1.0",
    plugins: printBenchPluginIds(),
    defaults: { models: ["borg.mock-llm:mock:scripted"] },
  });
  const kernel = createKernel({
    distribution,
    plugins: [
      ...benchPlugins.map((plugin) => ({
        manifest: plugin.manifest,
        loadMain: async () => mains[plugin.packageName],
      })),
      { manifest: ownManifest, loadMain: async () => printBench },
    ],
    host: { dataDirectory },
    resolveSecretStore: async () => "borg.secrets.dev",
  });
  await kernel.start();
  return kernel;
}
