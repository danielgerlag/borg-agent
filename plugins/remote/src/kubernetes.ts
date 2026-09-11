import {
  remoteProvision,
  remoteRunSpecSchema,
  remoteRunStatusDocumentSchema,
  type CommandInput,
  type RemoteRunSpec,
  type RemoteRunStatusDocument,
  type RemoteWorker,
} from "@borg/contracts";
import { z, type PluginSecrets, type PluginStore } from "@borg/plugin-sdk";
import {
  bindingStoreKey,
  createReadyWorker,
  deleteStoredWorker,
  listWorkersForRuntime,
  placeholderRunStatus,
  readWorker,
  sanitizeWorkerSlug,
  toJsonValue,
  writeWorker,
  type RemoteFetch,
  type RemoteProvider,
} from "./orchestrator";

const kubernetesBindingSchema = z
  .object({
    runtime: z.literal("kubernetes"),
    namespace: z.string().min(1),
    apiServer: z.string().min(1),
  })
  .strict();

export interface KubernetesProviderOptions {
  readonly store: PluginStore;
  readonly secrets: Pick<PluginSecrets, "get" | "set" | "delete">;
  readonly fetch: RemoteFetch;
  readonly now?: () => Date;
}

export function kubeconfigSecretKey(workerId: string): string {
  return `kubeconfig/${workerId}`;
}

