import { mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type {
  PluginContext,
  ToolContribution,
} from "@borg/plugin-sdk";
import { SandboxFactory } from "../../../packages/kernel/src";
import {
  default as corePlugin,
  resolvePhysicalWorkspacePath,
  resolveWorkspacePath,
} from "../src/main";

describe("core filesystem tools", () => {
  it("resolves relative paths inside the session workspace", () => {
    const root = path.resolve("/tmp/borg-session");
    expect(resolveWorkspacePath(root, "notes/hello.txt")).toBe(
      path.join(root, "notes", "hello.txt"),
    );
  });

  it("rejects absolute paths and traversal", () => {
    const root = path.resolve("/tmp/borg-session");
    expect(() => resolveWorkspacePath(root, "../escape.txt")).toThrow(
      /escapes/,
    );
    expect(() => resolveWorkspacePath(root, "/tmp/escape.txt")).toThrow(
      /relative/,
    );
    expect(() => resolveWorkspacePath(undefined, "note.txt")).toThrow(
      /requires a session workspace/,
    );
  });

  it("rejects symbolic-link ancestors before creating or reading files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "borg-tool-root-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "borg-tool-outside-"));
    await symlink(outside, path.join(root, "link"));

    await expect(
      resolvePhysicalWorkspacePath(root, "link/nested/file.txt", true),
    ).rejects.toThrow(/symbolic links/);
    await expect(
      resolvePhysicalWorkspacePath(root, "link/file.txt", false),
    ).rejects.toThrow(/symbolic links/);
  });

  it("registers and executes filesystem.read against its session workspace", async () => {
    const tools = new Map<string, ToolContribution>();
    await corePlugin.activate({
      pluginId: "borg.tools.core",
      tools: {
        register: (tool: ToolContribution) => {
          tools.set(tool.id, tool);
          return {
            dispose: () => {
              tools.delete(tool.id);
            },
          };
        },
      },
    } as unknown as PluginContext);
    const root = await mkdtemp(path.join(os.tmpdir(), "borg-tool-root-"));
    await writeFile(path.join(root, "note.txt"), "workspace content", "utf8");
    const read = tools.get("filesystem.read")!;

    const result = await read.execute(read.input.parse({ path: "note.txt" }), {
      toolCallId: crypto.randomUUID(),
      sessionId: crypto.randomUUID(),
      workspaceRoot: root,
      signal: new AbortController().signal,
    });
    expect(read.output.parse(result)).toEqual({
      path: "note.txt",
      content: "workspace content",
    });
    await expect(
      read.execute(read.input.parse({ path: "note.txt" }), {
        toolCallId: crypto.randomUUID(),
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/requires a session workspace/);
  });

  it("runs javascript in the sandbox and cannot write outside the root", async () => {
    const tools = new Map<string, ToolContribution>();
    const sandbox = new SandboxFactory();
    await corePlugin.activate({
      pluginId: "borg.tools.core",
      tools: {
        register: (tool: ToolContribution) => {
          tools.set(tool.id, tool);
          return { dispose: () => undefined };
        },
      },
      sandbox: { run: (input) => sandbox.run(input) },
    } as unknown as PluginContext);
    const root = await mkdtemp(path.join(os.tmpdir(), "borg-tool-code-"));
    const outside = path.join(
      path.dirname(root),
      `escape-${path.basename(root)}.txt`,
    );
    const run = tools.get("code.run")!;
    const inside = await run.execute(
      run.input.parse({
        language: "javascript",
        source:
          "import { writeFileSync } from 'node:fs'; writeFileSync('inside.txt', 'ok');",
      }),
      {
        toolCallId: crypto.randomUUID(),
        sessionId: crypto.randomUUID(),
        workspaceRoot: root,
        signal: new AbortController().signal,
      },
    );
    expect(run.output.parse(inside).exitCode).toBe(0);
    await expect(readFile(path.join(root, "inside.txt"), "utf8")).resolves.toBe(
      "ok",
    );
    const escape = await run.execute(
      run.input.parse({
        language: "javascript",
        source: `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(outside)}, 'no');`,
      }),
      {
        toolCallId: crypto.randomUUID(),
        sessionId: crypto.randomUUID(),
        workspaceRoot: root,
        signal: new AbortController().signal,
      },
    );
    expect(run.output.parse(escape).exitCode).not.toBe(0);
    await expect(readFile(outside, "utf8")).rejects.toThrow();
  });
});
