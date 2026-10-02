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
import book from "./book";
import model from "./model";

const distribution = defineDistribution({
  id: "example.auction-clerk",
  name: "Auction clerk",
  version: "0.1.0",
  kernel: "^0.1.0",
  plugins: [
    "borg.config.sqlite",
    "borg.secrets.dev",
    "example.auction.model",
    "example.auction.book",
  ],
  defaults: {
    models: ["example.auction.model:scripted"],
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
      localSource(book),
    ],
    host: { dataDirectory: mkdtempSync(`${tmpdir()}/borg-auction-clerk-`) },
    resolveSecretStore: async () => "borg.secrets.dev",
  });
  let failed = false;
  try {
    await kernel.start();
    const run = await kernel.loops.start({
      prompt: "Open lot 7.",
      providerId: "example.auction.model",
      modelId: "scripted",
      security: {
        kind: "root",
        subject: { kind: "auction-clerk", id: "lot-7" },
        classification: "internal",
        provenance: { kind: "plugin", id: "example.auction-clerk" },
        operationPrefix: "auction-clerk/bid",
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
