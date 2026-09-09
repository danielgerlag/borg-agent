import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { WorkspaceService } from "../src";

const SESSION_ID = "f713c604-fdd1-47d4-abdc-82c71ec42fb0";
const PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

async function createService(): Promise<WorkspaceService> {
  const root = await mkdtemp(path.join(os.tmpdir(), "borg-workspaces-"));
  return new WorkspaceService(root);
}

describe("WorkspaceService", () => {
  it("allocates stable session roots and lists only workspace files", async () => {
    const workspaces = await createService();
    const first = workspaces.allocate("borg.chat", SESSION_ID);
    expect(workspaces.allocate("borg.chat", SESSION_ID)).toBe(first);
    await writeFile(path.join(first.rootPath, "note.txt"), "hello", "utf8");

    await expect(
      workspaces.listFiles("borg.chat", SESSION_ID),
    ).resolves.toMatchObject([{ path: "note.txt", size: 5 }]);
    expect(workspaces.get("borg.other", SESSION_ID)).toBeUndefined();
    await expect(
      workspaces.listFiles("borg.context-map", SESSION_ID),
    ).rejects.toThrow(/unavailable/);
    await workspaces.release("borg.chat", SESSION_ID);
    expect(workspaces.get("borg.chat", SESSION_ID)).toBeUndefined();
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

  it("previews text, image, and binary files", async () => {
    const workspaces = await createService();
    const handle = workspaces.allocate("borg.chat", SESSION_ID);
    await mkdir(path.join(handle.rootPath, "notes"));
    await writeFile(
      path.join(handle.rootPath, "notes", "hello.txt"),
      "Created by Borg chat.",
      "utf8",
    );
    await writeFile(path.join(handle.rootPath, "photo.png"), PIXEL_PNG);
    await writeFile(
      path.join(handle.rootPath, "blob.bin"),
      Buffer.from([0, 1, 2, 0, 9]),
    );
    const oversized = Buffer.alloc(8_388_609, 0x89);
    await writeFile(path.join(handle.rootPath, "huge.png"), oversized);

    await expect(
      workspaces.readFile("borg.chat", SESSION_ID, "notes/hello.txt"),
    ).resolves.toEqual({
      kind: "text",
      path: "notes/hello.txt",
      size: 21,
      content: "Created by Borg chat.",
      truncated: false,
    });
    await expect(
      workspaces.readFile("borg.chat", SESSION_ID, "photo.png"),
    ).resolves.toEqual({
      kind: "image",
      path: "photo.png",
      size: PIXEL_PNG.length,
      mimeType: "image/png",
      content: PIXEL_PNG.toString("base64"),
    });
    await expect(
      workspaces.readFile("borg.chat", SESSION_ID, "blob.bin"),
    ).resolves.toEqual({
      kind: "binary",
      path: "blob.bin",
      size: 5,
    });
    await expect(
      workspaces.readFile("borg.chat", SESSION_ID, "huge.png"),
    ).resolves.toEqual({
      kind: "binary",
      path: "huge.png",
      size: oversized.length,
    });
  });

  it("rejects symlink reads and traversal", async () => {
    const workspaces = await createService();
    const handle = workspaces.allocate("borg.chat", SESSION_ID);
    const outside = await mkdtemp(path.join(os.tmpdir(), "borg-outside-"));
    await writeFile(path.join(outside, "secret.txt"), "nope", "utf8");
    await symlink(
      path.join(outside, "secret.txt"),
      path.join(handle.rootPath, "link.txt"),
    );

    await expect(
      workspaces.readFile("borg.chat", SESSION_ID, "link.txt"),
    ).rejects.toThrow(/symbolic link/);
    await expect(
      workspaces.readFile("borg.chat", SESSION_ID, "../secret.txt"),
    ).rejects.toThrow(/invalid/);
    await expect(
      workspaces.readFile("borg.chat", SESSION_ID, "/etc/passwd"),
    ).rejects.toThrow(/invalid/);
    expect(() =>
      workspaces.resolveNativePath("borg.chat", SESSION_ID, "../escape"),
    ).toThrow(/invalid/);
    expect(() =>
      workspaces.resolveNativePath("borg.chat", SESSION_ID, "link.txt"),
    ).toThrow(/symbolic link/);
  });

  it("imports native files with a unique suffix and contained destination", async () => {
    const workspaces = await createService();
    const handle = workspaces.allocate("borg.chat", SESSION_ID);
    await mkdir(path.join(handle.rootPath, "notes"));
    await writeFile(
      path.join(handle.rootPath, "notes", "hello.txt"),
      "existing",
      "utf8",
    );
    const sourceRoot = await mkdtemp(path.join(os.tmpdir(), "borg-import-"));
    await writeFile(path.join(sourceRoot, "hello.txt"), "incoming", "utf8");
    await writeFile(path.join(sourceRoot, "photo.png"), PIXEL_PNG);
    await mkdir(path.join(sourceRoot, "nested"));
    await writeFile(path.join(sourceRoot, "nested", "inner.txt"), "in", "utf8");
    await symlink(
      path.join(sourceRoot, "hello.txt"),
      path.join(sourceRoot, "skip-link.txt"),
    );

    const result = await workspaces.importNativePaths(
      "borg.chat",
      SESSION_ID,
      [
        path.join(sourceRoot, "hello.txt"),
        path.join(sourceRoot, "photo.png"),
        path.join(sourceRoot, "nested"),
        path.join(sourceRoot, "skip-link.txt"),
        "relative/not-absolute.txt",
      ],
      "notes",
    );

    expect(result.imported).toBe(3);
    expect(result.skipped).toBe(2);
    expect(result.files.map((file) => file.path).sort()).toEqual([
      "notes/hello (2).txt",
      "notes/hello.txt",
      "notes/nested/inner.txt",
      "notes/photo.png",
    ]);
    await expect(
      workspaces.readFile("borg.chat", SESSION_ID, "notes/hello (2).txt"),
    ).resolves.toMatchObject({ content: "incoming" });
    expect(
      workspaces.resolveNativePath(
        "borg.chat",
        SESSION_ID,
        "notes/hello (2).txt",
      ),
    ).toBe(path.join(handle.rootPath, "notes", "hello (2).txt"));
    await expect(
      workspaces.importNativePaths(
        "borg.chat",
        SESSION_ID,
        [path.join(sourceRoot, "hello.txt")],
        "../escape",
      ),
    ).rejects.toThrow(/invalid/);
  });
});
