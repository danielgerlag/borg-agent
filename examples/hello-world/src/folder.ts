/**
 * Confines list, read, and write to one chat folder.
 */

import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { workspaceFileLimit } from "./contract.js";

export interface WorkspaceTextFile {
  readonly path: string;
  readonly content: string;
}

export interface WorkspaceFileEntry {
  readonly path: string;
  readonly size: number;
}

export function resolveWorkspacePath(root: string | undefined, requestedPath: string): string {
  if (!root) {
    throw new Error("This tool requires a session workspace");
  }
  if (
    requestedPath.length === 0 ||
    requestedPath.includes("\0") ||
    path.isAbsolute(requestedPath)
  ) {
    throw new Error("Workspace path must be a non-empty relative path");
  }
  const resolved = path.resolve(root, requestedPath);
  const relative = path.relative(root, resolved);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("Workspace path escapes the session workspace");
  }
  return resolved;
}

function assertInside(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("Workspace path resolves outside the session workspace");
  }
}

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !("code" in error)) {
    return undefined;
  }
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function posixRelative(root: string, filename: string): string {
  const relative = path.relative(root, filename);
  if (relative.startsWith("..") || path.isAbsolute(relative) || relative.length === 0) {
    throw new Error("Workspace path escapes the session workspace");
  }
  return relative.split(path.sep).join("/");
}

export async function resolvePhysicalWorkspacePath(
  rootPath: string | undefined,
  requestedPath: string,
  createParents: boolean,
): Promise<{ readonly root: string; readonly target: string }> {
  if (!rootPath) {
    throw new Error("This tool requires a session workspace");
  }
  const lexicalTarget = resolveWorkspacePath(rootPath, requestedPath);
  const relative = path.relative(rootPath, lexicalTarget);
  const root = await realpath(rootPath);
  const segments = relative.split(path.sep);
  const name = segments.at(-1);
  if (name === undefined || name.length === 0) {
    throw new Error("Workspace path must be a non-empty relative path");
  }
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    const next = path.join(current, segment);
    let stats = await lstat(next).catch((error: unknown) => {
      if (isMissing(error)) {
        return undefined;
      }
      throw error;
    });
    if (!stats && createParents) {
      await mkdir(next).catch((error: unknown) => {
        if (errorCode(error) !== "EEXIST") {
          throw error;
        }
      });
      stats = await lstat(next);
    }
    if (!stats) {
      throw new Error("Workspace parent directory is unavailable");
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error("Workspace paths cannot traverse symbolic links");
    }
    current = await realpath(next);
    assertInside(root, current);
  }
  return { root, target: path.join(current, name) };
}

export async function listWorkspaceFiles(
  rootPath: string | undefined,
): Promise<readonly WorkspaceFileEntry[]> {
  if (!rootPath) {
    throw new Error("This tool requires a session workspace");
  }
  const root = await realpath(rootPath);
  const files: WorkspaceFileEntry[] = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
      if (files.length >= 1_000) {
        return;
      }
      const filename = path.join(directory, entry.name);
      const stats = await lstat(filename);
      if (stats.isSymbolicLink()) {
        continue;
      }
      if (stats.isDirectory()) {
        await visit(filename);
        continue;
      }
      if (!stats.isFile()) {
        continue;
      }
      if (!Number.isSafeInteger(stats.size) || stats.size < 0) {
        throw new Error("Workspace file size is invalid");
      }
      files.push({ path: posixRelative(root, filename), size: stats.size });
    }
  };
  await visit(root);
  files.sort((left, right) => left.path.localeCompare(right.path));
  return files;
}

export async function readWorkspaceText(
  rootPath: string | undefined,
  requestedPath: string,
): Promise<WorkspaceTextFile> {
  const { root, target } = await resolvePhysicalWorkspacePath(rootPath, requestedPath, false);
  const file = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(
    (error: unknown) => {
      if (isMissing(error)) {
        throw new Error("Workspace file is missing");
      }
      if (errorCode(error) === "ELOOP") {
        throw new Error("Workspace paths cannot traverse symbolic links");
      }
      throw error;
    },
  );
  try {
    const stats = await file.stat();
    if (!stats.isFile()) {
      throw new Error("Workspace reads require a regular file");
    }
    if (stats.size > workspaceFileLimit) {
      throw new Error("Workspace file is too large");
    }
    const content = await file.readFile({ encoding: "utf8" });
    if (content.includes("\0")) {
      throw new Error("Workspace reads require UTF-8 text");
    }
    return { path: posixRelative(root, target), content };
  } finally {
    await file.close();
  }
}

export async function writeWorkspaceText(
  rootPath: string | undefined,
  requestedPath: string,
  content: string,
): Promise<{ readonly path: string; readonly bytesWritten: number }> {
  if (Buffer.byteLength(content, "utf8") > workspaceFileLimit) {
    throw new Error("Workspace file is too large");
  }
  const { root, target } = await resolvePhysicalWorkspacePath(rootPath, requestedPath, true);
  const existing = await lstat(target).catch((error: unknown) => {
    if (isMissing(error)) {
      return undefined;
    }
    throw error;
  });
  if (existing?.isSymbolicLink()) {
    throw new Error("Workspace paths cannot traverse symbolic links");
  }
  if (existing && !existing.isFile()) {
    throw new Error("Workspace writes require a regular file");
  }
  const temporary = path.join(path.dirname(target), `.files-${randomUUID()}.tmp`);
  try {
    const file = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      await file.writeFile(content, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  return {
    path: posixRelative(root, target),
    bytesWritten: Buffer.byteLength(content, "utf8"),
  };
}
