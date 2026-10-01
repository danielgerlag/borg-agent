import {
  graphDefinitionDeleted,
  graphDefinitionSaved,
  graphInstanceCompleted,
  graphInstanceFailed,
  graphInstanceStarted,
  graphInstanceUpdated,
  graphsCancelInstance,
  graphsLaunch,
  graphsListDefinitions,
  graphsListInstances,
  graphValueMapSchema,
  type GraphDefinition,
  type GraphInstance,
} from "./contract";
import type { Disposable, PluginUiContext } from "@borg/plugin-sdk";
import { Button, EmptyState, Panel } from "@borg/ui-kit";
import {
  CircleAlert,
  LoaderCircle,
  Play,
  Square,
  Workflow,
} from "lucide-solid";
import {
  For,
  Show,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  type Component,
} from "solid-js";
import LaunchDialog from "./launch-dialog";
import {
  defaultValueFromSchema,
  schemaHasProperties,
} from "./schema";

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function statusLabel(status: GraphInstance["status"]): string {
  switch (status) {
    case "running":
      return "Running";
    case "waiting":
      return "Waiting for input";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
  }
}

function isLive(status: GraphInstance["status"]): boolean {
  return status === "running" || status === "waiting";
}

function formatRunTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function createGraphOperations(
  context: PluginUiContext<Component>,
  options: {
    readonly onBuild: () => void;
    readonly onEdit: (graphId: string) => void;
  },
): Component {
  return () => {
    const [definitions, setDefinitions] = createSignal<
      readonly GraphDefinition[]
    >([]);
    const [instances, setInstances] = createSignal<readonly GraphInstance[]>(
      [],
    );
    const [loading, setLoading] = createSignal(true);
    const [error, setError] = createSignal<string>();
    const [launchingId, setLaunchingId] = createSignal<string>();
    const [cancellingId, setCancellingId] = createSignal<string>();
    const [launchTarget, setLaunchTarget] = createSignal<GraphDefinition>();
    const [launchInput, setLaunchInput] = createSignal<
      Record<string, unknown>
    >({});
    const subscriptions: Disposable[] = [];
    let active = true;

    const live = createMemo(() =>
      instances().filter((instance) => isLive(instance.status)),
    );
    const recent = createMemo(() =>
      instances().filter((instance) => !isLive(instance.status)).slice(0, 12),
    );

    const refresh = async (): Promise<void> => {
      try {
        const [definitionResult, instanceResult] = await Promise.all([
          context.bus.invoke(graphsListDefinitions, {}),
          context.bus.invoke(graphsListInstances, {}),
        ]);
        if (!active) {
          return;
        }
        setDefinitions(definitionResult.definitions);
        setInstances(
          [...instanceResult.instances].sort((left, right) =>
            right.updatedAt.localeCompare(left.updatedAt),
          ),
        );
        setError(undefined);
      } catch (failure) {
        if (active) {
          setError(describeError(failure));
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    };

    const launchSaved = async (
      definition: GraphDefinition,
      input: Record<string, unknown>,
    ): Promise<void> => {
      setLaunchingId(definition.id);
      setError(undefined);
      try {
        await context.bus.invoke(graphsLaunch, {
          graphId: definition.id,
          input: graphValueMapSchema.parse(input),
          trigger: "manual",
        });
        setLaunchTarget(undefined);
        await refresh();
      } catch (failure) {
        if (active) {
          setError(describeError(failure));
        }
      } finally {
        if (active) {
          setLaunchingId(undefined);
        }
      }
    };

    const launch = async (definition: GraphDefinition): Promise<void> => {
      if (schemaHasProperties(definition.inputSchema)) {
        setLaunchInput(defaultValueFromSchema(definition.inputSchema));
        setLaunchTarget(definition);
        return;
      }
      await launchSaved(definition, {});
    };

    const cancel = async (instance: GraphInstance): Promise<void> => {
      setCancellingId(instance.id);
      setError(undefined);
      try {
        await context.bus.invoke(graphsCancelInstance, {
          instanceId: instance.id,
        });
        await refresh();
      } catch (failure) {
        if (active) {
          setError(describeError(failure));
        }
      } finally {
        if (active) {
          setCancellingId(undefined);
        }
      }
    };

    onMount(() => {
      for (const event of [
        graphDefinitionSaved,
        graphDefinitionDeleted,
        graphInstanceStarted,
        graphInstanceUpdated,
        graphInstanceCompleted,
        graphInstanceFailed,
      ] as const) {
        void context.bus.on(event, () => refresh()).then((disposable) => {
          if (active) {
            subscriptions.push(disposable);
          } else {
            void disposable.dispose();
          }
        });
      }
      void refresh();
    });

    onCleanup(() => {
      active = false;
      for (const subscription of subscriptions) {
        void subscription.dispose();
      }
    });

    return (
      <section
        class="h-full min-h-0 overflow-y-auto bg-[var(--panel)] p-5"
        data-testid="graph-operations"
      >
        <div class="mx-auto grid max-w-5xl gap-6">
          <header>
            <p class="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--accent)]">
              Graphs
            </p>
            <div class="mt-2 flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 class="text-2xl font-semibold">Running workflows</h2>
                <p class="mt-2 max-w-2xl text-sm leading-6 text-[var(--text-muted)]">
                  Launch saved graphs and watch live instances. Build a
                  definition when you need a new workflow or a change.
                </p>
              </div>
              <Button
                type="button"
                onClick={() => options.onBuild()}
                data-testid="graph-ops-build"
              >
                Build graph
              </Button>
            </div>
          </header>

          <Show when={error()}>
            {(message) => (
              <p
                class="flex items-center gap-2 text-sm text-[var(--danger)]"
                role="alert"
              >
                <CircleAlert aria-hidden="true" size={16} />
                {message()}
              </p>
            )}
          </Show>

          <div class="grid min-w-0 gap-6 xl:grid-cols-2">
            <Panel class="min-w-0">
              <div class="flex items-center justify-between gap-3">
                <h3 class="text-sm font-semibold">Catalog</h3>
                <Show when={loading()}>
                  <LoaderCircle
                    aria-label="Loading graphs"
                    class="animate-spin text-[var(--text-subtle)]"
                    size={16}
                  />
                </Show>
              </div>
              <ul class="mt-4 grid gap-2" data-testid="graph-ops-catalog">
                <For
                  each={definitions()}
                  fallback={
                    <EmptyState
                      title="No saved graphs"
                      description="Build a workflow, then launch it from this list."
                      class="px-0 py-8"
                    />
                  }
                >
                  {(definition) => (
                    <li
                      class="grid gap-3 rounded-xl border border-[var(--border)] bg-[var(--background)] p-3"
                      data-testid={`graph-ops-item-${definition.id}`}
                    >
                      <div class="min-w-0">
                        <p class="truncate text-sm font-semibold">
                          {definition.name}
                        </p>
                        <p class="mt-1 truncate text-xs text-[var(--text-muted)]">
                          {definition.description ||
                            `${definition.nodes.length} steps · ${definition.mode}`}
                        </p>
                      </div>
                      <div class="flex flex-wrap gap-2">
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          onClick={() => options.onEdit(definition.id)}
                          data-testid={`graph-ops-edit-${definition.id}`}
                        >
                          Edit
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          disabled={launchingId() === definition.id}
                          onClick={() => void launch(definition)}
                          data-testid={`graph-ops-launch-${definition.id}`}
                        >
                          <Play aria-hidden="true" size={14} />
                          {launchingId() === definition.id
                            ? "Launching…"
                            : "Launch"}
                        </Button>
                      </div>
                    </li>
                  )}
                </For>
              </ul>
            </Panel>

            <Panel class="min-w-0">
              <div class="flex items-center gap-2">
                <Workflow
                  aria-hidden="true"
                  class="text-[var(--accent)]"
                  size={16}
                />
                <h3 class="text-sm font-semibold">Live</h3>
              </div>
              <ul class="mt-4 grid gap-2" data-testid="graph-ops-runs">
                <For
                  each={live()}
                  fallback={
                    <p class="text-xs text-[var(--text-subtle)]">
                      Nothing is running.
                    </p>
                  }
                >
                  {(instance) => (
                    <li
                      class="flex items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-3"
                      data-testid={`graph-ops-instance-${instance.id}`}
                    >
                      <div class="min-w-0 flex-1">
                        <p class="truncate text-sm font-semibold">
                          {instance.graphName}
                        </p>
                        <p class="mt-1 text-xs text-[var(--text-muted)]">
                          {statusLabel(instance.status)}
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        disabled={cancellingId() === instance.id}
                        onClick={() => void cancel(instance)}
                        data-testid={`graph-ops-cancel-${instance.id}`}
                      >
                        <Square aria-hidden="true" size={14} />
                        {cancellingId() === instance.id
                          ? "Stopping…"
                          : "Stop"}
                      </Button>
                    </li>
                  )}
                </For>
              </ul>

              <Show when={recent().length > 0}>
                <h3 class="mt-6 text-sm font-semibold">Recent</h3>
                <ul class="mt-3 grid gap-2">
                  <For each={recent()}>
                    {(instance) => (
                      <li class="grid gap-1 rounded-xl border border-[var(--border)] px-3 py-2.5 text-xs">
                        <div class="flex items-center justify-between gap-3">
                          <span class="min-w-0 truncate font-medium">
                            {instance.graphName}
                          </span>
                          <span class="shrink-0 text-[var(--text-muted)]">
                            {statusLabel(instance.status)}
                          </span>
                        </div>
                        <span class="text-[var(--text-subtle)]">
                          {formatRunTime(instance.updatedAt)}
                        </span>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            </Panel>
          </div>
        </div>

        <Show keyed when={launchTarget()}>
          {(definition) => (
            <LaunchDialog
              schema={definition.inputSchema}
              value={launchInput()}
              onChange={setLaunchInput}
              launching={launchingId() === definition.id}
              onCancel={() => setLaunchTarget(undefined)}
              onLaunch={() => void launchSaved(definition, launchInput())}
            />
          )}
        </Show>
      </section>
    );
  };
}
