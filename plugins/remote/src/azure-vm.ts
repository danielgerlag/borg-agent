import {
  remoteProvision,
  remoteRunSpecSchema,
  remoteRunStatusDocumentSchema,
  type CommandInput,
  type RemoteRunSpec,
  type RemoteRunStatusDocument,
  type RemoteWorker,
} from "@borg/contracts";
import { z, type PluginStore } from "@borg/plugin-sdk";
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

export const AZURE_ARM_BASE = "https://management.azure.com";
export const AZURE_COMPUTE_API_VERSION = "2024-07-01";
export const AZURE_STATUS_BLOB_BASE =
  "https://borgstatus.blob.core.windows.net";
export const ARM_TOKEN_SECRET = "armToken";

const azureBindingSchema = z
  .object({
    runtime: z.literal("azure-vm"),
    subscriptionId: z.string().min(1),
    resourceGroup: z.string().min(1),
    location: z.string().min(1),
    vmName: z.string().min(1),
  })
  .strict();

export interface AzureVmProviderOptions {
  readonly store: PluginStore;
  readonly fetch: RemoteFetch;
  readonly getToken: () => Promise<string | undefined>;
  readonly now?: () => Date;
}

export function azureVmUrl(input: {
  readonly subscriptionId: string;
  readonly resourceGroup: string;
  readonly name: string;
}): string {
  return `${AZURE_ARM_BASE}/subscriptions/${encodeURIComponent(input.subscriptionId)}/resourceGroups/${encodeURIComponent(input.resourceGroup)}/providers/Microsoft.Compute/virtualMachines/${encodeURIComponent(input.name)}?api-version=${AZURE_COMPUTE_API_VERSION}`;
}

export function azureRunBlobUrl(
  runId: string,
  file: "spec.json" | "status.json",
): string {
  return `${AZURE_STATUS_BLOB_BASE}/runs/${encodeURIComponent(runId)}/${file}`;
}

export function createAzureVmProvider(
  options: AzureVmProviderOptions,
): RemoteProvider {
  const now = options.now ?? (() => new Date());
  return {
    runtime: "azure-vm",
    list: () => listWorkersForRuntime(options.store, "azure-vm"),
    provision: (input) => provisionAzureVm(options, input, now),
    destroy: (workerId) => destroyAzureVm(options, workerId),
    submitRun: (workerId, spec) => submitAzureRun(options, workerId, spec, now),
    getRun: (workerId, runId) => getAzureRun(options, workerId, runId, now),
  };
}

function azureVmBody(input: {
  readonly location: string;
  readonly vmSize: string;
  readonly name: string;
  readonly subscriptionId: string;
  readonly resourceGroup: string;
}): Record<string, unknown> {
  return {
    location: input.location,
    properties: {
      hardwareProfile: {
        vmSize: input.vmSize,
      },
      osProfile: {
        computerName: input.name.slice(0, 64),
        adminUsername: "borgadmin",
        linuxConfiguration: {
          disablePasswordAuthentication: true,
          ssh: {
            publicKeys: [
              {
                path: "/home/borgadmin/.ssh/authorized_keys",
                keyData:
                  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEBorgLocalPlaceholderKey",
              },
            ],
          },
        },
      },
      storageProfile: {
        imageReference: {
          publisher: "canonical",
          offer: "0001-com-ubuntu-server-jammy",
          sku: "22_04-lts-gen2",
          version: "latest",
        },
        osDisk: {
          name: `${input.name}-osdisk`,
          createOption: "FromImage",
          managedDisk: {
            storageAccountType: "Standard_LRS",
          },
        },
      },
      networkProfile: {
        networkInterfaces: [
          {
            id: `/subscriptions/${input.subscriptionId}/resourceGroups/${input.resourceGroup}/providers/Microsoft.Network/networkInterfaces/${input.name}-nic`,
            properties: {
              primary: true,
            },
          },
        ],
      },
    },
  };
}

