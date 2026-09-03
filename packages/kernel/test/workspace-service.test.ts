import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WorkspaceService } from "../src";

describe("WorkspaceService", () => {
  it("allocates stable session roots and lists only workspace files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "borg-workspaces-"));
    const workspaces = new WorkspaceService(root);
    const sessionId = "f713c604-fdd1-47d4-abdc-82c71ec42fb0";

    const first = workspaces.allocate("borg.chat", sessionId);
    expect(workspaces.allocate("borg.chat", sessionId)).toBe(first);
    await writeFile(path.join(first.rootPath, "note.txt"), "hello", "utf8");

    await expect(
      workspaces.listFiles("borg.chat", sessionId),
    ).resolves.toMatchObject([
      { path: "note.txt", size: 5 },
    ]);
    expect(workspaces.get("borg.other", sessionId)).toBeUndefined();
    await workspaces.release("borg.chat", sessionId);
    expect(workspaces.get("borg.chat", sessionId)).toBeUndefined();
  });

  it("rejects malformed session identifiers", () => {
    const workspaces = new WorkspaceService(
      path.join(os.tmpdir(), "borg-invalid-workspaces"),
    );
    expect(() => workspaces.allocate("borg.chat", "../escape")).toThrow();
  });

  it("rejects pre-existing workspace and owner symlinks", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "borg-workspaces-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "borg-outside-"));
    const sessionId = "f713c604-fdd1-47d4-abdc-82c71ec42fb1";
    await mkdir(path.join(root, "borg.chat"));
    await symlink(outside, path.join(root, "borg.chat", sessionId));
    const workspaces = new WorkspaceService(root);

    expect(() => workspaces.allocate("borg.chat", sessionId)).toThrow(
      /root.*invalid/,
    );

    const secondRoot = await mkdtemp(
      path.join(os.tmpdir(), "borg-workspaces-"),
    );
    await symlink(outside, path.join(secondRoot, "borg.chat"));
    const second = new WorkspaceService(secondRoot);
    expect(() => second.allocate("borg.chat", crypto.randomUUID())).toThrow(
      /outside its owner/,
    );
  });
});
