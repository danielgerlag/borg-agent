import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const exampleDirectory = fileURLToPath(new URL("..", import.meta.url));
const repositoryRoot = path.resolve(exampleDirectory, "../..");
let temporaryDirectory: string | undefined;

afterEach(async () => {
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = undefined;
  }
});

describe("headless example", () => {
  it("boots the kernel, answers one hello request, and stops", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "borg-example-test-"));
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [path.join(exampleDirectory, "dist/main.js")],
      {
        cwd: exampleDirectory,
        env: { ...process.env, TMPDIR: temporaryDirectory },
        timeout: 30_000,
      },
    );
    expect(stdout).toContain("borg.hello: Kernel alive");
  });

  it("is quoted verbatim in README.md", async () => {
    const [source, readme] = await Promise.all([
      readFile(path.join(exampleDirectory, "src/main.ts"), "utf8"),
      readFile(path.join(repositoryRoot, "README.md"), "utf8"),
    ]);
    expect(readme).toContain("```ts\n" + source + "```\n");
  });
});
