import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createLocalProvider,
  runDataDir,
  type SpawnDetached,
} from "../src/local";
import { createMemoryStore, sampleRunSpec } from "./harness";

describe("local remote provider", () => {
  it("writes spec.json and spawns detached borg-runtime as Node", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "borg-remote-local-"));
    const cliPath = path.join(dataDir, "cli.js");
    await writeFile(cliPath, "console.log('cli')\n", "utf8");
    const spawned: {
      command: string;
      args: readonly string[];
      env: Readonly<Record<string, string>>;
      unrefed: boolean;
    }[] = [];
    const spawnDetached: SpawnDetached = (command, args, options) => {
      const record = {
        command,
        args: [...args],
        env: options.env,
        unrefed: false,
      };
      spawned.push(record);
      return {
        pid: 999_999_999,
        unref: () => {
          record.unrefed = true;
        },
        once(event, listener) {
          if (event === "spawn") {
            (listener as () => void)();
          }
        },
      };
    };
    const frozen = new Date("2026-01-01T00:00:00.000Z");
    const store = createMemoryStore();
    const provider = createLocalProvider({
      store,
      dataDir,
      cliPath,
      execPath: "/opt/node",
      spawnDetached,
      now: () => frozen,
      env: { PATH: "/usr/bin", ELECTRON_RUN_AS_NODE: "1" },
    });

    const worker = await provider.provision({
      runtime: "local",
      displayName: "dev",
    });
    expect(worker.id).toBe("local/dev");
    expect(worker.status).toBe("ready");

    const spec = sampleRunSpec();
    const runId = await provider.submitRun(worker.id, spec);
    expect(runId).toBe(spec.runId);

    const runDir = runDataDir(dataDir, worker.id, spec.runId);
    const written = JSON.parse(
      await readFile(path.join(runDir, "spec.json"), "utf8"),
    ) as { runId: string };
    expect(written.runId).toBe(spec.runId);
    expect(spawned).toEqual([
      {
        command: "/opt/node",
        args: [cliPath, runDir],
        env: { PATH: "/usr/bin", ELECTRON_RUN_AS_NODE: "1" },
        unrefed: true,
      },
    ]);
    expect(await store.get(`run/${worker.id}/${spec.runId}`)).toEqual({
      pid: 999_999_999,
    });

    await expect(provider.getRun(worker.id, spec.runId)).resolves.toEqual({
      version: 1,
      runId: spec.runId,
      status: "queued",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    await writeFile(
      path.join(runDir, "status.json"),
      "{",
      "utf8",
    );
    await expect(provider.getRun(worker.id, spec.runId)).resolves.toMatchObject({
      status: "running",
    });

    await writeFile(
      path.join(runDir, "status.json"),
      JSON.stringify({
        version: 1,
        runId: spec.runId,
        status: "completed",
        output: "done",
        updatedAt: "2026-01-01T00:00:01.000Z",
      }),
      "utf8",
    );
    await expect(provider.getRun(worker.id, spec.runId)).resolves.toMatchObject({
      status: "completed",
      output: "done",
    });

    await expect(provider.destroy(worker.id)).resolves.toBe(true);
    await expect(store.get(`run/${worker.id}/${spec.runId}`)).resolves.toBe(
      undefined,
    );
    await expect(provider.destroy(worker.id)).resolves.toBe(false);
  });

  it("fails submit when spawn cannot start", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "borg-remote-local-err-"));
    const cliPath = path.join(dataDir, "cli.js");
    await writeFile(cliPath, "console.log('cli')\n", "utf8");
    const spawnDetached: SpawnDetached = () => ({
      unref: () => undefined,
      once(event, listener) {
        if (event === "error") {
          listener(new Error("ENOENT"));
        }
      },
    });
    const provider = createLocalProvider({
      store: createMemoryStore(),
      dataDir,
      cliPath,
      execPath: "/opt/node",
      spawnDetached,
    });
    const worker = await provider.provision({
      runtime: "local",
      displayName: "dev",
    });
    await expect(provider.submitRun(worker.id, sampleRunSpec())).rejects.toThrow(
      /Failed to start borg-runtime/,
    );
  });
});
