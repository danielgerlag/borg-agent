import {
  remoteGetRun,
  remoteListWorkers,
  remoteProvision,
  remoteSubmitRun,
  type RemoteRunStatusDocument,
  type RemoteWorker,
} from "@borg/contracts";
import { defineUiPlugin } from "@borg/plugin-sdk";
import { Button, Dialog, Panel, Select, TextField } from "@borg/ui-kit";
import { Server } from "lucide-solid";
import {
  For,
  Show,
  createSignal,
  onCleanup,
  onMount,
  type Component,
} from "solid-js";

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function scriptedSpec() {
  return {
    version: 1 as const,
    runId: crypto.randomUUID(),
    prompt: "echo hello",
    unattended: true as const,
    persona: {
      id: "user/detached",
      name: "Detached",
      instructions: "Finish the task.",
      preferredModels: ["borg.runtime.scripted:scripted"],
      allowedTools: ["tools.echo"],
      loopStrategy: "react" as const,
    },
    provider: {
      kind: "scripted" as const,
      replies: [
        {
          toolCalls: [
            { id: "call-1", name: "tools.echo", input: { text: "hello" } },
          ],
        },
        { content: "done" },
      ],
    },
  };
}

export default defineUiPlugin<Component>({
  id: "borg.remote",
  activate(context) {
    const RemoteSettings: Component = () => {
      const [workers, setWorkers] = createSignal<readonly RemoteWorker[]>([]);
      const [selectedId, setSelectedId] = createSignal("");
      const [run, setRun] = createSignal<RemoteRunStatusDocument | undefined>();
      const [busy, setBusy] = createSignal(false);
      const [error, setError] = createSignal("");
      const [azureOpen, setAzureOpen] = createSignal(false);
      const [k8sOpen, setK8sOpen] = createSignal(false);
      const [azureName, setAzureName] = createSignal("borg");
      const [subscriptionId, setSubscriptionId] = createSignal("");
      const [resourceGroup, setResourceGroup] = createSignal("");
      const [location, setLocation] = createSignal("eastus");
      const [vmSize, setVmSize] = createSignal("Standard_B2s");
      const [armToken, setArmToken] = createSignal("");
      const [k8sName, setK8sName] = createSignal("");
      const [k8sNamespace, setK8sNamespace] = createSignal("default");
      const [kubeconfig, setKubeconfig] = createSignal("");
      let pollTimer: number | undefined;

      const stopPolling = (): void => {
        if (pollTimer !== undefined) {
          window.clearTimeout(pollTimer);
          pollTimer = undefined;
        }
      };

      const refreshWorkers = async (): Promise<void> => {
        const listed = await context.bus.invoke(remoteListWorkers, {});
        setWorkers(listed.workers);
        const current = selectedId();
        if (
          current &&
          listed.workers.some((worker) => worker.id === current)
        ) {
          return;
        }
        const first = listed.workers[0];
        setSelectedId(first?.id ?? "");
      };

      onMount(() => {
        void refreshWorkers().catch((failure: unknown) =>
          setError(describeError(failure)),
        );
      });

      onCleanup(() => {
        stopPolling();
      });

      const runAction = async (work: () => Promise<void>): Promise<void> => {
        setBusy(true);
        setError("");
        try {
          await work();
        } catch (failure) {
          setError(describeError(failure));
        } finally {
          setBusy(false);
        }
      };

      const pollRun = async (
        workerId: string,
        runId: string,
      ): Promise<void> => {
        const snapshot = await context.bus.invoke(remoteGetRun, {
          workerId,
          runId,
        });
        setRun(snapshot);
        if (snapshot.status === "queued" || snapshot.status === "running") {
          pollTimer = window.setTimeout(() => {
            void pollRun(workerId, runId).catch((failure: unknown) =>
              setError(describeError(failure)),
            );
          }, 1_000);
        }
      };

      const provisionLocal = (): void => {
        void runAction(async () => {
          const result = await context.bus.invoke(remoteProvision, {
            runtime: "local",
            displayName: "local",
          });
          await refreshWorkers();
          setSelectedId(result.worker.id);
        });
      };

      const provisionAzure = (): void => {
        void runAction(async () => {
          const token = armToken().trim();
          if (token.length > 0) {
            await context.secrets.set("armToken", token);
          }
          const result = await context.bus.invoke(remoteProvision, {
            runtime: "azure-vm",
            displayName: azureName().trim() || "borg",
            azure: {
              subscriptionId: subscriptionId().trim(),
              resourceGroup: resourceGroup().trim(),
              location: location().trim() || "eastus",
              vmSize: vmSize().trim() || "Standard_B2s",
            },
          });
          setAzureOpen(false);
          setArmToken("");
          await refreshWorkers();
          setSelectedId(result.worker.id);
        });
      };

      const provisionKubernetes = (): void => {
        void runAction(async () => {
          const config = kubeconfig().trim();
          const displayName = k8sName().trim();
          const result = await context.bus.invoke(remoteProvision, {
            runtime: "kubernetes",
            ...(displayName.length > 0 ? { displayName } : {}),
            kubernetes: {
              kubeconfig: config,
              namespace: k8sNamespace().trim() || "default",
            },
          });
          setK8sOpen(false);
          await refreshWorkers();
          setSelectedId(result.worker.id);
        });
      };

      const submitRun = (): void => {
        const workerId = selectedId();
        if (!workerId) {
          setError("Select a worker first.");
          return;
        }
        void runAction(async () => {
          stopPolling();
          const spec = scriptedSpec();
          const submitted = await context.bus.invoke(remoteSubmitRun, {
            workerId,
            spec,
          });
          await pollRun(workerId, submitted.runId);
        });
      };

      const statusText = (): string => {
        const snapshot = run();
        if (!snapshot) {
          return "No run submitted.";
        }
        if (snapshot.output) {
          return `${snapshot.status}: ${snapshot.output}`;
        }
        if (snapshot.error) {
          return `${snapshot.status}: ${snapshot.error}`;
        }
        return snapshot.status;
      };

      return (
        <Panel data-testid="remote-settings">
          <div class="flex items-start gap-4">
            <div class="rounded-xl bg-[var(--accent)]/10 p-2.5 text-[var(--accent)]">
              <Server aria-hidden="true" size={20} />
            </div>
            <div class="min-w-0 flex-1">
              <h3 class="text-xl font-semibold">Remote workers</h3>
              <p class="mt-2 text-sm text-[var(--text-muted)]">
                Submit an unattended run and close the lid. A headless
                borg-runtime on a worker you own finishes the loop.
              </p>

              <ul class="mt-5 grid gap-2" data-testid="remote-worker-list">
                <For
                  each={workers()}
                  fallback={
                    <li class="text-sm text-[var(--text-muted)]">
                      No workers yet.
                    </li>
                  }
                >
                  {(worker) => (
                    <li>
                      <button
                        type="button"
                        class="w-full rounded-xl border border-[var(--border)] bg-[var(--panel-muted)] px-3 py-2 text-left text-sm hover:border-[var(--accent)]"
                        classList={{
                          "border-[var(--accent)]": selectedId() === worker.id,
                        }}
                        onClick={() => setSelectedId(worker.id)}
                      >
                        <span class="font-medium">{worker.displayName}</span>
                        <span class="ml-2 text-xs text-[var(--text-muted)]">
                          {worker.id} · {worker.status}
                        </span>
                      </button>
                    </li>
                  )}
                </For>
              </ul>

              <div class="mt-4 flex flex-wrap gap-2">
                <Button
                  type="button"
                  disabled={busy()}
                  onClick={provisionLocal}
                  data-testid="remote-provision-local"
                >
                  Local worker
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={busy()}
                  onClick={() => setAzureOpen(true)}
                  data-testid="remote-provision-azure"
                >
                  Azure VM
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={busy()}
                  onClick={() => setK8sOpen(true)}
                  data-testid="remote-provision-kubernetes"
                >
                  Kubernetes
                </Button>
              </div>

              <Select
                class="mt-4"
                label="Submit to"
                value={selectedId()}
                onChange={setSelectedId}
                options={workers().map((worker) => ({
                  value: worker.id,
                  label: `${worker.displayName} (${worker.id})`,
                }))}
                placeholder="Select a worker"
              />

              <div class="mt-4">
                <Button
                  type="button"
                  disabled={busy() || selectedId().length === 0}
                  onClick={submitRun}
                  data-testid="remote-submit-run"
                >
                  {busy() ? "Working…" : "Submit unattended run"}
                </Button>
              </div>

              <p
                class="mt-3 text-xs"
                classList={{
                  "text-[var(--danger)]": error().length > 0,
                  "text-[var(--text-muted)]": error().length === 0,
                }}
                data-testid="remote-run-status"
              >
                {error() || statusText()}
              </p>
            </div>
          </div>

          <Show when={azureOpen()}>
            <Dialog
              open
              onOpenChange={setAzureOpen}
              title="Provision Azure VM"
              description="Creates a compute VM through ARM. Status is written to blob storage so reconnect does not need SSH."
            >
              <TextField
                class="mt-3"
                label="Display name"
                value={azureName()}
                onChange={setAzureName}
              />
              <TextField
                class="mt-3"
                label="Subscription ID"
                value={subscriptionId()}
                onChange={setSubscriptionId}
              />
              <TextField
                class="mt-3"
                label="Resource group"
                value={resourceGroup()}
                onChange={setResourceGroup}
              />
              <TextField
                class="mt-3"
                label="Location"
                value={location()}
                onChange={setLocation}
              />
              <TextField
                class="mt-3"
                label="VM size"
                value={vmSize()}
                onChange={setVmSize}
              />
              <TextField
                class="mt-3"
                label="ARM token"
                type="password"
                value={armToken()}
                onChange={setArmToken}
                autocomplete="off"
              />
              <div class="mt-4 flex justify-end gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy()}
                  onClick={() => setAzureOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  disabled={busy()}
                  onClick={provisionAzure}
                >
                  Provision
                </Button>
              </div>
            </Dialog>
          </Show>

          <Show when={k8sOpen()}>
            <Dialog
              open
              onOpenChange={setK8sOpen}
              title="Attach Kubernetes cluster"
              description="Attach an existing cluster. Borg does not create AKS. Jobs run borg-runtime; no NodePort or Service."
            >
              <TextField
                class="mt-3"
                label="Display name"
                value={k8sName()}
                onChange={setK8sName}
              />
              <TextField
                class="mt-3"
                label="Namespace"
                value={k8sNamespace()}
                onChange={setK8sNamespace}
              />
              <TextField
                class="mt-3"
                label="Kubeconfig or API server URL"
                rows={6}
                value={kubeconfig()}
                onChange={setKubeconfig}
                spellcheck={false}
              />
              <div class="mt-4 flex justify-end gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy()}
                  onClick={() => setK8sOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  disabled={busy()}
                  onClick={provisionKubernetes}
                >
                  Attach
                </Button>
              </div>
            </Dialog>
          </Show>
        </Panel>
      );
    };

    return context.ui.registerSettingsPage({
      id: "borg.remote.settings",
      label: "Remote workers",
      order: 45,
      group: "agents",
      component: RemoteSettings,
    });
  },
});
