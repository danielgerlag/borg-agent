import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { createKernel, defineDistribution, type PluginSource } from "@borg/kernel";
import { helloGetStatus } from "@borg/plugin-hello/contract";

const distribution = defineDistribution({
  id: "example.headless",
  name: "Headless example",
  version: "0.1.0",
  kernel: "^0.1.0",
  plugins: ["borg.config.sqlite", "borg.secrets.dev", "borg.mock-llm", "borg.hello"],
});
const kernel = createKernel({
  distribution,
  plugins: ["config-sqlite", "secrets-dev", "mock-llm", "hello"].map((name): PluginSource => ({
    manifest: require(`@borg/plugin-${name}/borg.plugin.json`),
    loadMain: async () => require(`@borg/plugin-${name}/main`),
  })),
  host: { dataDirectory: mkdtempSync(`${tmpdir()}/borg-headless-`) },
  resolveSecretStore: async () => "borg.secrets.dev",
});
kernel.start()
  .then(() => kernel.bus.invoke(helloGetStatus, {}))
  .then((status) => console.log(`${status.pluginId}: ${status.message}`))
  .finally(() => kernel.stop());
