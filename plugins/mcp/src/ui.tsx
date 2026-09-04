import {
  mcpListServers,
  mcpRefresh,
  type McpServerSnapshot,
  type Persona,
} from "@borg/contracts";
import { defineUiPlugin } from "@borg/plugin-sdk";
import { Button, EmptyState, Panel } from "@borg/ui-kit";
import { Plus, RefreshCw, Trash2 } from "lucide-solid";
import {
  For,
  Show,
  createMemo,
  createSignal,
  onMount,
  type Component,
} from "solid-js";
import {
  argumentsToText,
  catalogLabel,
  changeDraftTransport,
  describeDraftError,
  draftFromConfig,
  emptyStdioDraft,
  parseDraftsForSave,
  refsToText,
  replaceDraft,
  textToArguments,
  textToRefs,
  type McpServerDraft,
} from "./settings-draft";

export default defineUiPlugin<Component>({
  id: "borg.mcp",
  activate(context) {
    const McpSettings: Component = () => {
      const [personas, setPersonas] = createSignal<readonly Persona[]>([]);
      const [personaId, setPersonaId] = createSignal("");
      const [drafts, setDrafts] = createSignal<McpServerDraft[]>([]);
      const [status, setStatus] = createSignal<readonly McpServerSnapshot[]>([]);
      const [error, setError] = createSignal<string>();
      const [busy, setBusy] = createSignal(false);

      const selected = createMemo(
        () => personas().find((persona) => persona.id === personaId()),
      );

      const loadStatus = async (id: string): Promise<void> => {
        const listed = await context.bus.invoke(mcpListServers, { personaId: id });
        setStatus(listed.servers);
      };

      const load = async (): Promise<void> => {
        const listed = await context.personas.list();
        setPersonas(listed);
        const current =
          listed.find((persona) => persona.id === personaId()) ??
          (await context.personas.getDefault());
        setPersonaId(current.id);
        setDrafts((current.mcpServers ?? []).map(draftFromConfig));
        await loadStatus(current.id);
      };

      onMount(() => {
        void load().catch((failure: unknown) => setError(describeDraftError(failure)));
      });

      const persist = async (next: McpServerDraft[]): Promise<void> => {
        const persona = selected();
        if (!persona) {
          return;
        }
        setBusy(true);
        try {
          const parsed = parseDraftsForSave(next);
          await context.personas.update(persona.id, { mcpServers: parsed });
          setDrafts(parsed.map(draftFromConfig));
          await loadStatus(persona.id);
          setError(undefined);
        } catch (failure) {
          setError(describeDraftError(failure));
        } finally {
          setBusy(false);
        }
      };

      const updateDraft = (index: number, next: McpServerDraft): void => {
        setDrafts((current) => replaceDraft(current, index, next));
      };

      return (
        <Panel data-testid="mcp-settings-page">
          <div class="flex items-start justify-between gap-3">
            <div>
              <h3 class="text-xl font-semibold">MCP servers</h3>
              <p class="mt-1 text-sm text-[var(--text-muted)]">
                Persona-owned stdio, SSE, and Streamable HTTP servers.
              </p>
            </div>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy()}
              data-testid="mcp-refresh"
              onClick={() => {
                void (async () => {
                  setBusy(true);
                  try {
                    const refreshed = await context.bus.invoke(mcpRefresh, {
                      personaId: personaId(),
                    });
                    setStatus(refreshed.servers);
                    setError(undefined);
                  } catch (failure) {
                    setError(describeDraftError(failure));
                  } finally {
                    setBusy(false);
                  }
                })();
              }}
            >
              <RefreshCw aria-hidden="true" size={14} />
              Refresh
            </Button>
          </div>

          <label class="mt-5 block text-sm text-[var(--text-muted)]" for="mcp-persona">
            Persona
          </label>
          <select
            id="mcp-persona"
            class="mt-1 w-full rounded-xl border border-[var(--border)] bg-[var(--panel-muted)] px-3 py-2 text-sm"
            data-testid="mcp-persona-select"
            value={personaId()}
            onChange={(event) => {
              const next = event.currentTarget.value;
              setPersonaId(next);
              const persona = personas().find((entry) => entry.id === next);
              setDrafts((persona?.mcpServers ?? []).map(draftFromConfig));
              void loadStatus(next).catch((failure: unknown) =>
                setError(describeDraftError(failure)),
              );
            }}
          >
            <For each={personas()}>
              {(persona) => <option value={persona.id}>{persona.name}</option>}
            </For>
          </select>

          <Show
            when={drafts().length > 0}
            fallback={
              <EmptyState
                class="mt-6"
                title="No MCP servers"
                description="Add a server to expose its tools to this persona."
              />
            }
          >
            <ul class="mt-6 grid gap-4" data-testid="mcp-server-list">
              <For each={drafts()}>
                {(server, index) => {
                  const snapshot = () =>
                    status().find((entry) => entry.id === server.id);
                  return (
                    <li
                      class="rounded-xl border border-[var(--border)] bg-[var(--panel-muted)] p-4"
                      data-testid={`mcp-server-row-${server.id}`}
                    >
                      <div class="flex items-center justify-between gap-3">
                        <input
                          class="w-full rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-sm"
                          data-testid="mcp-server-id"
                          value={server.id}
                          onInput={(event) =>
                            updateDraft(index(), {
                              ...server,
                              id: event.currentTarget.value,
                            })
                          }
                        />
                        <label class="flex items-center gap-2 text-xs">
                          <input
                            type="checkbox"
                            data-testid="mcp-server-enabled"
                            checked={server.enabled}
                            onChange={(event) =>
                              updateDraft(index(), {
                                ...server,
                                enabled: event.currentTarget.checked,
                              })
                            }
                          />
                          Enabled
                        </label>
                      </div>
                      <div class="mt-3 grid gap-3 sm:grid-cols-2">
                        <label class="text-xs text-[var(--text-muted)]">
                          Transport
                          <select
                            class="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-sm"
                            data-testid="mcp-server-transport"
                            value={server.transport}
                            onChange={(event) => {
                              const transport = event.currentTarget.value as
                                | "stdio"
                                | "sse"
                                | "streamable-http";
                              updateDraft(
                                index(),
                                changeDraftTransport(server, transport),
                              );
                            }}
                          >
                            <option value="stdio">stdio</option>
                            <option value="sse">sse</option>
                            <option value="streamable-http">streamable-http</option>
                          </select>
                        </label>
                        <label class="text-xs text-[var(--text-muted)]">
                          Reconnect
                          <input
                            class="ml-2 align-middle"
                            type="checkbox"
                            data-testid="mcp-server-reconnect"
                            checked={server.reconnect}
                            onChange={(event) =>
                              updateDraft(index(), {
                                ...server,
                                reconnect: event.currentTarget.checked,
                              })
                            }
                          />
                        </label>
                      </div>
                      <Show when={server.transport === "stdio"}>
                        <label class="mt-3 block text-xs text-[var(--text-muted)]">
                          Command
                          <input
                            class="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-sm"
                            data-testid="mcp-server-command"
                            value={server.command ?? ""}
                            onInput={(event) =>
                              updateDraft(index(), {
                                ...server,
                                command: event.currentTarget.value,
                              })
                            }
                          />
                        </label>
                        <label class="mt-3 block text-xs text-[var(--text-muted)]">
                          Arguments
                          <textarea
                            class="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-sm"
                            data-testid="mcp-server-arguments"
                            rows={3}
                            value={argumentsToText(server.arguments)}
                            onInput={(event) =>
                              updateDraft(index(), {
                                ...server,
                                arguments: textToArguments(event.currentTarget.value),
                              })
                            }
                          />
                        </label>
                        <label class="mt-3 block text-xs text-[var(--text-muted)]">
                          Environment secret refs
                          <textarea
                            class="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-sm"
                            data-testid="mcp-env-secret-refs"
                            rows={2}
                            value={
                              server.environmentSecretRefsText ??
                              refsToText(server.environmentSecretRefs)
                            }
                            onInput={(event) =>
                              updateDraft(index(), {
                                ...server,
                                environmentSecretRefsText:
                                  event.currentTarget.value,
                                environmentSecretRefs: textToRefs(
                                  event.currentTarget.value,
                                ),
                              })
                            }
                          />
                        </label>
                      </Show>
                      <Show when={server.transport !== "stdio"}>
                        <label class="mt-3 block text-xs text-[var(--text-muted)]">
                          URL
                          <input
                            class="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-sm"
                            data-testid="mcp-server-url"
                            value={server.url ?? ""}
                            onInput={(event) =>
                              updateDraft(index(), {
                                ...server,
                                url: event.currentTarget.value,
                              })
                            }
                          />
                        </label>
                        <label class="mt-3 block text-xs text-[var(--text-muted)]">
                          Header secret refs
                          <textarea
                            class="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-sm"
                            data-testid="mcp-header-secret-refs"
                            rows={2}
                            value={
                              server.headerSecretRefsText ??
                              refsToText(server.headerSecretRefs)
                            }
                            onInput={(event) =>
                              updateDraft(index(), {
                                ...server,
                                headerSecretRefsText:
                                  event.currentTarget.value,
                                headerSecretRefs: textToRefs(
                                  event.currentTarget.value,
                                ),
                              })
                            }
                          />
                        </label>
                      </Show>
                      <p class="mt-3 text-xs" data-testid="mcp-server-status">
                        {snapshot()?.status ?? "idle"}
                      </p>
                      <p class="text-xs text-[var(--text-muted)]" data-testid="mcp-tool-count">
                        {snapshot()?.toolCount ?? 0} tools
                      </p>
                      <p class="text-xs" data-testid="mcp-catalog">
                        {catalogLabel(snapshot()?.toolIds)}
                      </p>
                      <div class="mt-3 flex gap-2">
                        <Button
                          type="button"
                          size="sm"
                          disabled={busy()}
                          data-testid="mcp-save-server"
                          onClick={() => void persist(drafts())}
                        >
                          Save
                        </Button>
                        <Button
                          type="button"
                          variant="danger"
                          size="sm"
                          disabled={busy()}
                          data-testid="mcp-remove-server"
                          onClick={() => {
                            const next = drafts().filter(
                              (_, entryIndex) => entryIndex !== index(),
                            );
                            setDrafts(next);
                            void persist(next);
                          }}
                        >
                          <Trash2 aria-hidden="true" size={14} />
                          Remove
                        </Button>
                      </div>
                    </li>
                  );
                }}
              </For>
            </ul>
          </Show>

          <Button
            type="button"
            class="mt-4"
            variant="secondary"
            disabled={busy()}
            data-testid="mcp-add-server"
            onClick={() => {
              const next = [...drafts(), emptyStdioDraft(`server-${drafts().length + 1}`)];
              setDrafts(next);
            }}
          >
            <Plus aria-hidden="true" size={14} />
            Add server
          </Button>

          <Show when={error()}>
            <p class="mt-3 text-sm text-[var(--danger)]" data-testid="mcp-settings-error">
              {error()}
            </p>
          </Show>
        </Panel>
      );
    };

    context.ui.registerSettingsPage({
      id: "borg.mcp.servers",
      label: "MCP",
      order: 40,
      component: McpSettings,
    });
  },
});
