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
  it("writes spec.json and spawns detached borg-runtime", async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), "borg-remote-local-"));
    const spawned: {
      command: string;
      args: readonly string[];
      options: { readonly detached: true; readonly stdio: "ignore" };
      unrefed: boolean;
    }[] = [];
    const spawnDetached: SpawnDetached = (command, args, options) => {
      const record = {
        command,
        args: [...args],
        options,
        unrefed: false,
      };
      spawned.push(record);
      return {
        unref: () => {
          record.unrefed = true;
        },
      };
    };
    const frozen = new Date("2026-01-01T00:00:00.000Z");
    const provider = createLocalProvider({
      store: createMemoryStore(),
      dataDir,
      cliPath: "/opt/borg-runtime/dist/cli.js",
      execPath: "/opt/node",
      spawnDetached,
      now: () => frozen,
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
        args: ["/opt/borg-runtime/dist/cli.js", runDir],
        options: { detached: true, stdio: "ignore" },
        unrefed: true,
      },
    ]);

    await expect(provider.getRun(worker.id, spec.runId)).resolves.toEqual({
      version: 1,
      runId: spec.runId,
      status: "queued",
      updatedAt: "2026-01-01T00:00:00.000Z",
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
    await expect(provider.destroy(worker.id)).resolves.toBe(false);
  });
});
