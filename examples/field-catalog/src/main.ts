import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { createKernel, defineDistribution } from "@borg-agent/kernel";
import type {
  BorgPluginManifest,
  PluginDefinition,
} from "@borg-agent/plugin-sdk";
import configSqliteManifest from "@borg/plugin-config-sqlite/borg.plugin.json";
import configSqlite from "@borg/plugin-config-sqlite/main";
import secretsDevManifest from "@borg/plugin-secrets-dev/borg.plugin.json";
import secretsDev from "@borg/plugin-secrets-dev/main";
import catalog from "./catalog";
import model from "./model";

const distribution = defineDistribution({
  id: "example.field-catalog",
  name: "Field catalog",
  version: "0.1.0",
  kernel: "^0.1.0",
  plugins: [
    "borg.config.sqlite",
    "borg.secrets.dev",
    "example.field.model",
    "example.field.catalog",
  ],
  defaults: {
    models: ["example.field.model:scripted"],
  },
});

function localSource(plugin: PluginDefinition) {
  const manifest = {
    id: plugin.id,
    version: "0.1.0",
    engines: { borg: "^0.1.0" },
    main: `${plugin.id}/main`,
    permissions: plugin.permissions,
    contributes: plugin.contributes,
  } as const satisfies BorgPluginManifest;
  return {
    manifest,
    loadMain: async () => plugin,
  };
}

async function main(): Promise<void> {
  const kernel = createKernel({
    distribution,
    plugins: [
      { manifest: configSqliteManifest, loadMain: async () => configSqlite },
      { manifest: secretsDevManifest, loadMain: async () => secretsDev },
      localSource(model),
      localSource(catalog),
    ],
    host: { dataDirectory: mkdtempSync(`${tmpdir()}/borg-field-catalog-`) },
    resolveSecretStore: async () => "borg.secrets.dev",
  });
  let failed = false;
  try {
    await kernel.start();
    const run = await kernel.loops.start({
      prompt: "File this beetle.",
      providerId: "example.field.model",
      modelId: "scripted",
      security: {
        kind: "root",
        subject: { kind: "field-catalog", id: "cicindela" },
        classification: "internal",
        provenance: { kind: "plugin", id: "example.field-catalog" },
        operationPrefix: "field-catalog/voucher",
      },
    });
    const deadline = Date.now() + 10_000;
    let snapshot = kernel.loops.get(run.id);
    while (
      snapshot?.status !== "completed" &&
      snapshot?.status !== "failed" &&
      snapshot?.status !== "cancelled" &&
      Date.now() < deadline
    ) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 20);
      });
      snapshot = kernel.loops.get(run.id);
    }
    if (
      snapshot?.status === "completed" &&
      typeof snapshot.output === "string"
    ) {
      console.log(snapshot.output);
    } else {
      console.error(snapshot?.status, snapshot?.error);
      failed = true;
    }
  } finally {
    await kernel.stop();
  }
  if (failed) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
