import {
  remoteProvision,
  remoteRunSpecSchema,
  remoteRunStatusDocumentSchema,
  type CommandInput,
  type RemoteRunSpec,
  type RemoteRunStatusDocument,
  type RemoteWorker,
} from "@borg-agent/contracts";
import { z, type JsonValue, type PluginStore } from "@borg-agent/plugin-sdk";
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createReadyWorker,
  deleteStoredWorker,
  listWorkersForRuntime,
  placeholderRunStatus,
  readWorker,
  sanitizeWorkerSlug,
  toJsonValue,
  writeWorker,
  type RemoteProvider,
} from "./orchestrator";

export type SpawnDetached = (
  command: string,
  args: readonly string[],
  options: {
    readonly detached: true;
    readonly stdio: "ignore";
    readonly env: Readonly<Record<string, string>>;
  },
) => {
  readonly pid?: number | undefined;
  unref(): void;
  once(event: "error", listener: (error: Error) => void): void;
  once(event: "spawn", listener: () => void): void;
};

const UNIX_INHERITED_ENV_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "LANGUAGE",
] as const;

const WINDOWS_INHERITED_ENV_KEYS = [
  "PATH",
  "PATHEXT",
  "USERPROFILE",
  "USERNAME",
  "USERDOMAIN",
  "HOMEDRIVE",
  "HOMEPATH",
  "TEMP",
  "TMP",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "LANG",
  "LC_ALL",
] as const;

export function runtimeChildEnv(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const keys =
    process.platform === "win32"
      ? WINDOWS_INHERITED_ENV_KEYS
      : UNIX_INHERITED_ENV_KEYS;
  const env: Record<string, string> = {};
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value.length > 0) {
      env[key] = value;
    }
  }
  env.ELECTRON_RUN_AS_NODE = "1";
  return env;
}

export const defaultSpawnDetached: SpawnDetached = (command, args, options) =>
  spawn(command, [...args], options);

export interface LocalProviderOptions {
  readonly store: PluginStore;
  readonly dataDir: string;
  readonly cliPath: string;
  readonly execPath: string;
  readonly spawnDetached: SpawnDetached;
  readonly now?: () => Date;
  readonly env?: Readonly<Record<string, string>>;
}

export function workerDataDir(dataDir: string, workerId: string): string {
  return path.join(dataDir, "workers", ...workerId.split("/"));
}

export function runDataDir(
  dataDir: string,
  workerId: string,
  runId: string,
): string {
  return path.join(workerDataDir(dataDir, workerId), "runs", runId);
}

function runRecordKey(workerId: string, runId: string): string {
  return `run/${workerId}/${runId}`;
}

export function createLocalProvider(
  options: LocalProviderOptions,
): RemoteProvider {
  const now = options.now ?? (() => new Date());
  return {
    runtime: "local",
    list: () => listWorkersForRuntime(options.store, "local"),
    provision: (input) => provisionLocal(options, input, now),
    destroy: (workerId) => destroyLocal(options, workerId),
    submitRun: (workerId, spec) => submitLocal(options, workerId, spec),
    getRun: (workerId, runId) => getLocalRun(options, workerId, runId, now),
  };
}

async function provisionLocal(
  options: LocalProviderOptions,
  input: CommandInput<typeof remoteProvision>,
  now: () => Date,
): Promise<RemoteWorker> {
  const displayName = input.displayName?.trim() || "local";
  const slug = sanitizeWorkerSlug(displayName, "local");
  const id = `local/${slug}`;
  if ((await readWorker(options.store, id)) !== undefined) {
    throw new Error(`Worker ${id} already exists`);
  }
  const worker = createReadyWorker({
    id,
    runtime: "local",
    displayName,
    now: now(),
  });
  await mkdir(workerDataDir(options.dataDir, id), { recursive: true });
  await writeWorker(options.store, worker);
  return worker;
}

async function destroyLocal(
  options: LocalProviderOptions,
  workerId: string,
): Promise<boolean> {
  const runs = await options.store.list(`run/${workerId}/`);
  for (const entry of runs) {
    stopRecordedPid(entry.value);
    await options.store.delete(entry.key);
  }
  const existed = await deleteStoredWorker(options.store, workerId);
  await rm(workerDataDir(options.dataDir, workerId), {
    recursive: true,
    force: true,
  });
  return existed;
}

async function submitLocal(
  options: LocalProviderOptions,
  workerId: string,
  spec: RemoteRunSpec,
): Promise<string> {
  const worker = await readWorker(options.store, workerId);
  if (worker === undefined) {
    throw new Error(`Unknown worker ${workerId}`);
  }
  const parsed = remoteRunSpecSchema.parse(spec);
  await access(options.cliPath, fsConstants.R_OK);
  const runDir = runDataDir(options.dataDir, workerId, parsed.runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(
    path.join(runDir, "spec.json"),
    `${JSON.stringify(parsed, null, 2)}\n`,
    "utf8",
  );
  const env = options.env ?? runtimeChildEnv();
  const child = options.spawnDetached(
    options.execPath,
    [options.cliPath, runDir],
    { detached: true, stdio: "ignore", env },
  );
  try {
    await waitForSpawn(child);
  } catch (error) {
    throw new Error(
      `Failed to start borg-runtime: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  child.unref();
  const pid = child.pid;
  if (pid === undefined) {
    throw new Error("Failed to start borg-runtime: child pid is missing");
  }
  await options.store.set(
    runRecordKey(workerId, parsed.runId),
    toJsonValue({ pid }),
  );
  return parsed.runId;
}

async function getLocalRun(
  options: LocalProviderOptions,
  workerId: string,
  runId: string,
  now: () => Date,
): Promise<RemoteRunStatusDocument> {
  const worker = await readWorker(options.store, workerId);
  if (worker === undefined) {
    throw new Error(`Unknown worker ${workerId}`);
  }
  const statusPath = path.join(
    runDataDir(options.dataDir, workerId, runId),
    "status.json",
  );
  try {
    return remoteRunStatusDocumentSchema.parse(
      JSON.parse(await readFile(statusPath, "utf8")),
    );
  } catch (error: unknown) {
    if (isEnoent(error)) {
      return placeholderRunStatus(runId, "queued", now().toISOString());
    }
    if (error instanceof SyntaxError || error instanceof z.ZodError) {
      return placeholderRunStatus(runId, "running", now().toISOString());
    }
    throw error;
  }
}

function waitForSpawn(child: {
  once(event: "error", listener: (error: Error) => void): void;
  once(event: "spawn", listener: () => void): void;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("spawn", resolve);
  });
}

function stopRecordedPid(value: JsonValue): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return;
  }
  const pid = "pid" in value ? value.pid : undefined;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      return;
    }
  }
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}