async function provisionAzureVm(
  options: AzureVmProviderOptions,
  input: CommandInput<typeof remoteProvision>,
  now: () => Date,
): Promise<RemoteWorker> {
  const azure = input.azure;
  if (azure === undefined) {
    throw new Error(
      "Azure VM provision requires subscriptionId, resourceGroup, location, and vmSize",
    );
  }
  const displayName = input.displayName?.trim() || "borg";
  const name = sanitizeWorkerSlug(displayName, "borg");
  const id = `azure-vm/${name}`;
  if ((await readWorker(options.store, id)) !== undefined) {
    throw new Error(`Worker ${id} already exists`);
  }
  const vmSize = azure.vmSize ?? "Standard_B2s";
  const url = azureVmUrl({
    subscriptionId: azure.subscriptionId,
    resourceGroup: azure.resourceGroup,
    name,
  });
  const response = await azureRequest(options, url, {
    method: "PUT",
    body: JSON.stringify(
      azureVmBody({
        location: azure.location,
        vmSize,
        name,
        subscriptionId: azure.subscriptionId,
        resourceGroup: azure.resourceGroup,
      }),
    ),
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Azure VM provision failed (${response.status})`);
  }
  const worker = createReadyWorker({
    id,
    runtime: "azure-vm",
    displayName,
    now: now(),
  });
  await writeWorker(options.store, worker);
  await options.store.set(
    bindingStoreKey(id),
    toJsonValue({
      runtime: "azure-vm",
      subscriptionId: azure.subscriptionId,
      resourceGroup: azure.resourceGroup,
      location: azure.location,
      vmName: name,
    }),
  );
  return worker;
}

async function destroyAzureVm(
  options: AzureVmProviderOptions,
  workerId: string,
): Promise<boolean> {
  const worker = await readWorker(options.store, workerId);
  if (worker === undefined) {
    return false;
  }
  const binding = await readAzureBinding(options.store, workerId);
  if (binding !== undefined) {
    const response = await azureRequest(
      options,
      azureVmUrl({
        subscriptionId: binding.subscriptionId,
        resourceGroup: binding.resourceGroup,
        name: binding.vmName,
      }),
      { method: "DELETE" },
    );
    if (
      (response.status < 200 || response.status >= 300) &&
      response.status !== 404
    ) {
      throw new Error(`Azure VM destroy failed (${response.status})`);
    }
  }
  return deleteStoredWorker(options.store, workerId);
}

async function submitAzureRun(
  options: AzureVmProviderOptions,
  workerId: string,
  spec: RemoteRunSpec,
  now: () => Date,
): Promise<string> {
  const worker = await readWorker(options.store, workerId);
  if (worker === undefined) {
    throw new Error(`Unknown worker ${workerId}`);
  }
  const parsed = remoteRunSpecSchema.parse(spec);
  const running = remoteRunStatusDocumentSchema.parse({
    version: 1,
    runId: parsed.runId,
    status: "running",
    updatedAt: now().toISOString(),
  });
  await putBlob(options, azureRunBlobUrl(parsed.runId, "spec.json"), parsed);
  await putBlob(options, azureRunBlobUrl(parsed.runId, "status.json"), running);
  return parsed.runId;
}

async function getAzureRun(
  options: AzureVmProviderOptions,
  workerId: string,
  runId: string,
  now: () => Date,
): Promise<RemoteRunStatusDocument> {
  const worker = await readWorker(options.store, workerId);
  if (worker === undefined) {
    throw new Error(`Unknown worker ${workerId}`);
  }
  const response = await azureRequest(
    options,
    azureRunBlobUrl(runId, "status.json"),
    { method: "GET" },
    false,
  );
  if (response.status === 404) {
    return placeholderRunStatus(runId, "queued", now().toISOString());
  }
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Azure run status request failed (${response.status})`);
  }
  return remoteRunStatusDocumentSchema.parse(await response.json());
}

async function readAzureBinding(store: PluginStore, workerId: string) {
  const value = await store.get(bindingStoreKey(workerId));
  if (value === undefined) {
    return undefined;
  }
  return azureBindingSchema.parse(value);
}

async function putBlob(
  options: AzureVmProviderOptions,
  url: string,
  body: unknown,
): Promise<void> {
  const response = await azureRequest(
    options,
    url,
    {
      method: "PUT",
      body: JSON.stringify(body),
    },
    false,
  );
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Azure blob write failed (${response.status})`);
  }
}

async function azureRequest(
  options: AzureVmProviderOptions,
  url: string,
  init: {
    readonly method: string;
    readonly body?: string;
  },
  includeToken = true,
): Promise<Response> {
  const headers = new Headers();
  if (init.body !== undefined) {
    headers.set("Content-Type", "application/json");
  }
  if (includeToken) {
    const token = await options.getToken();
    if (token !== undefined && token.length > 0) {
      headers.set("Authorization", `Bearer ${token}`);
    }
  }
  return init.body === undefined
    ? options.fetch(url, { method: init.method, headers })
    : options.fetch(url, {
        method: init.method,
        headers,
        body: init.body,
      });
}
