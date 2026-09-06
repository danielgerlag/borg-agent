import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  SandboxFactory,
  type SandboxProcessRunner,
} from "../src/sandbox-factory";

describe("SandboxFactory", () => {
  it("runs node source inside the root and blocks writes outside it", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "borg-sandbox-node-"));
    const outside = path.join(path.dirname(root), `escape-${path.basename(root)}.txt`);
    const factory = new SandboxFactory();
    const inside = await factory.run({
      kind: "node",
      root,
      source:
        "import { writeFileSync } from 'node:fs'; writeFileSync('inside.txt', 'ok');",
    });
    expect(inside.exitCode).toBe(0);
    await expect(readFile(path.join(root, "inside.txt"), "utf8")).resolves.toBe(
      "ok",
    );

    const escape = await factory.run({
      kind: "node",
      root,
      source: `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(outside)}, 'no');`,
    });
    expect(escape.exitCode).not.toBe(0);
    await expect(readFile(outside, "utf8")).rejects.toThrow();
  });

  it("runs the uv runner with cwd at the sandbox root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "borg-sandbox-uv-"));
    const calls: { command: string; args: string[]; cwd: string }[] = [];
    const runProcess: SandboxProcessRunner = async (command, args, options) => {
      calls.push({ command, args: [...args], cwd: options.cwd });
      await writeFile(path.join(options.cwd, "inside.txt"), "uv-ok", "utf8");
      return { exitCode: 0, stdout: "uv-ok", stderr: "" };
    };
    const factory = new SandboxFactory({
      runProcess,
      uvExecutable: "/usr/bin/uv",
    });
    const result = await factory.run({
      kind: "uv",
      root,
      source: "print('hi')",
    });
    expect(result.exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe("/usr/bin/uv");
    const physicalRoot = await realpath(root);
    expect(calls[0]?.cwd).toBe(physicalRoot);
    expect(calls[0]?.args.slice(0, 3)).toEqual([
      "run",
      "--directory",
      physicalRoot,
    ]);
    expect(calls[0]?.args).toContain("python");
    await expect(readFile(path.join(root, "inside.txt"), "utf8")).resolves.toBe(
      "uv-ok",
    );
  });

  it("rejects an OS command that escapes the root", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "borg-sandbox-os-"));
    const factory = new SandboxFactory();
    await expect(
      factory.run({
        kind: "os",
        root,
        argv: ["../outside"],
      }),
    ).rejects.toThrow(/escapes/);
  });
});
