/**
 * Starts the test kernel from the shared harness spine, then the hello world chat.
 */

import { readFileSync } from "node:fs";
import { createKernel, type Kernel } from "@borg-agent/kernel";
import { pluginManifestSchema } from "@borg-agent/plugin-sdk";
import { defineHarness, harnessSources } from "@borg/harness";
import helloWorldPlugin from "./main.js";

function readOwnManifest(): unknown {
  const parsed: unknown = JSON.parse(
    readFileSync(new URL("../borg.plugin.json", import.meta.url), "utf8"),
  );
  return parsed;
}

const ownManifest = pluginManifestSchema.parse(readOwnManifest());

const distribution = defineHarness({
  id: "example.hello-world",
  name: "Hello world",
  plugins: [ownManifest.id],
  secrets: "dev",
});

export function helloWorldPluginIds(): readonly string[] {
  return distribution.plugins.map((plugin) => plugin.id);
}

export async function startHelloWorld(dataDirectory: string): Promise<Kernel> {
  const kernel = createKernel({
    distribution,
    plugins: harnessSources(distribution, {
      [ownManifest.id]: {
        manifest: ownManifest,
        loadMain: async () => helloWorldPlugin,
      },
    }),
    host: { dataDirectory },
    resolveSecretStore: async () => "borg.secrets.dev",
  });
  await kernel.start();
  return kernel;
}
