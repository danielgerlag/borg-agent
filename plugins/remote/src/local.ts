import {
  remoteProvision,
  remoteRunSpecSchema,
  remoteRunStatusDocumentSchema,
  type CommandInput,
  type RemoteRunSpec,
  type RemoteRunStatusDocument,
  type RemoteWorker,
} from "@borg/contracts";
import type { PluginStore } from "@borg/plugin-sdk";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createReadyWorker,
  deleteStoredWorker,
  listWorkersForRuntime,
  placeholderRunStatus,
  readWorker,
  sanitizeWorkerSlug,
  writeWorker,
  type RemoteProvider,
} from "./orchestrator";

export type SpawnDetached = (
  command: string,
  args: readonly string[],
  options: { readonly detached: true; readonly stdio: "ignore" },
) => { unref(): void };

export const defaultSpawnDetached: SpawnDetached = (command, args, options) =>
  spawn(command, [...args], options);

export interface LocalProviderOptions {
  readonly store: PluginStore;
  readonly dataDir: string;
  readonly cliPath: string;
  readonly execPath: string;
  readonly spawnDetached: SpawnDetached;
  readonly now?: () => Date;
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
  const runDir = runDataDir(options.dataDir, workerId, parsed.runId);
  await mkdir(runDir, { recursive: true });
  await writeFile(
    path.join(runDir, "spec.json"),
    `${JSON.stringify(parsed, null, 2)}\n`,
    "utf8",
  );
  const child = options.spawnDetached(
    options.execPath,
    [options.cliPath, runDir],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
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
    throw error;
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
