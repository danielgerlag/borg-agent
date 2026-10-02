import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const exampleDirectory = fileURLToPath(new URL("..", import.meta.url));
let temporaryDirectory: string | undefined;

afterEach(async () => {
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = undefined;
  }
});

describe("night desk example", () => {
  it("runs the pager and the runbook and prints the mitigation", async () => {
    temporaryDirectory = await mkdtemp(
      path.join(os.tmpdir(), "borg-example-test-"),
    );
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [path.join(exampleDirectory, "dist/main.js")],
      {
        cwd: exampleDirectory,
        env: { ...process.env, TMPDIR: temporaryDirectory },
        timeout: 30_000,
      },
    );
    expect(stdout).toContain(
      "Night desk: pager-1 disk 98% full, mitigated by rotated the log and freed the volume",
    );
  });

  it("keeps the pager, runbook, model, and ui from importing each other", async () => {
    const sources = await Promise.all([
      readFile(path.join(exampleDirectory, "src/pager.ts"), "utf8"),
      readFile(path.join(exampleDirectory, "src/runbook.ts"), "utf8"),
      readFile(path.join(exampleDirectory, "src/model.ts"), "utf8"),
      readFile(path.join(exampleDirectory, "src/ui.tsx"), "utf8"),
    ]);
    for (const source of sources) {
      const specifiers = [
        ...source.matchAll(/from\s+["'](\.[^"']+)["']/g),
      ].map((match) => match[1]);
      for (const specifier of specifiers) {
        expect(specifier).toBe("./contract");
      }
    }
  });
});
