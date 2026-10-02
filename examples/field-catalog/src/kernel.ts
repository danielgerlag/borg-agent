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

export function createFieldCatalogKernel(): Kernel {
  return createKernel({
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
}
