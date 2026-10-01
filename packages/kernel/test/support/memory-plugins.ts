import {
  definePlugin,
  type BorgPluginManifest,
  type ConfigStoreProvider,
  type JsonValue,
  type SecretStoreProvider,
  type StoreEntry,
  type StoreTransactionOperation,
} from "@borg/plugin-sdk";
import type { PluginSource } from "../../src";

export class MemoryConfigStore implements ConfigStoreProvider {
  readonly configs = new Map<string, JsonValue>();
  readonly values = new Map<string, Map<string, JsonValue>>();

  async readConfig(namespace: string): Promise<unknown | undefined> {
    return this.configs.get(namespace);
  }

  async writeConfig(namespace: string, value: JsonValue): Promise<void> {
    this.configs.set(namespace, value);
  }

  async getStore(
    namespace: string,
    key: string,
  ): Promise<JsonValue | undefined> {
    return this.values.get(namespace)?.get(key);
  }

  async listStore(
    namespace: string,
    prefix: string,
  ): Promise<readonly StoreEntry[]> {
    return [...(this.values.get(namespace) ?? new Map()).entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({ key, value }));
  }

  async applyStoreTransaction(
    namespace: string,
    operations: readonly StoreTransactionOperation[],
  ): Promise<void> {
    const next = new Map(this.values.get(namespace));
    for (const operation of operations) {
      if (operation.type === "set") {
        next.set(operation.key, operation.value);
      } else {
        next.delete(operation.key);
      }
    }
    this.values.set(namespace, next);
  }
}

export class MemorySecretStore implements SecretStoreProvider {
  readonly kind = "development" as const;
  readonly values = new Map<string, string>();

  async get(namespace: string, key: string): Promise<string | undefined> {
    return this.values.get(`${namespace}:${key}`);
  }

  async set(namespace: string, key: string, value: string): Promise<void> {
    this.values.set(`${namespace}:${key}`, value);
  }

  async delete(namespace: string, key: string): Promise<void> {
    this.values.delete(`${namespace}:${key}`);
  }

  async has(namespace: string, key: string): Promise<boolean> {
    return this.values.has(`${namespace}:${key}`);
  }
}

export function sourceFor(definition: {
  readonly id: string;
  readonly version: string;
  readonly engines: { readonly borg: string };
  readonly permissions: readonly string[];
  readonly contributes: BorgPluginManifest["contributes"];
  activate: NonNullable<Parameters<typeof definePlugin>[0]["activate"]>;
}): PluginSource {
  const manifest = {
    id: definition.id,
    version: definition.version,
    engines: definition.engines,
    main: `${definition.id}/main`,
    permissions: definition.permissions,
    contributes: definition.contributes,
  } as const satisfies BorgPluginManifest;
  return {
    manifest,
    loadMain: async () =>
      definePlugin({
        id: manifest.id,
        version: manifest.version,
        engines: manifest.engines,
        permissions: manifest.permissions,
        contributes: manifest.contributes,
        activate: definition.activate,
      }),
  };
}
