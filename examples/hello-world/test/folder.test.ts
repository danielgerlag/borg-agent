/**
 * Path confinement for the chat folder. These checks do not start a kernel.
 */

import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { workspaceFileLimit } from "../src/contract.js";
import {
  listWorkspaceFiles,
  readWorkspaceText,
  writeWorkspaceText,
} from "../src/folder.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "hello-world-folder-"));
  directories.push(directory);
  return directory;
}

describe("chat folder", () => {
  it("reads and writes a relative path, and refuses escapes and links", async () => {
    const root = await tempDir();
    const outside = await tempDir();
    await writeFile(join(outside, "secret.txt"), "TOP-SECRET-TOKEN");
    await symlink(join(outside, "secret.txt"), join(root, "linked.txt"));
    await symlink(outside, join(root, "out"));

    const written = await writeWorkspaceText(root, "notes/a.txt", "hello");
    expect(written).toEqual({ path: "notes/a.txt", bytesWritten: 5 });
    expect(await readWorkspaceText(root, "notes/a.txt")).toEqual({
      path: "notes/a.txt",
      content: "hello",
    });
    expect((await listWorkspaceFiles(root)).map((file) => file.path)).toEqual(["notes/a.txt"]);

    await expect(readWorkspaceText(root, "../secret.txt")).rejects.toThrow(
      "Workspace path escapes the session workspace",
    );
    await expect(readWorkspaceText(root, "/etc/passwd")).rejects.toThrow(
      "Workspace path must be a non-empty relative path",
    );
    await expect(readWorkspaceText(root, "a\0b")).rejects.toThrow(
      "Workspace path must be a non-empty relative path",
    );
    await expect(readWorkspaceText(undefined, "a.txt")).rejects.toThrow(
      "This tool requires a session workspace",
    );
    await expect(readWorkspaceText(root, "linked.txt")).rejects.toThrow(
      "Workspace paths cannot traverse symbolic links",
    );
    await expect(readWorkspaceText(root, "out/secret.txt")).rejects.toThrow(
      "Workspace paths cannot traverse symbolic links",
    );
    await expect(writeWorkspaceText(root, "linked.txt", "nope")).rejects.toThrow(
      "Workspace paths cannot traverse symbolic links",
    );
    await expect(readWorkspaceText(root, "missing.txt")).rejects.toThrow("Workspace file is missing");
    expect(await readWorkspaceText(root, "notes/a.txt")).toMatchObject({ content: "hello" });
  });

  it("refuses a file over the size limit", async () => {
    const root = await tempDir();
    await expect(
      writeWorkspaceText(root, "big.txt", "x".repeat(workspaceFileLimit + 1)),
    ).rejects.toThrow("Workspace file is too large");
  });
});