export function resolveKubernetesApiServer(kubeconfig: string): string {
  const trimmed = kubeconfig.trim();
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return trimmed.replace(/\/+$/, "");
  }
  const match = /(?:^|\n)\s*server:\s*(\S+)/.exec(trimmed);
  const server = match?.[1]?.replace(/^["']|["']$/g, "");
  if (server === undefined || server.length === 0) {
    throw new Error("Kubernetes kubeconfig is missing server URL");
  }
  return server.replace(/\/+$/, "");
}

export function kubernetesNamespaceUrl(
  apiServer: string,
  namespace: string,
): string {
  return `${trimSlash(apiServer)}/api/v1/namespaces/${encodeURIComponent(namespace)}`;
}

export function kubernetesJobsUrl(
  apiServer: string,
  namespace: string,
): string {
  return `${trimSlash(apiServer)}/apis/batch/v1/namespaces/${encodeURIComponent(namespace)}/jobs`;
}

export function kubernetesConfigMapsUrl(
  apiServer: string,
  namespace: string,
): string {
  return `${trimSlash(apiServer)}/api/v1/namespaces/${encodeURIComponent(namespace)}/configmaps`;
}

export function kubernetesConfigMapUrl(
  apiServer: string,
  namespace: string,
  name: string,
): string {
  return `${kubernetesConfigMapsUrl(apiServer, namespace)}/${encodeURIComponent(name)}`;
}

export function kubernetesRunResourceName(runId: string): string {
  return `borg-run-${runId}`;
}

export function createKubernetesProvider(
  options: KubernetesProviderOptions,
): RemoteProvider {
  const now = options.now ?? (() => new Date());
  return {
    runtime: "kubernetes",
    list: () => listWorkersForRuntime(options.store, "kubernetes"),
    provision: (input) => provisionKubernetes(options, input, now),
    destroy: (workerId) => destroyKubernetes(options, workerId),
    submitRun: (workerId, spec) =>
      submitKubernetesRun(options, workerId, spec, now),
    getRun: (workerId, runId) =>
      getKubernetesRun(options, workerId, runId, now),
  };
}

async function provisionKubernetes(
  options: KubernetesProviderOptions,
  input: CommandInput<typeof remoteProvision>,
  now: () => Date,
): Promise<RemoteWorker> {
  const kubernetes = input.kubernetes;
  if (kubernetes === undefined) {
    throw new Error("Kubernetes provision requires kubeconfig and namespace");
  }
  const namespace = kubernetes.namespace ?? "default";
  const apiServer = resolveKubernetesApiServer(kubernetes.kubeconfig);
  const displayName = input.displayName?.trim() || namespace;
  const slug = sanitizeWorkerSlug(displayName, sanitizeWorkerSlug(namespace));
  const id = `kubernetes/${slug}`;
  if ((await readWorker(options.store, id)) !== undefined) {
    throw new Error(`Worker ${id} already exists`);
  }
  const response = await k8sRequest(options.fetch, {
    url: kubernetesNamespaceUrl(apiServer, namespace),
    method: "GET",
  });
  if (response.status !== 200) {
    throw new Error(
      `Kubernetes namespace ${namespace} is not reachable (${response.status})`,
    );
  }
  const worker = createReadyWorker({
    id,
    runtime: "kubernetes",
    displayName,
    now: now(),
  });
  await options.secrets.set(kubeconfigSecretKey(id), kubernetes.kubeconfig);
  await writeWorker(options.store, worker);
  await options.store.set(
    bindingStoreKey(id),
    toJsonValue({
      runtime: "kubernetes",
      namespace,
      apiServer,
    }),
  );
  return worker;
}

async function destroyKubernetes(
  options: KubernetesProviderOptions,
  workerId: string,
): Promise<boolean> {
  const existed = await deleteStoredWorker(options.store, workerId);
  await options.secrets.delete(kubeconfigSecretKey(workerId));
  return existed;
}

async function submitKubernetesRun(
  options: KubernetesProviderOptions,
  workerId: string,
  spec: RemoteRunSpec,
  now: () => Date,
): Promise<string> {
  const worker = await readWorker(options.store, workerId);
  if (worker === undefined) {
    throw new Error(`Unknown worker ${workerId}`);
  }
  const parsed = remoteRunSpecSchema.parse(spec);
  const binding = await readKubernetesBinding(options.store, workerId);
  const apiServer = await resolveBoundApiServer(options, workerId, binding);
  const namespace = binding.namespace;
  const name = kubernetesRunResourceName(parsed.runId);
  const running = remoteRunStatusDocumentSchema.parse({
    version: 1,
    runId: parsed.runId,
    status: "running",
    updatedAt: now().toISOString(),
  });
  const configMapResponse = await k8sRequest(options.fetch, {
    url: kubernetesConfigMapsUrl(apiServer, namespace),
    method: "POST",
    body: JSON.stringify({
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { name, namespace },
      data: {
        "spec.json": JSON.stringify(parsed),
        "status.json": JSON.stringify(running),
      },
    }),
  });
  if (configMapResponse.status < 200 || configMapResponse.status >= 300) {
    throw new Error(
      `Kubernetes ConfigMap create failed (${configMapResponse.status})`,
    );
  }
  const jobResponse = await k8sRequest(options.fetch, {
    url: kubernetesJobsUrl(apiServer, namespace),
    method: "POST",
    body: JSON.stringify({
      apiVersion: "batch/v1",
      kind: "Job",
      metadata: { name, namespace },
      spec: {
        backoffLimit: 0,
        template: {
          spec: {
            restartPolicy: "Never",
            containers: [
              {
                name: "borg-runtime",
                image: "node:22",
                command: ["node", "/usr/local/bin/borg-runtime", "/run"],
              },
            ],
          },
        },
      },
    }),
  });
  if (jobResponse.status < 200 || jobResponse.status >= 300) {
    throw new Error(`Kubernetes Job create failed (${jobResponse.status})`);
  }
  return parsed.runId;
}

async function getKubernetesRun(
  options: KubernetesProviderOptions,
  workerId: string,
  runId: string,
  now: () => Date,
): Promise<RemoteRunStatusDocument> {
  const worker = await readWorker(options.store, workerId);
  if (worker === undefined) {
    throw new Error(`Unknown worker ${workerId}`);
  }
  const binding = await readKubernetesBinding(options.store, workerId);
  const apiServer = await resolveBoundApiServer(options, workerId, binding);
  const response = await k8sRequest(options.fetch, {
    url: kubernetesConfigMapUrl(
      apiServer,
      binding.namespace,
      kubernetesRunResourceName(runId),
    ),
    method: "GET",
  });
  if (response.status === 404) {
    return placeholderRunStatus(runId, "queued", now().toISOString());
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(
      `Kubernetes run status request failed (${response.status})`,
    );
  }
  return parseConfigMapStatus(await response.json(), runId, now().toISOString());
}

function parseConfigMapStatus(
  payload: unknown,
  runId: string,
  updatedAt: string,
): RemoteRunStatusDocument {
  if (payload === null || typeof payload !== "object") {
    return placeholderRunStatus(runId, "queued", updatedAt);
  }
  const data = "data" in payload ? payload.data : undefined;
  if (data === null || typeof data !== "object") {
    return placeholderRunStatus(runId, "queued", updatedAt);
  }
  const raw =
    "status.json" in data && typeof data["status.json"] === "string"
      ? data["status.json"]
      : undefined;
  if (raw === undefined) {
    return placeholderRunStatus(runId, "queued", updatedAt);
  }
  return remoteRunStatusDocumentSchema.parse(JSON.parse(raw));
}

async function readKubernetesBinding(store: PluginStore, workerId: string) {
  const value = await store.get(bindingStoreKey(workerId));
  if (value === undefined) {
    throw new Error(`Missing Kubernetes binding for ${workerId}`);
  }
  return kubernetesBindingSchema.parse(value);
}

async function resolveBoundApiServer(
  options: KubernetesProviderOptions,
  workerId: string,
  binding: z.infer<typeof kubernetesBindingSchema>,
): Promise<string> {
  const kubeconfig = await options.secrets.get(kubeconfigSecretKey(workerId));
  if (kubeconfig !== undefined && kubeconfig.length > 0) {
    return resolveKubernetesApiServer(kubeconfig);
  }
  return binding.apiServer;
}

async function k8sRequest(
  fetchImpl: RemoteFetch,
  init: {
    readonly url: string;
    readonly method: string;
    readonly body?: string;
  },
): Promise<Response> {
  const headers = new Headers();
  if (init.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  return init.body === undefined
    ? fetchImpl(init.url, { method: init.method, headers })
    : fetchImpl(init.url, {
        method: init.method,
        headers,
        body: init.body,
      });
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
