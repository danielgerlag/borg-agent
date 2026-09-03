import { definePlugin, type SecretStoreProvider } from "@borg/plugin-sdk";
import { chmod, lstat, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

type SecretVault = Record<string, Record<string, string>>;

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function emptyVault(): SecretVault {
  return Object.create(null) as SecretVault;
}

function parseVault(contents: string): SecretVault {
  const parsed: unknown = JSON.parse(contents);
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("Development secret vault is corrupt");
  }
  const vault = emptyVault();
  for (const [namespace, candidate] of Object.entries(parsed)) {
    if (candidate === null || Array.isArray(candidate) || typeof candidate !== "object") {
      throw new Error("Development secret vault is corrupt");
    }
    const values = Object.create(null) as Record<string, string>;
    for (const [key, value] of Object.entries(candidate)) {
      if (typeof value !== "string") {
        throw new Error("Development secret vault is corrupt");
      }
      values[key] = value;
    }
    vault[namespace] = values;
  }
  return vault;
}

function cloneVault(source: SecretVault): SecretVault {
  const target = emptyVault();
  for (const [namespace, values] of Object.entries(source)) {
    target[namespace] = Object.assign(Object.create(null), values) as Record<
      string,
      string
    >;
  }
  return target;
}

class SecretPersistenceError extends Error {
  constructor(
    message: string,
    readonly committed: boolean,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export class DevelopmentSecretStore implements SecretStoreProvider {
  readonly kind = "development" as const;
  #vault: SecretVault = emptyVault();
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(readonly filename: string) {}

  async initialize(): Promise<void> {
    try {
      const information = await lstat(this.filename);
      if (!information.isFile() || information.isSymbolicLink()) {
        throw new Error("Development secret vault must be a regular file");
      }
      if (process.platform !== "win32") {
        await chmod(this.filename, 0o600);
      }
      this.#vault = parseVault(await readFile(this.filename, "utf8"));
    } catch (error) {
      if (!isMissingFile(error)) {
        throw error;
      }
    }
  }

  async get(namespace: string, key: string): Promise<string | undefined> {
    const values = this.#vault[namespace];
    return values && Object.hasOwn(values, key) ? values[key] : undefined;
  }

  async set(namespace: string, key: string, value: string): Promise<void> {
    return this.#mutate((vault) => {
      const values =
        vault[namespace] ??
        (Object.create(null) as Record<string, string>);
      values[key] = value;
      vault[namespace] = values;
    });
  }

  async delete(namespace: string, key: string): Promise<void> {
    return this.#mutate((vault) => {
      const values = vault[namespace];
      if (!values || !Object.hasOwn(values, key)) {
        return;
      }
      delete values[key];
      if (Object.keys(values).length === 0) {
        delete vault[namespace];
      }
    });
  }

  async has(namespace: string, key: string): Promise<boolean> {
    const values = this.#vault[namespace];
    return values !== undefined && Object.hasOwn(values, key);
  }

  async close(): Promise<void> {
    await this.#writeQueue;
  }

  async #mutate(mutator: (vault: SecretVault) => void): Promise<void> {
    const operation = this.#writeQueue.then(async () => {
      const next = cloneVault(this.#vault);
      mutator(next);
      try {
        await this.#persist(next);
        this.#vault = next;
      } catch (error) {
        if (error instanceof SecretPersistenceError && error.committed) {
          this.#vault = next;
        }
        throw error;
      }
    });
    this.#writeQueue = operation.catch(() => undefined);
    return operation;
  }

  async #persist(vault: SecretVault): Promise<void> {
    await mkdir(path.dirname(this.filename), { recursive: true });
    const temporary = `${this.filename}.${randomUUID()}.tmp`;
    const directory =
      process.platform === "win32"
        ? undefined
        : await open(path.dirname(this.filename), "r");
    const file = await open(temporary, "wx", 0o600).catch(async (error) => {
      await directory?.close().catch(() => undefined);
      throw error;
    });
    let renamed = false;
    try {
      await file.writeFile(JSON.stringify(vault, null, 2), "utf8");
      await file.sync();
      await file.close();
      await rename(temporary, this.filename);
      renamed = true;
      await directory?.sync();
      await directory?.close();
    } catch (error) {
      await file.close().catch(() => undefined);
      await directory?.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
      throw new SecretPersistenceError(
        "Development secret vault could not be committed durably",
        renamed,
        { cause: error },
      );
    }
  }
}

export default definePlugin({
  id: "borg.secrets.dev",
  version: "0.1.0",
  engines: {
    borg: "^0.1.0",
  },
  permissions: [
    "fs:pluginData",
    "secrets:read",
    "secrets:write",
    "notifications:send",
    "ui.settings",
    "ui.wizard",
  ],
  contributes: {
    kinds: ["secretStore", "settingsPage", "wizardStep"],
  },
  async activate(context) {
    const provider = new DevelopmentSecretStore(
      path.join(context.dataDir, "secrets.json"),
    );
    await provider.initialize();
    context.persistence.registerSecretStore(provider);
    context.logger.warn(
      "Development secret storage is active; values are stored as local plaintext",
    );
    return {
      dispose: () => provider.close(),
    };
  },
});
