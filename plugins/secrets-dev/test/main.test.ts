import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DevelopmentSecretStore } from "../src/main";

const directories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function createStore(): Promise<{
  readonly filename: string;
  readonly store: DevelopmentSecretStore;
}> {
  const directory = await mkdtemp(path.join(tmpdir(), "borg-secrets-"));
  directories.push(directory);
  const filename = path.join(directory, "secrets.json");
  const store = new DevelopmentSecretStore(filename);
  await store.initialize();
  return { filename, store };
}

describe("DevelopmentSecretStore", () => {
  it("serializes concurrent durable writes without losing values", async () => {
    const { filename, store } = await createStore();
    await Promise.all(
      Array.from({ length: 20 }, async (_value, index) =>
        store.set("test.plugin", `key-${index}`, `value-${index}`),
      ),
    );

    const reloaded = new DevelopmentSecretStore(filename);
    await reloaded.initialize();
    await Promise.all(
      Array.from({ length: 20 }, async (_value, index) => {
        await expect(reloaded.get("test.plugin", `key-${index}`)).resolves.toBe(
          `value-${index}`,
        );
      }),
    );
    expect((await readdir(path.dirname(filename))).sort()).toEqual([
      "secrets.json",
    ]);
    if (process.platform !== "win32") {
      expect((await stat(filename)).mode & 0o777).toBe(0o600);
    }
  });

  it("drains queued writes when the provider closes", async () => {
    const { filename, store } = await createStore();
    const writes = Array.from({ length: 10 }, async (_value, index) =>
      store.set("test.plugin", `closing-${index}`, `value-${index}`),
    );
    await store.close();
    await Promise.all(writes);

    const reloaded = new DevelopmentSecretStore(filename);
    await reloaded.initialize();
    await expect(reloaded.get("test.plugin", "closing-9")).resolves.toBe(
      "value-9",
    );
  });

  it("treats prototype-shaped keys as ordinary scoped secrets", async () => {
    const { store } = await createStore();
    await store.set("__proto__", "constructor", "safe");
    await expect(store.get("__proto__", "constructor")).resolves.toBe("safe");
    await expect(store.has("__proto__", "toString")).resolves.toBe(false);
  });

  it("rejects a structurally corrupt vault", async () => {
    const { filename } = await createStore();
    await writeFile(filename, JSON.stringify({ plugin: { key: 42 } }), "utf8");
    const store = new DevelopmentSecretStore(filename);
    await expect(store.initialize()).rejects.toThrow(/corrupt/);
    expect(await readFile(filename, "utf8")).toContain("42");
  });
});
