import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { assertUnattendedAllowlist, runDetachedLoop } from "../src";
import { SPEC_FILE, STATUS_FILE } from "../src/status";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function sampleSpec(runId = randomUUID()) {
  return {
    version: 1 as const,
    runId,
    prompt: "echo hello",
    unattended: true as const,
    persona: {
      id: "user/detached",
      name: "Detached",
      instructions: "Finish the task.",
      preferredModels: ["borg.runtime.scripted:scripted"],
      allowedTools: ["tools.echo"],
      loopStrategy: "react" as const,
    },
    provider: {
      kind: "scripted" as const,
      replies: [
        {
          toolCalls: [
            { id: "call-1", name: "tools.echo", input: { text: "hello" } },
          ],
        },
        { content: "done: echoed" },
      ],
    },
  };
}

describe("remote runtime", () => {
  it("rejects tools that need a human", () => {
    expect(() => assertUnattendedAllowlist(["tools.echo"])).not.toThrow();
    expect(() => assertUnattendedAllowlist(["filesystem.write"])).toThrow(
      /cannot use/,
    );
  });

  it("completes a scripted unattended loop", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "borg-runtime-"));
    const spec = sampleSpec();
    await writeFile(
      path.join(root, SPEC_FILE),
      JSON.stringify(spec),
      "utf8",
    );
    await runDetachedLoop(root);
    const status = JSON.parse(
      await readFile(path.join(root, STATUS_FILE), "utf8"),
    ) as { status: string; output?: string };
    expect(status.status).toBe("completed");
    expect(status.output).toContain("done");
  });

  it("finishes after the parent only watches the status file", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "borg-runtime-child-"));
    const spec = sampleSpec();
    await writeFile(
      path.join(root, SPEC_FILE),
      JSON.stringify(spec),
      "utf8",
    );
    const cli = path.join(packageRoot, "dist", "cli.js");
    const child = spawn(process.execPath, [cli, root], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    const deadline = Date.now() + 20_000;
    let status: { status: string; output?: string } | undefined;
    while (Date.now() < deadline) {
      try {
        status = JSON.parse(
          await readFile(path.join(root, STATUS_FILE), "utf8"),
        ) as { status: string; output?: string };
        if (
          status.status === "completed" ||
          status.status === "failed" ||
          status.status === "cancelled"
        ) {
          break;
        }
      } catch {
        // status.json not written yet
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(status?.status).toBe("completed");
    expect(status?.output).toContain("done");
  });
});
