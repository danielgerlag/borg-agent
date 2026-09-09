import {
  mcpListServers,
  mcpRefresh,
  type McpServerSnapshot,
  type Persona,
} from "@borg/contracts";
import { defineUiPlugin } from "@borg/plugin-sdk";
import { Button, Checkbox, EmptyState, Panel, Select, TextField } from "@borg/ui-kit";
import { Plus, RefreshCw, Trash2 } from "lucide-solid";
import {
  Index,
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

          <Select
            class="mt-5"
            label="Persona"
            data-testid="mcp-persona-select"
            value={personaId()}
            onChange={(next) => {
              setPersonaId(next);
              const persona = personas().find((entry) => entry.id === next);
              setDrafts((persona?.mcpServers ?? []).map(draftFromConfig));
              void loadStatus(next).catch((failure: unknown) =>
                setError(describeDraftError(failure)),
              );
            }}
            options={personas().map((persona) => ({
              value: persona.id,
              label: persona.name,
            }))}
          />

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
              <Index each={drafts()}>
                {(server, index) => {
                  const snapshot = () =>
                    status().find((entry) => entry.id === server().id);
                  return (
                    <li
                      class="rounded-xl border border-[var(--border)] bg-[var(--panel-muted)] p-4"
                      data-testid={`mcp-server-row-${server().id}`}
                    >
                      <div class="flex items-center justify-between gap-3">
                        <TextField
                          class="min-w-0 flex-1"
                          data-testid="mcp-server-id"
                          value={server().id}
                          onChange={(value) =>
                            updateDraft(index, {
                              ...server(),
                              id: value,
                            })
                          }
                        />
                        <Checkbox
                          data-testid="mcp-server-enabled"
                          checked={server().enabled}
                          onChange={(enabled) =>
                            updateDraft(index, {
                              ...server(),
                              enabled,
                            })
                          }
                          label="Enabled"
                        />
                      </div>
                      <div class="mt-3 grid gap-3 sm:grid-cols-2">
                        <Select
                          label="Transport"
                          data-testid="mcp-server-transport"
                          value={server().transport}
                          onChange={(value) => {
                            if (
                              value !== "stdio" &&
                              value !== "sse" &&
                              value !== "streamable-http"
                            ) {
                              return;
                            }
                            updateDraft(
                              index,
                              changeDraftTransport(server(), value),
                            );
                          }}
                          options={[
                            { value: "stdio", label: "stdio" },
                            { value: "sse", label: "sse" },
                            {
                              value: "streamable-http",
                              label: "streamable-http",
                            },
                          ]}
                        />
                        <Checkbox
                          data-testid="mcp-server-reconnect"
                          checked={server().reconnect}
                          onChange={(reconnect) =>
                            updateDraft(index, {
                              ...server(),
                              reconnect,
                            })
                          }
                          label="Reconnect"
                        />
                      </div>
                      <Show when={server().transport === "stdio"}>
                        <TextField
                          class="mt-3"
                          label="Command"
                          data-testid="mcp-server-command"
                          value={server().command ?? ""}
                          onChange={(value) =>
                            updateDraft(index, {
                              ...server(),
                              command: value,
                            })
                          }
                        />
                        <TextField
                          class="mt-3"
                          label="Arguments"
                          data-testid="mcp-server-arguments"
                          rows={3}
                          value={argumentsToText(server().arguments)}
                          onChange={(value) =>
                            updateDraft(index, {
                              ...server(),
                              arguments: textToArguments(value),
                            })
                          }
                        />
                        <TextField
                          class="mt-3"
                          label="Environment secret refs"
                          data-testid="mcp-env-secret-refs"
                          rows={2}
                          value={
                            server().environmentSecretRefsText ??
                            refsToText(server().environmentSecretRefs)
                          }
                          onChange={(value) =>
                            updateDraft(index, {
                              ...server(),
                              environmentSecretRefsText: value,
                              environmentSecretRefs: textToRefs(value),
                            })
                          }
                        />
                      </Show>
                      <Show when={server().transport !== "stdio"}>
                        <TextField
                          class="mt-3"
                          label="URL"
                          data-testid="mcp-server-url"
                          value={server().url ?? ""}
                          onChange={(value) =>
                            updateDraft(index, {
                              ...server(),
                              url: value,
                            })
                          }
                        />
                        <TextField
                          class="mt-3"
                          label="Header secret refs"
                          data-testid="mcp-header-secret-refs"
                          rows={2}
                          value={
                            server().headerSecretRefsText ??
                            refsToText(server().headerSecretRefs)
                          }
                          onChange={(value) =>
                            updateDraft(index, {
                              ...server(),
                              headerSecretRefsText: value,
                              headerSecretRefs: textToRefs(value),
                            })
                          }
                        />
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
                              (_, entryIndex) => entryIndex !== index,
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
              </Index>
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
