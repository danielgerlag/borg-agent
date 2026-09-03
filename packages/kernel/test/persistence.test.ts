import {
  type ConfigStoreProvider,
  type JsonValue,
  type SecretStoreProvider,
  type StoreEntry,
  type StoreTransactionOperation,
  z,
} from "@borg/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  ConfigFacade,
  PersistenceRegistry,
  SecretFacade,
  StoreFacade,
} from "../src";

class MemoryConfigStore implements ConfigStoreProvider {
  readonly configs = new Map<string, JsonValue>();
  readonly values = new Map<string, Map<string, JsonValue>>();

  async readConfig(namespace: string): Promise<unknown | undefined> {
    return this.configs.get(namespace);
  }

  async writeConfig(namespace: string, value: JsonValue): Promise<void> {
    this.configs.set(namespace, value);
  }

  async getStore(namespace: string, key: string): Promise<JsonValue | undefined> {
    return this.values.get(namespace)?.get(key);
  }

  async listStore(namespace: string, prefix: string): Promise<readonly StoreEntry[]> {
    return [...(this.values.get(namespace) ?? new Map()).entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({ key, value }));
  }

  async applyStoreTransaction(
    namespace: string,
    operations: readonly StoreTransactionOperation[],
  ): Promise<void> {
    const values = new Map(this.values.get(namespace));
    for (const operation of operations) {
      if (operation.type === "set") {
        values.set(operation.key, operation.value);
      } else {
        values.delete(operation.key);
      }
    }
    this.values.set(namespace, values);
  }
}

class MemorySecretStore implements SecretStoreProvider {
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

describe("persistence facades", () => {
  it("validates, persists, and watches namespaced plugin config", async () => {
    const registry = new PersistenceRegistry();
    const provider = new MemoryConfigStore();
    registry.registerConfigStore("test.config", provider);
    const config = new ConfigFacade(registry);
    config.registerSchema(
      "test.plugin",
      z.object({ message: z.string().min(1).default("default") }),
    );
    const listener = vi.fn();
    config.watch("test.plugin", listener);

    await expect(config.get("test.plugin")).resolves.toEqual({
      message: "default",
    });
    await expect(
      config.update("test.plugin", { message: "persisted" }),
    ).resolves.toEqual({ message: "persisted" });
    expect(provider.configs.get("test.plugin")).toEqual({
      message: "persisted",
    });
    expect(listener).toHaveBeenCalledWith({ message: "persisted" });
    await expect(
      config.update("test.plugin", { message: "" }),
    ).rejects.toThrow(/schema validation/);
  });

  it("applies store batches within the caller namespace", async () => {
    const registry = new PersistenceRegistry();
    const provider = new MemoryConfigStore();
    registry.registerConfigStore("test.config", provider);
    const store = new StoreFacade(registry);

    await store.transaction("test.first", [
      { type: "set", key: "run/1", value: { state: "active" } },
      { type: "set", key: "other", value: 2 },
    ]);
    await store.set("test.second", "run/1", { state: "separate" });

    await expect(store.list("test.first", "run/")).resolves.toEqual([
      { key: "run/1", value: { state: "active" } },
    ]);
    await expect(store.get("test.second", "run/1")).resolves.toEqual({
      state: "separate",
    });
  });

  it("serializes concurrent config patches for one plugin", async () => {
    const registry = new PersistenceRegistry();
    const provider = new MemoryConfigStore();
    registry.registerConfigStore("test.config", provider);
    const config = new ConfigFacade(registry);
    config.registerSchema(
      "test.plugin",
      z.object({
        first: z.number().default(0),
        second: z.number().default(0),
      }),
    );

    await Promise.all([
      config.update("test.plugin", { first: 1 }),
      config.update("test.plugin", { second: 2 }),
    ]);
    await expect(config.get("test.plugin")).resolves.toEqual({
      first: 1,
      second: 2,
    });
  });

  it("allows a watcher to perform a follow-up update", async () => {
    const registry = new PersistenceRegistry();
    registry.registerConfigStore("test.config", new MemoryConfigStore());
    const config = new ConfigFacade(registry);
    config.registerSchema(
      "test.plugin",
      z.object({ message: z.string().default("initial") }),
    );
    let followedUp = false;
    config.watch("test.plugin", async (document) => {
      if (!followedUp && document.message === "first") {
        followedUp = true;
        await config.update("test.plugin", { message: "second" });
      }
    });

    await config.update("test.plugin", { message: "first" });
    await expect(config.get("test.plugin")).resolves.toEqual({
      message: "second",
    });
  });

  it("routes secrets without exposing backend selection to callers", async () => {
    const registry = new PersistenceRegistry();
    const provider = new MemorySecretStore();
    registry.registerSecretStore("test.secrets", provider);
    const secrets = new SecretFacade(registry);

    await secrets.set("test.plugin", "token", "secret-value");
    await expect(secrets.has("test.plugin", "token")).resolves.toBe(true);
    await expect(secrets.get("test.plugin", "token")).resolves.toBe(
      "secret-value",
    );
    expect(registry.getSecretStoreKind()).toBe("development");
    await secrets.delete("test.plugin", "token");
    await expect(secrets.has("test.plugin", "token")).resolves.toBe(false);
  });

  it("rejects duplicate selected providers", () => {
    const registry = new PersistenceRegistry();
    registry.registerConfigStore("test.first", new MemoryConfigStore());
    expect(() =>
      registry.registerConfigStore("test.second", new MemoryConfigStore()),
    ).toThrow(/already provided/);
  });

  it("rejects malformed runtime providers", () => {
    const registry = new PersistenceRegistry();
    expect(() =>
      registry.registerConfigStore(
        "test.invalid",
        {} as unknown as ConfigStoreProvider,
      ),
    ).toThrow(/missing method/);
  });

  it("rejects malformed runtime persistence mutations", async () => {
    const registry = new PersistenceRegistry();
    registry.registerConfigStore("test.config", new MemoryConfigStore());
    registry.registerSecretStore("test.secrets", new MemorySecretStore());
    const store = new StoreFacade(registry);
    const secrets = new SecretFacade(registry);

    expect(() =>
      store.transaction("test.plugin", [
        { type: "truncate", key: "value" } as never,
      ]),
    ).toThrow(/invalid operation/);
    expect(() =>
      secrets.set("test.plugin", "token", 42 as never),
    ).toThrow(/must be a string/);
  });
});
