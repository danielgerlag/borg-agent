import {
  assertUnattendedAllowlist,
  remoteProvision,
  remoteRuntimeIdSchema,
  remoteRunStatusDocumentSchema,
  remoteRunSpecSchema,
  remoteWorkerIdSchema,
  remoteWorkerSchema,
  type CommandInput,
  type RemoteRunSpec,
  type RemoteRunStatusDocument,
  type RemoteWorker,
} from "@borg/contracts";
import type { JsonValue, PluginStore } from "@borg/plugin-sdk";

export type RemoteRuntimeId = "local" | "azure-vm" | "kubernetes";

export interface RemoteProvider {
  readonly runtime: RemoteRuntimeId;
  list(): Promise<readonly RemoteWorker[]>;
  provision(input: CommandInput<typeof remoteProvision>): Promise<RemoteWorker>;
  destroy(workerId: string): Promise<boolean>;
  submitRun(workerId: string, spec: RemoteRunSpec): Promise<string>;
  getRun(workerId: string, runId: string): Promise<RemoteRunStatusDocument>;
}

export type RemoteFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

export function workerStoreKey(workerId: string): string {
  return `worker/${workerId}`;
}

export function bindingStoreKey(workerId: string): string {
  return `binding/${workerId}`;
}

export function sanitizeWorkerSlug(
  value: string,
  fallback = "worker",
): string {
  const slug = value
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
  if (slug.length === 0) {
    return fallback;
  }
  const trimmed = slug.slice(0, 64).replace(/[-_]+$/, "");
  return trimmed.length > 0 ? trimmed : fallback;
}

export function runtimeFromWorkerId(workerId: string): RemoteRuntimeId {
  const parsed = remoteWorkerIdSchema.parse(workerId);
  return remoteRuntimeIdSchema.parse(parsed.split("/")[0]);
}

export async function readWorker(
  store: PluginStore,
  workerId: string,
): Promise<RemoteWorker | undefined> {
  const value = await store.get(workerStoreKey(workerId));
  if (value === undefined) {
    return undefined;
  }
  return remoteWorkerSchema.parse(value);
}

export async function writeWorker(
  store: PluginStore,
  worker: RemoteWorker,
): Promise<void> {
  await store.set(workerStoreKey(worker.id), toJsonValue(worker));
}

export async function listWorkersForRuntime(
  store: PluginStore,
  runtime: RemoteRuntimeId,
): Promise<readonly RemoteWorker[]> {
  const entries = await store.list(`${workerStoreKey(runtime)}/`);
  return entries.map((entry) => remoteWorkerSchema.parse(entry.value));
}

export async function deleteStoredWorker(
  store: PluginStore,
  workerId: string,
): Promise<boolean> {
  const existing = await readWorker(store, workerId);
  if (existing === undefined) {
    return false;
  }
  await store.delete(workerStoreKey(workerId));
  await store.delete(bindingStoreKey(workerId));
  return true;
}

export function createReadyWorker(input: {
  readonly id: string;
  readonly runtime: RemoteRuntimeId;
  readonly displayName: string;
  readonly now: Date;
}): RemoteWorker {
  const timestamp = input.now.toISOString();
  return remoteWorkerSchema.parse({
    id: input.id,
    runtime: input.runtime,
    displayName: input.displayName,
    status: "ready",
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

export function placeholderRunStatus(
  runId: string,
  status: "queued" | "running",
  updatedAt: string,
): RemoteRunStatusDocument {
  return remoteRunStatusDocumentSchema.parse({
    version: 1,
    runId,
    status,
    updatedAt,
  });
}

export class RemoteOrchestrator {
  readonly #providers: ReadonlyMap<RemoteRuntimeId, RemoteProvider>;

  constructor(providers: ReadonlyMap<RemoteRuntimeId, RemoteProvider>) {
    this.#providers = providers;
  }

  async list(): Promise<readonly RemoteWorker[]> {
    const groups = await Promise.all(
      [...this.#providers.values()].map((provider) => provider.list()),
    );
    return groups.flat();
  }

  async provision(
    input: CommandInput<typeof remoteProvision>,
  ): Promise<RemoteWorker> {
    return this.#providerByRuntime(input.runtime).provision(input);
  }

  async destroy(workerId: string): Promise<boolean> {
    return this.#providerForWorker(workerId).destroy(workerId);
  }

  async submitRun(
    workerId: string,
    spec: {
      readonly persona: { readonly allowedTools: readonly string[] };
    },
  ): Promise<string> {
    assertUnattendedAllowlist(spec.persona.allowedTools);
    return this.#providerForWorker(workerId).submitRun(
      workerId,
      remoteRunSpecSchema.parse(spec),
    );
  }

  async getRun(
    workerId: string,
    runId: string,
  ): Promise<RemoteRunStatusDocument> {
    return this.#providerForWorker(workerId).getRun(workerId, runId);
  }

  #providerByRuntime(runtime: RemoteRuntimeId): RemoteProvider {
    const provider = this.#providers.get(runtime);
    if (provider === undefined) {
      throw new Error(`No provider for remote runtime ${runtime}`);
    }
    return provider;
  }

  #providerForWorker(workerId: string): RemoteProvider {
    return this.#providerByRuntime(runtimeFromWorkerId(workerId));
  }
}
