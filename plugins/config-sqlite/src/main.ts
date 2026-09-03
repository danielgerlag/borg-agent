import {
  definePlugin,
  type ConfigStoreProvider,
  type JsonValue,
  type StoreEntry,
  type StoreTransactionOperation,
} from "@borg/plugin-sdk";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

class SqliteConfigStore implements ConfigStoreProvider {
  readonly #database: DatabaseSync;

  constructor(filename: string) {
    mkdirSync(path.dirname(filename), { recursive: true });
    this.#database = new DatabaseSync(filename);
    this.#database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS plugin_config (
        namespace TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS plugin_store (
        namespace TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (namespace, key)
      );
    `);
  }

  async readConfig(namespace: string): Promise<unknown | undefined> {
    const row = this.#database
      .prepare("SELECT value FROM plugin_config WHERE namespace = ?")
      .get(namespace) as { readonly value: string } | undefined;
    return row ? JSON.parse(row.value) : undefined;
  }

  async writeConfig(namespace: string, value: JsonValue): Promise<void> {
    this.#database
      .prepare(`
        INSERT INTO plugin_config (namespace, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(namespace) DO UPDATE SET
          value = excluded.value,
          updated_at = excluded.updated_at
      `)
      .run(namespace, JSON.stringify(value), new Date().toISOString());
  }

  async getStore(namespace: string, key: string): Promise<JsonValue | undefined> {
    const row = this.#database
      .prepare("SELECT value FROM plugin_store WHERE namespace = ? AND key = ?")
      .get(namespace, key) as { readonly value: string } | undefined;
    return row ? (JSON.parse(row.value) as JsonValue) : undefined;
  }

  async listStore(namespace: string, prefix: string): Promise<readonly StoreEntry[]> {
    const rows = this.#database
      .prepare("SELECT key, value FROM plugin_store WHERE namespace = ? ORDER BY key")
      .all(namespace) as unknown as readonly {
      readonly key: string;
      readonly value: string;
    }[];
    return rows
      .filter(({ key }) => key.startsWith(prefix))
      .map(({ key, value }) => ({
        key,
        value: JSON.parse(value) as JsonValue,
      }));
  }

  async applyStoreTransaction(
    namespace: string,
    operations: readonly StoreTransactionOperation[],
  ): Promise<void> {
    const setValue = this.#database.prepare(`
      INSERT INTO plugin_store (namespace, key, value, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(namespace, key) DO UPDATE SET
        value = excluded.value,
        updated_at = excluded.updated_at
    `);
    const deleteValue = this.#database.prepare(
      "DELETE FROM plugin_store WHERE namespace = ? AND key = ?",
    );

    this.#database.exec("BEGIN IMMEDIATE");
    try {
      for (const operation of operations) {
        if (operation.type === "set") {
          setValue.run(
            namespace,
            operation.key,
            JSON.stringify(operation.value),
            new Date().toISOString(),
          );
        } else {
          deleteValue.run(namespace, operation.key);
        }
      }
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void {
    this.#database.close();
  }
}

export default definePlugin({
  id: "borg.config.sqlite",
  version: "0.1.0",
  engines: {
    borg: "^0.1.0",
  },
  permissions: ["fs:pluginData"],
  contributes: {
    kinds: ["configStore"],
  },
  activate(context) {
    const provider = new SqliteConfigStore(
      path.join(context.dataDir, "borg.sqlite3"),
    );
    context.persistence.registerConfigStore(provider);
    return {
      dispose: () => provider.close(),
    };
  },
});
