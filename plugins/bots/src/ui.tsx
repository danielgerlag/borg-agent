import {
  botCompleted,
  botFailed,
  botStarted,
  botStopped,
  botUpdated,
  botsCreate,
  botsDelete,
  botsList,
  botsListLogs,
  botsStart,
  botsStop,
  type Bot,
  type BotLog,
  type Persona,
} from "@borg/contracts";
import { defineUiPlugin, type Disposable } from "@borg/plugin-sdk";
import { Button, EmptyState, Panel } from "@borg/ui-kit";
import { Activity, Play, Plus, Square, Trash2 } from "lucide-solid";
import {
  For,
  Show,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  type Component,
} from "solid-js";

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function statusCopy(status: Bot["status"]): string {
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
    default:
      return "Stopped";
  }
}

export default defineUiPlugin({
  id: "borg.bots",
  async activate(context) {
    const BotsWorkspace: Component = () => {
      const [bots, setBots] = createSignal<readonly Bot[]>([]);
      const [logs, setLogs] = createSignal<readonly BotLog[]>([]);
      const [personas, setPersonas] = createSignal<readonly Persona[]>([]);
      const [selectedId, setSelectedId] = createSignal<string>();
      const [name, setName] = createSignal("");
      const [personaId, setPersonaId] = createSignal("");
      const [launchPrompt, setLaunchPrompt] = createSignal("");
      const [error, setError] = createSignal<string>();
      const [busy, setBusy] = createSignal(false);
      const subscriptions: Disposable[] = [];
      let active = true;

      const selected = createMemo(
        () => bots().find(({ id }) => id === selectedId()),
      );
      const live = createMemo(() => {
        const bot = selected();
        return bot?.status === "running" || bot?.status === "waiting";
      });

      const track = async (subscription: Promise<Disposable>): Promise<void> => {
        const disposable = await subscription;
        if (active) {
          subscriptions.push(disposable);
        } else {
          await disposable.dispose();
        }
      };

      const refreshLogs = async (botId: string): Promise<void> => {
        const result = await context.bus.invoke(botsListLogs, { botId });
        if (active && selectedId() === botId) {
          setLogs(result.logs);
        }
      };

      const refresh = async (): Promise<void> => {
        try {
          const result = await context.bus.invoke(botsList, {});
          if (!active) {
            return;
          }
          setBots(result.bots);
          const current =
            result.bots.find(({ id }) => id === selectedId()) ?? result.bots[0];
          setSelectedId(current?.id);
          if (current) {
            await refreshLogs(current.id);
          } else {
            setLogs([]);
          }
          setError(undefined);
        } catch (failure) {
          if (active) {
            setError(describeError(failure));
          }
        }
      };

      const createBot = async (): Promise<void> => {
        const prompt = launchPrompt().trim();
        if (!prompt) {
          setError("A launch prompt is required.");
          return;
        }
        setBusy(true);
        try {
          const result = await context.bus.invoke(botsCreate, {
            launchPrompt: prompt,
            ...(name().trim() ? { name: name().trim() } : {}),
            ...(personaId() ? { personaId: personaId() } : {}),
          });
          setName("");
          setLaunchPrompt("");
          setSelectedId(result.bot.id);
          await refresh();
        } catch (failure) {
          setError(describeError(failure));
        } finally {
          setBusy(false);
        }
      };

      const runSelected = async (
        action: "start" | "stop" | "delete",
      ): Promise<void> => {
        const bot = selected();
        if (!bot) {
          return;
        }
        setBusy(true);
        try {
          if (action === "start") {
            await context.bus.invoke(botsStart, { botId: bot.id });
          } else if (action === "stop") {
            await context.bus.invoke(botsStop, { botId: bot.id });
          } else {
            await context.bus.invoke(botsDelete, { botId: bot.id });
            setSelectedId(undefined);
          }
          await refresh();
        } catch (failure) {
          setError(describeError(failure));
        } finally {
          setBusy(false);
        }
      };

      onMount(() => {
        void context.personas.list().then((listed) => {
          if (active) {
            setPersonas(listed.filter(({ archived }) => !archived));
            setPersonaId((current) => current || listed[0]?.id || "");
          }
        });
        for (const event of [
          botUpdated,
          botStarted,
          botStopped,
          botCompleted,
          botFailed,
        ] as const) {
          void track(context.bus.on(event, () => refresh()));
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
        <section class="flex h-full min-h-0" data-testid="bots-workspace">
          <aside class="flex w-72 shrink-0 flex-col border-r border-[var(--border)] bg-[var(--sidebar)]">
            <div class="flex items-center justify-between px-4 py-3">
              <h2 class="text-sm font-semibold">Bots</h2>
              <span class="text-xs text-[var(--text-muted)]" data-testid="bot-count">
                {bots().length}
              </span>
            </div>
            <ul class="min-h-0 flex-1 overflow-auto px-2 pb-3" data-testid="bot-list">
              <Show
                when={bots().length > 0}
                fallback={
                  <li class="px-2 py-6 text-xs text-[var(--text-muted)]">
                    No bots yet
                  </li>
                }
              >
                <For each={bots()}>
                  {(bot) => (
                    <li>
                      <button
                        type="button"
                        class="mb-1 w-full rounded-lg px-3 py-2 text-left text-sm"
                        classList={{
                          "bg-[var(--accent)]/12 text-[var(--accent)]":
                            selected()?.id === bot.id,
                          "text-[var(--text)] hover:bg-[var(--panel-muted)]":
                            selected()?.id !== bot.id,
                        }}
                        data-testid={`bot-list-item-${bot.id}`}
                        onClick={() => {
                          setSelectedId(bot.id);
                          void refreshLogs(bot.id);
                        }}
                      >
                        <span class="block truncate font-medium">{bot.name}</span>
                        <span class="block text-xs text-[var(--text-muted)]">
                          {statusCopy(bot.status)}
                        </span>
                      </button>
                    </li>
                  )}
                </For>
              </Show>
            </ul>
          </aside>
          <div class="flex min-w-0 flex-1 flex-col gap-4 overflow-auto p-5">
            <Panel>
              <h3 class="text-sm font-semibold">New bot</h3>
              <div class="mt-3 grid gap-3">
                <label class="grid gap-1 text-xs font-medium text-[var(--text-muted)]">
                  Name
                  <input
                    class="rounded-lg border border-[var(--border)] bg-[var(--panel-muted)] px-3 py-2 text-sm text-[var(--text)]"
                    data-testid="bot-name"
                    value={name()}
                    onInput={(event) => setName(event.currentTarget.value)}
                  />
                </label>
                <label class="grid gap-1 text-xs font-medium text-[var(--text-muted)]">
                  Persona
                  <select
                    class="rounded-lg border border-[var(--border)] bg-[var(--panel-muted)] px-3 py-2 text-sm text-[var(--text)]"
                    data-testid="bot-persona"
                    value={personaId()}
                    onChange={(event) => setPersonaId(event.currentTarget.value)}
                  >
                    <For each={personas()}>
                      {(persona) => (
                        <option value={persona.id}>{persona.name}</option>
                      )}
                    </For>
                  </select>
                </label>
                <label class="grid gap-1 text-xs font-medium text-[var(--text-muted)]">
                  Launch prompt
                  <textarea
                    class="min-h-20 rounded-lg border border-[var(--border)] bg-[var(--panel-muted)] px-3 py-2 text-sm text-[var(--text)]"
                    data-testid="bot-launch-prompt"
                    value={launchPrompt()}
                    onInput={(event) =>
                      setLaunchPrompt(event.currentTarget.value)
                    }
                  />
                </label>
                <Button
                  type="button"
                  data-testid="bot-create"
                  disabled={busy()}
                  onClick={() => void createBot()}
                >
                  <Plus aria-hidden="true" size={14} />
                  Create bot
                </Button>
              </div>
            </Panel>
            <Show
              when={selected()}
              fallback={
                <EmptyState
                  title="Create a background bot"
                  description="Give it a persona and a launch prompt. It keeps working after you hide Borg."
                />
              }
            >
              {(bot) => (
                <Panel data-testid="bot-detail">
                  <div class="flex items-start justify-between gap-3">
                    <div>
                      <h3 class="text-sm font-semibold" data-testid="bot-detail-name">
                        {bot().name}
                      </h3>
                      <p
                        class="mt-1 text-xs text-[var(--text-muted)]"
                        data-testid="bot-status"
                      >
                        {statusCopy(bot().status)}
                        <Show when={bot().error}>
                          {(message) => ` · ${message()}`}
                        </Show>
                      </p>
                    </div>
                    <div class="flex gap-2">
                      <Show
                        when={live()}
                        fallback={
                          <Button
                            type="button"
                            size="sm"
                            data-testid="bot-start"
                            disabled={busy()}
                            onClick={() => void runSelected("start")}
                          >
                            <Play aria-hidden="true" size={14} />
                            Start
                          </Button>
                        }
                      >
                        <Button
                          type="button"
                          size="sm"
                          variant="secondary"
                          data-testid="bot-stop"
                          disabled={busy()}
                          onClick={() => void runSelected("stop")}
                        >
                          <Square aria-hidden="true" size={14} />
                          Stop
                        </Button>
                      </Show>
                      <Button
                        type="button"
                        size="sm"
                        variant="danger"
                        data-testid="bot-delete"
                        disabled={busy()}
                        onClick={() => void runSelected("delete")}
                      >
                        <Trash2 aria-hidden="true" size={14} />
                        Delete
                      </Button>
                    </div>
                  </div>
                  <ol class="mt-4 grid gap-2" data-testid="bot-logs">
                    <For
                      each={logs()}
                      fallback={
                        <li class="text-xs text-[var(--text-muted)]">
                          No log lines yet.
                        </li>
                      }
                    >
                      {(entry) => (
                        <li class="rounded-lg bg-[var(--panel-muted)] px-3 py-2 text-xs">
                          <span class="text-[var(--text-muted)]">{entry.at}</span>
                          <p class="mt-1 text-[var(--text)]">{entry.message}</p>
                        </li>
                      )}
                    </For>
                  </ol>
                  <Show when={error()}>
                    {(message) => (
                      <p class="mt-3 text-xs text-red-400" data-testid="bot-error">
                        {message()}
                      </p>
                    )}
                  </Show>
                </Panel>
              )}
            </Show>
          </div>
        </section>
      );
    };

    const RunningBots: Component = () => {
      const [items, setItems] = createSignal<readonly Bot[]>([]);
      const subscriptions: Disposable[] = [];
      let active = true;

      const refresh = async (): Promise<void> => {
        const result = await context.bus.invoke(botsList, {});
        if (active) {
          setItems(
            result.bots.filter(
              ({ status }) => status === "running" || status === "waiting",
            ),
          );
        }
      };

      onMount(() => {
        for (const event of [
          botUpdated,
          botStarted,
          botStopped,
          botCompleted,
          botFailed,
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
        <Panel data-testid="flightdeck-running-bots">
          <div class="flex items-center gap-3">
            <div class="rounded-xl bg-[var(--accent)]/10 p-2 text-[var(--accent)]">
              <Activity aria-hidden="true" size={19} />
            </div>
            <div>
              <p class="text-sm font-semibold">Running bots</p>
              <p class="text-xs text-[var(--text-muted)]">
                <span data-testid="flightdeck-bot-count">{items().length}</span>{" "}
                running or waiting
              </p>
            </div>
          </div>
          <ul class="mt-3 grid gap-2">
            <For each={items()}>
              {(bot) => (
                <li class="text-xs" data-testid={`flightdeck-bot-${bot.id}`}>
                  {bot.name}
                </li>
              )}
            </For>
          </ul>
        </Panel>
      );
    };

    const workspace = context.ui.registerWorkspaceView({
      id: "borg.bots.manager",
      label: "Bots",
      order: 15,
      placement: "primary",
      component: BotsWorkspace,
    });
    const widget = context.ui.registerFlightDeckWidget({
      id: "borg.bots.running",
      label: "Running bots",
      order: 20,
      placement: "primary",
      component: RunningBots,
    });

    return {
      dispose: async () => {
        await widget.dispose();
        await workspace.dispose();
      },
    };
  },
});
