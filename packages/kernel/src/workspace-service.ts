import type {
  WorkspaceImportResult,
  WorkspacePreview,
} from "@borg/contracts";
import { z } from "@borg/plugin-sdk";
import { constants, lstatSync, mkdirSync, realpathSync } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import path from "node:path";

const sessionIdSchema = z.string().uuid();

const TEXT_PREVIEW_LIMIT = 1_048_576;
const IMAGE_PREVIEW_LIMIT = 8_388_608;
const IMPORT_FILE_LIMIT = 33_554_432;
const IMPORT_BATCH_FILES = 50;
const IMPORT_BATCH_BYTES = 134_217_728;
const IMPORT_MAX_DEPTH = 8;
const UNIQUE_NAME_LIMIT = 10_000;
const SNIFF_BYTES = 512;

const IMAGE_MIME_TYPES = new Map<string, string>([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".svg", "image/svg+xml"],
  [".bmp", "image/bmp"],
  [".ico", "image/x-icon"],
]);

const TEXT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".mdx",
  ".json",
  ".jsonc",
  ".json5",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".cts",
  ".mts",
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".html",
  ".htm",
  ".xml",
  ".yml",
  ".yaml",
  ".toml",
  ".ini",
  ".cfg",
  ".conf",
  ".env",
  ".csv",
  ".tsv",
  ".py",
  ".pyi",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".kts",
  ".c",
  ".h",
  ".cpp",
  ".cc",
  ".cxx",
  ".hpp",
  ".hh",
  ".cs",
  ".swift",
  ".php",
  ".sql",
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".ps1",
  ".lua",
  ".r",
  ".pl",
  ".graphql",
  ".gql",
  ".proto",
  ".vue",
  ".svelte",
  ".astro",
  ".lock",
  ".log",
  ".rst",
  ".tex",
]);

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

interface ImportAccumulator {
  imported: number;
  skipped: number;
  bytes: number;
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
      if (!isMissing(error)) {
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
    const handle = this.#requireHandle(ownerPluginId, sessionId);
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
            path: toPosixRelative(handle.rootPath, filename),
            size: toByteSize(stats.size),
            updatedAt: stats.mtime.toISOString(),
          });
        }
      }
    };
    await visit(handle.rootPath);
    return Object.freeze(files.map((file) => Object.freeze(file)));
  }

  async readFile(
    ownerPluginId: string,
    sessionId: string,
    relativePath: string,
  ): Promise<WorkspacePreview> {
    const handle = this.#requireHandle(ownerPluginId, sessionId);
    const posixPath = posixRelativePath(relativePath);
    const resolved = await resolveContainedFile(handle.rootPath, posixPath);
    const extension = path.posix.extname(posixPath).toLowerCase();
    const imageMime = IMAGE_MIME_TYPES.get(extension);
    const size = toByteSize(resolved.stats.size);
    if (imageMime) {
      if (size > IMAGE_PREVIEW_LIMIT) {
        return { kind: "binary", path: posixPath, size };
      }
      const bytes = await readRange(resolved.realPath, 0, size);
      return {
        kind: "image",
        path: posixPath,
        size,
        mimeType: imageMime,
        content: bytes.toString("base64"),
      };
    }
    const knownText = TEXT_EXTENSIONS.has(extension);
    if (!knownText && size > 0) {
      const head = await readRange(
        resolved.realPath,
        0,
        Math.min(SNIFF_BYTES, size),
      );
      if (head.includes(0)) {
        return { kind: "binary", path: posixPath, size };
      }
    }
    const readSize = Math.min(size, TEXT_PREVIEW_LIMIT);
    const body = await readRange(resolved.realPath, 0, readSize);
    return {
      kind: "text",
      path: posixPath,
      size,
      content: body.toString("utf8"),
      truncated: size > TEXT_PREVIEW_LIMIT,
    };
  }

  async importNativePaths(
    ownerPluginId: string,
    sessionId: string,
    nativePaths: readonly string[],
    destDir?: string,
  ): Promise<WorkspaceImportResult> {
    const handle = this.#requireHandle(ownerPluginId, sessionId);
    const destination = await ensureContainedDirectory(
      handle.rootPath,
      destDir === undefined ? [] : posixRelativePath(destDir).split("/"),
    );
    const acc: ImportAccumulator = { imported: 0, skipped: 0, bytes: 0 };
    for (const nativePath of nativePaths) {
      if (!path.isAbsolute(nativePath) || nativePath.includes("\0")) {
        acc.skipped += 1;
        continue;
      }
      await importEntry(nativePath, destination, 0, acc);
    }
    return {
      files: [...(await this.listFiles(ownerPluginId, sessionId))],
      imported: acc.imported,
      skipped: acc.skipped,
    };
  }

  resolveNativePath(
    ownerPluginId: string,
    sessionId: string,
    relativePath: string,
  ): string {
    const handle = this.#requireHandle(ownerPluginId, sessionId);
    const posixPath = posixRelativePath(relativePath);
    const lexical = joinRelative(handle.rootPath, posixPath);
    const stats = lstatSync(lexical);
    if (stats.isSymbolicLink()) {
      throw new Error("Workspace path cannot be a symbolic link");
    }
    const real = realpathSync(lexical);
    assertContained(handle.rootPath, real);
    return real;
  }

  async release(ownerPluginId: string, sessionId: string): Promise<void> {
    const handle = this.get(ownerPluginId, sessionId);
    if (!handle) {
      return;
    }
    this.#handles.delete(`${ownerPluginId}:${sessionId}`);
    await rm(handle.rootPath, { recursive: true, force: true });
  }

  #requireHandle(ownerPluginId: string, sessionId: string): WorkspaceHandle {
    const handle = this.get(ownerPluginId, sessionId);
    if (!handle) {
      throw new Error(`Workspace for session ${sessionId} is unavailable`);
    }
    return handle;
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

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function toByteSize(size: number | bigint): number {
  if (typeof size === "bigint") {
    if (size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("Workspace file is too large");
    }
    return Number(size);
  }
  return size;
}

