import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createKernel, defineDistribution, type Kernel } from "@borg-agent/kernel";
import type { BorgPluginManifest } from "@borg-agent/plugin-sdk";
import configSqlite from "@borg/plugin-config-sqlite/main";
import secretsDev from "@borg/plugin-secrets-dev/main";
import channelMock from "@borg/plugin-channel-mock/main";
import promptInjection from "@borg/plugin-security-prompt-injection/main";
import feedback from "@borg/plugin-feedback/main";
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
      "example.print-bench",
    ],
    defaults: { models: ["example.print-bench:scripted"] },
  });
  const kernel = createKernel({
    distribution,
    plugins: [
      {
        manifest: manifestFromPackage("@borg/plugin-config-sqlite"),
        loadMain: async () => configSqlite,
      },
      {
        manifest: manifestFromPackage("@borg/plugin-secrets-dev"),
        loadMain: async () => secretsDev,
      },
      {
        manifest: manifestFromPackage("@borg/plugin-channel-mock"),
        loadMain: async () => channelMock,
      },
      {
        manifest: manifestFromPackage("@borg/plugin-security-prompt-injection"),
        loadMain: async () => promptInjection,
      },
      {
        manifest: manifestFromPackage("@borg/plugin-feedback"),
        loadMain: async () => feedback,
      },
      { manifest: ownManifest(), loadMain: async () => printBench },
    ],
    host: { dataDirectory },
    resolveSecretStore: async () => "borg.secrets.dev",
  });
  await kernel.start();
  return kernel;
}
