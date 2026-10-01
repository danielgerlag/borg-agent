import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { createKernel, defineDistribution } from "@borg/kernel";
import configSqliteManifest from "@borg/plugin-config-sqlite/borg.plugin.json";
import configSqlite from "@borg/plugin-config-sqlite/main";
import helloManifest from "@borg/plugin-hello/borg.plugin.json";
import { helloGetStatus } from "@borg/plugin-hello/contract";
import hello from "@borg/plugin-hello/main";
import mockLlmManifest from "@borg/plugin-mock-llm/borg.plugin.json";
import mockLlm from "@borg/plugin-mock-llm/main";
import secretsDevManifest from "@borg/plugin-secrets-dev/borg.plugin.json";
import secretsDev from "@borg/plugin-secrets-dev/main";

const distribution = defineDistribution({
  id: "example.headless",
  name: "Headless example",
  version: "0.1.0",
  kernel: "^0.1.0",
  plugins: ["borg.config.sqlite", "borg.secrets.dev", "borg.mock-llm", "borg.hello"],
});
const kernel = createKernel({
  distribution,
  plugins: [
    { manifest: configSqliteManifest, loadMain: async () => configSqlite },
    { manifest: secretsDevManifest, loadMain: async () => secretsDev },
    { manifest: mockLlmManifest, loadMain: async () => mockLlm },
    { manifest: helloManifest, loadMain: async () => hello },
  ],
  host: { dataDirectory: mkdtempSync(`${tmpdir()}/borg-headless-`) },
  resolveSecretStore: async () => "borg.secrets.dev",
});
kernel.start()
  .then(() => kernel.bus.invoke(helloGetStatus, {}))
  .then((status) => console.log(`${status.pluginId}: ${status.message}`))
  .finally(() => kernel.stop());
