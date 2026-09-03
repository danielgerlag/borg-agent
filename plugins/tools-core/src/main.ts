import { definePlugin, defineTool, z } from "@borg/plugin-sdk";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

export function resolveWorkspacePath(
  root: string | undefined,
  requestedPath: string,
): string {
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

export async function resolvePhysicalWorkspacePath(
  rootPath: string | undefined,
  requestedPath: string,
  createParents: boolean,
): Promise<{ readonly root: string; readonly target: string }> {
  const lexicalTarget = resolveWorkspacePath(rootPath, requestedPath);
  const relative = path.relative(rootPath!, lexicalTarget);
  const root = await realpath(rootPath!);
  const segments = relative.split(path.sep);
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
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            (error as NodeJS.ErrnoException).code === "EEXIST"
          )
        ) {
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
  return { root, target: path.join(current, segments.at(-1)!) };
}

export default definePlugin({
  id: "borg.tools.core",
  version: "0.1.0",
  engines: {
    borg: "^0.1.0",
  },
  permissions: ["fs:sessionWorkspace", "tools.register"],
  contributes: {
    kinds: ["tool"],
  },
  activate(context) {
    context.tools.register(
      defineTool({
        id: "filesystem.read",
        description: "Read a UTF-8 text file from the session workspace",
        input: z.object({ path: z.string().min(1) }).strict(),
        output: z
          .object({ path: z.string(), content: z.string() })
          .strict(),
        approval: "auto",
        sideEffect: false,
        async execute(input, execution) {
          execution.signal.throwIfAborted();
          const { root, target } = await resolvePhysicalWorkspacePath(
            execution.workspaceRoot,
            input.path,
            false,
          );
          const file = await open(
            target,
            constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
          );
          try {
            const stats = await file.stat();
            if (!stats.isFile()) {
              throw new Error("Workspace reads require a regular file");
            }
            execution.signal.throwIfAborted();
            return {
              path: path.relative(root, target).split(path.sep).join("/"),
              content: await file.readFile("utf8"),
            };
          } finally {
            await file.close();
          }
        },
      }),
    );

    context.tools.register(
      defineTool({
        id: "filesystem.write",
        description: "Write a UTF-8 text file in the session workspace",
        input: z
          .object({
            path: z.string().min(1),
            content: z.string(),
          })
          .strict(),
        output: z
          .object({
            path: z.string(),
            bytesWritten: z.number().int().nonnegative(),
          })
          .strict(),
        approval: "ask",
        sideEffect: true,
        async execute(input, execution) {
          execution.signal.throwIfAborted();
          const { root, target } = await resolvePhysicalWorkspacePath(
            execution.workspaceRoot,
            input.path,
            true,
          );
          const temporary = path.join(
            path.dirname(target),
            `.borg-${randomUUID()}.tmp`,
          );
          try {
            const file = await open(
              temporary,
              constants.O_WRONLY |
                constants.O_CREAT |
                constants.O_EXCL |
                (constants.O_NOFOLLOW ?? 0),
              0o600,
            );
            try {
              execution.signal.throwIfAborted();
              await file.writeFile(input.content, "utf8");
              await file.sync();
              execution.signal.throwIfAborted();
            } finally {
              await file.close();
            }
            execution.signal.throwIfAborted();
            await rename(temporary, target);
          } catch (error) {
            await unlink(temporary).catch(() => undefined);
            throw error;
          }
          return {
            path: path.relative(root, target).split(path.sep).join("/"),
            bytesWritten: Buffer.byteLength(input.content, "utf8"),
          };
        },
      }),
    );
  },
});
