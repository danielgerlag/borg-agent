import { z } from "@borg/plugin-sdk";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { lstat, readdir, rm } from "node:fs/promises";
import path from "node:path";

const sessionIdSchema = z.string().uuid();

export interface WorkspaceHandle {
  readonly ownerPluginId: string;
  readonly sessionId: string;
  readonly rootPath: string;
}

export interface WorkspaceFile {
  readonly path: string;
  readonly size: number;
  readonly updatedAt: string;
}

export class WorkspaceService {
  readonly #handles = new Map<string, WorkspaceHandle>();
  readonly #physicalRootDirectory: string;

  constructor(readonly rootDirectory: string) {
    mkdirSync(rootDirectory, { recursive: true });
    this.#physicalRootDirectory = realpathSync(rootDirectory);
  }

  allocate(ownerPluginId: string, sessionId: string): WorkspaceHandle {
    if (!/^[a-z0-9]+(?:[.-][a-z0-9-]+)+$/.test(ownerPluginId)) {
      throw new Error(`Workspace owner ${ownerPluginId} is invalid`);
    }
    sessionIdSchema.parse(sessionId);
    const key = `${ownerPluginId}:${sessionId}`;
    const existing = this.#handles.get(key);
    if (existing) {
      return existing;
    }
    const ownerDirectory = path.join(this.rootDirectory, ownerPluginId);
    mkdirSync(ownerDirectory, { recursive: true });
    const physicalOwnerDirectory = realpathSync(ownerDirectory);
    assertContained(this.#physicalRootDirectory, physicalOwnerDirectory);
    const requestedRootPath = path.join(ownerDirectory, sessionId);
    try {
      const stats = lstatSync(requestedRootPath);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new Error(`Workspace root for session ${sessionId} is invalid`);
      }
    } catch (error) {
      if (
        !(
          error instanceof Error &&
          "code" in error &&
          (error as NodeJS.ErrnoException).code === "ENOENT"
        )
      ) {
        throw error;
      }
      mkdirSync(requestedRootPath);
    }
    const rootPath = realpathSync(requestedRootPath);
    assertContained(physicalOwnerDirectory, rootPath);
    const handle = Object.freeze({ ownerPluginId, sessionId, rootPath });
    this.#handles.set(key, handle);
    return handle;
  }

  get(ownerPluginId: string, sessionId: string): WorkspaceHandle | undefined {
    sessionIdSchema.parse(sessionId);
    return this.#handles.get(`${ownerPluginId}:${sessionId}`);
  }

  async listFiles(
    ownerPluginId: string,
    sessionId: string,
  ): Promise<readonly WorkspaceFile[]> {
    const handle = this.get(ownerPluginId, sessionId);
    if (!handle) {
      throw new Error(`Workspace for session ${sessionId} is unavailable`);
    }
    const files: WorkspaceFile[] = [];
    const visit = async (directory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries.sort((left, right) =>
        left.name.localeCompare(right.name),
      )) {
        if (files.length >= 1_000) {
          continue;
        }
        const filename = path.join(directory, entry.name);
        const stats = await lstat(filename);
        if (stats.isSymbolicLink()) {
          continue;
        }
        if (stats.isDirectory()) {
          await visit(filename);
        } else if (stats.isFile()) {
          files.push({
            path: path.relative(handle.rootPath, filename).split(path.sep).join("/"),
            size: stats.size,
            updatedAt: stats.mtime.toISOString(),
          });
        }
      }
    };
    await visit(handle.rootPath);
    return Object.freeze(files.map((file) => Object.freeze(file)));
  }

  async release(ownerPluginId: string, sessionId: string): Promise<void> {
    const handle = this.get(ownerPluginId, sessionId);
    if (!handle) {
      return;
    }
    this.#handles.delete(`${ownerPluginId}:${sessionId}`);
    await rm(handle.rootPath, { recursive: true, force: true });
  }
}

function assertContained(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("Workspace path resolves outside its owner directory");
  }
}