function posixRelativePath(relativePath: string): string {
  if (
    relativePath.length === 0 ||
    relativePath.includes("\0") ||
    relativePath.includes("\\") ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error("Workspace path is invalid");
  }
  const segments = relativePath.split("/");
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    throw new Error("Workspace path is invalid");
  }
  return segments.join("/");
}

function joinRelative(root: string, posixPath: string): string {
  return path.join(root, ...posixPath.split("/"));
}

function toPosixRelative(root: string, filename: string): string {
  return path.relative(root, filename).split(path.sep).join("/");
}

async function exists(filename: string): Promise<boolean> {
  try {
    await lstat(filename);
    return true;
  } catch (error) {
    if (isMissing(error)) {
      return false;
    }
    throw error;
  }
}

async function readRange(
  filename: string,
  position: number,
  length: number,
): Promise<Buffer> {
  if (length === 0) {
    return Buffer.alloc(0);
  }
  const file = await open(filename, constants.O_RDONLY);
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await file.read(buffer, 0, length, position);
    return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}

async function resolveContainedFile(
  root: string,
  posixPath: string,
): Promise<{ readonly realPath: string; readonly stats: Awaited<ReturnType<typeof lstat>> }> {
  const lexical = joinRelative(root, posixPath);
  const stats = await lstat(lexical);
  if (stats.isSymbolicLink()) {
    throw new Error("Workspace path cannot be a symbolic link");
  }
  if (!stats.isFile()) {
    throw new Error("Workspace reads require a regular file");
  }
  const realPath = await realpath(lexical);
  assertContained(root, realPath);
  return { realPath, stats };
}

async function ensureContainedDirectory(
  root: string,
  segments: readonly string[],
): Promise<string> {
  let current = root;
  for (const segment of segments) {
    const next = path.join(current, segment);
    let stats = await lstat(next).catch((error: unknown) => {
      if (isMissing(error)) {
        return undefined;
      }
      throw error;
    });
    if (!stats) {
      await mkdir(next);
      stats = await lstat(next);
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error("Workspace destination is invalid");
    }
    current = await realpath(next);
    assertContained(root, current);
  }
  return current;
}

async function allocateUniqueName(
  directory: string,
  filename: string,
): Promise<string> {
  const parsed = path.parse(filename);
  let candidate = filename;
  for (let n = 2; n <= UNIQUE_NAME_LIMIT; n += 1) {
    if (!(await exists(path.join(directory, candidate)))) {
      return candidate;
    }
    candidate = `${parsed.name} (${n})${parsed.ext}`;
  }
  throw new Error("Could not allocate a unique workspace filename");
}

async function importEntry(
  sourcePath: string,
  destDirectory: string,
  depth: number,
  acc: ImportAccumulator,
): Promise<void> {
  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await lstat(sourcePath);
  } catch {
    acc.skipped += 1;
    return;
  }
  if (stats.isSymbolicLink()) {
    acc.skipped += 1;
    return;
  }
  if (stats.isDirectory()) {
    if (depth >= IMPORT_MAX_DEPTH) {
      acc.skipped += 1;
      return;
    }
    const name = await allocateUniqueName(
      destDirectory,
      path.basename(sourcePath),
    );
    const nextDirectory = path.join(destDirectory, name);
    await mkdir(nextDirectory);
    const children = await readdir(sourcePath);
    for (const child of children) {
      await importEntry(
        path.join(sourcePath, child),
        nextDirectory,
        depth + 1,
        acc,
      );
    }
    return;
  }
  if (!stats.isFile()) {
    acc.skipped += 1;
    return;
  }
  const size = toByteSize(stats.size);
  if (
    size > IMPORT_FILE_LIMIT ||
    acc.imported >= IMPORT_BATCH_FILES ||
    acc.bytes + size > IMPORT_BATCH_BYTES
  ) {
    acc.skipped += 1;
    return;
  }
  const name = await allocateUniqueName(
    destDirectory,
    path.basename(sourcePath),
  );
  try {
    await copyFile(
      sourcePath,
      path.join(destDirectory, name),
      constants.COPYFILE_EXCL,
    );
  } catch {
    acc.skipped += 1;
    return;
  }
  acc.imported += 1;
  acc.bytes += size;
}
