import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { createKernel, defineDistribution, type Kernel } from "@borg-agent/kernel";
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

export function createAuctionClerkKernel(): Kernel {
  return createKernel({
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
}
