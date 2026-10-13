/**
 * Starts the test kernel from the shared harness spine, then the print bench.
 */

import { readFileSync } from "node:fs";
import { createKernel, type Kernel } from "@borg-agent/kernel";
import { pluginManifestSchema } from "@borg-agent/plugin-sdk";
import { defineHarness, harnessSources } from "@borg/harness";
import printBench from "./main.js";

function readOwnManifest(): unknown {
  const parsed: unknown = JSON.parse(
    readFileSync(new URL("../borg.plugin.json", import.meta.url), "utf8"),
  );
  return parsed;
}

const ownManifest = pluginManifestSchema.parse(readOwnManifest());

const distribution = defineHarness({
  id: "example.print-bench",
  name: "Print bench",
  plugins: [ownManifest.id],
  secrets: "dev",
});

export function printBenchPluginIds(): readonly string[] {
  return distribution.plugins.map((plugin) => plugin.id);
}

export async function startPrintBench(dataDirectory: string): Promise<Kernel> {
  const kernel = createKernel({
    distribution,
    plugins: harnessSources(distribution, {
      [ownManifest.id]: {
        manifest: ownManifest,
        loadMain: async () => printBench,
      },
    }),
    host: { dataDirectory },
    resolveSecretStore: async () => "borg.secrets.dev",
  });
  await kernel.start();
  return kernel;
}
