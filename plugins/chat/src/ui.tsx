import {
  chatCreateSession,
  chatDeleteSession,
  chatDocumentSchema,
  chatGetSession,
  chatListSessions,
  chatListWorkspace,
  chatMessageAppended,
  chatSendMessage,
  chatSessionDeleted,
  chatSessionUpdated,
  chatSpawnSubAgent,
  chatTurnCompleted,
  type ChatSession,
  type ModelDescriptor,
  type Persona,
  type WorkspaceFile,
} from "@borg/contracts";
import {
  defineUiPlugin,
  type Disposable,
  z,
} from "@borg/plugin-sdk";
import { Panel } from "@borg/ui-kit";
import {
  Bot,
  FileText,
  FolderOpen,
  MessageSquarePlus,
  Send,
  Trash2,
  UserRoundCog,
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
import { matchesModelPreference } from "./model-preference";

type ChatDocument = z.infer<typeof chatDocumentSchema>;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default defineUiPlugin<Component>({
  id: "borg.chat",
  activate(context) {
    const [personaReady, setPersonaReady] = createSignal(false);

    const ChatWorkspace: Component = () => {
      const [sessions, setSessions] = createSignal<readonly ChatSession[]>([]);
      const [document, setDocument] = createSignal<ChatDocument>();
      const [files, setFiles] = createSignal<readonly WorkspaceFile[]>([]);
      const [draft, setDraft] = createSignal("");
      const [subAgentTask, setSubAgentTask] = createSignal("");
      const [streaming, setStreaming] = createSignal("");
      const [sending, setSending] = createSignal(false);
      const [error, setError] = createSignal<string>();
      const disposables: Disposable[] = [];
      let loopSubscription: Disposable | undefined;
      let active = true;
      let selectionGeneration = 0;
      let loopGeneration = 0;
      let initialSession:
        | Promise<{ readonly sessionId: string }>
        | undefined;

      const refreshSessions = async (
        preferredSessionId?: string,
      ): Promise<void> => {
        const result = await context.bus.invoke(chatListSessions, {});
        if (!active) {
          return;
        }
        setSessions(result.sessions);
        const candidate =
          preferredSessionId ??
          document()?.session.id ??
          result.sessions[0]?.id;
        const selected = result.sessions.some(({ id }) => id === candidate)
          ? candidate
          : result.sessions[0]?.id;
        if (selected && (preferredSessionId || !document())) {
          await selectSession(selected);
        } else if (!selected) {
          const pending =
            initialSession ??
            context.bus.invoke(chatCreateSession, {}).then((created) => ({
              sessionId: created.sessionId,
            }));
          initialSession = pending;
          try {
            const created = await pending;
            if (active) {
              await refreshSessions(created.sessionId);
            }
          } finally {
            if (initialSession === pending) {
              initialSession = undefined;
            }
          }
        }
      };

      const subscribeRun = async (runId: string): Promise<void> => {
        const generation = ++loopGeneration;
        await loopSubscription?.dispose();
        loopSubscription = undefined;
        setStreaming("");
        const subscription = await context.loops.subscribe(runId, (event) => {
          if (!active) {
            return;
          }
          if (event.type === "model_start") {
            setStreaming("");
          }
          if (event.type === "model_token") {
            setStreaming((current) => `${current}${event.token}`);
          }
          if (event.type === "final" || event.type === "failed") {
            setStreaming("");
            void refreshSelected();
          }
        });
        if (
          !active ||
          generation !== loopGeneration ||
          document()?.session.activeRunId !== runId
        ) {
          subscription.dispose();
          return;
        }
        loopSubscription = subscription;
      };

      const refreshSelected = async (): Promise<void> => {
        const sessionId = document()?.session.id;
        const generation = selectionGeneration;
        if (!sessionId) {
          return;
        }
        const [next, workspace] = await Promise.all([
          context.bus.invoke(chatGetSession, { sessionId }),
          context.bus.invoke(chatListWorkspace, { sessionId }),
        ]);
        if (
          !active ||
          generation !== selectionGeneration ||
          document()?.session.id !== sessionId
        ) {
          return;
        }
        setDocument(next);
        setFiles(workspace.files);
        if (next.session.activeRunId) {
          await subscribeRun(next.session.activeRunId);
        }
      };

      const selectSession = async (sessionId: string): Promise<void> => {
        const generation = ++selectionGeneration;
        const [next, workspace] = await Promise.all([
          context.bus.invoke(chatGetSession, { sessionId }),
          context.bus.invoke(chatListWorkspace, { sessionId }),
        ]);
        if (!active || generation !== selectionGeneration) {
          return;
        }
        ++loopGeneration;
        await loopSubscription?.dispose();
        loopSubscription = undefined;
        setStreaming("");
        setDocument(next);
        setFiles(workspace.files);
        if (next.session.activeRunId) {
          await subscribeRun(next.session.activeRunId);
        }
      };

      const addEventSubscription = async (
        subscription: Promise<Disposable>,
      ): Promise<void> => {
        const disposable = await subscription;
        if (active) {
          disposables.push(disposable);
        } else {
          await disposable.dispose();
        }
      };

      onMount(() => {
        void addEventSubscription(
          context.bus.on(chatMessageAppended, ({ sessionId }) => {
            if (document()?.session.id === sessionId) {
              void refreshSelected();
            }
            void refreshSessions();
          }),
        );
        void addEventSubscription(
          context.bus.on(chatSessionUpdated, ({ session }) => {
            setSessions((current) => {
              const remaining = current.filter(({ id }) => id !== session.id);
              return [session, ...remaining].sort((left, right) =>
                right.updatedAt.localeCompare(left.updatedAt),
              );
            });
            if (document()?.session.id === session.id) {
              setDocument((current) =>
                current ? { ...current, session } : current,
              );
              if (session.activeRunId) {
                void subscribeRun(session.activeRunId);
              } else {
                setStreaming("");
              }
            }
          }),
        );
        void addEventSubscription(
          context.bus.on(chatSessionDeleted, ({ sessionId }) => {
            setSessions((current) =>
              current.filter(({ id }) => id !== sessionId),
            );
            if (document()?.session.id === sessionId) {
              setDocument(undefined);
              setFiles([]);
              void refreshSessions();
            }
          }),
        );
        void addEventSubscription(
          context.bus.on(chatTurnCompleted, ({ sessionId }) => {
            if (document()?.session.id === sessionId) {
              setStreaming("");
              void refreshSelected();
            }
            void refreshSessions();
          }),
        );
        void refreshSessions().catch((failure: unknown) =>
          setError(describeError(failure)),
        );
      });

      onCleanup(() => {
        active = false;
        selectionGeneration += 1;
        loopGeneration += 1;
        loopSubscription?.dispose();
        for (const disposable of disposables) {
          void disposable.dispose();
        }
      });

      const createSession = async (): Promise<void> => {
        setError(undefined);
        try {
          const result = await context.bus.invoke(chatCreateSession, {});
          await refreshSessions(result.sessionId);
        } catch (failure) {
          setError(describeError(failure));
        }
      };

      const deleteSession = async (): Promise<void> => {
        const sessionId = document()?.session.id;
        if (!sessionId) {
          return;
        }
        setError(undefined);
        try {
          await context.bus.invoke(chatDeleteSession, { sessionId });
          setDocument(undefined);
          setFiles([]);
          await refreshSessions();
        } catch (failure) {
          setError(describeError(failure));
        }
      };

      const send = async (): Promise<void> => {
        const sessionId = document()?.session.id;
        const text = draft().trim();
        if (!sessionId || !text || sending()) {
          return;
        }
        setSending(true);
        setError(undefined);
        setDraft("");
        try {
          const result = await context.bus.invoke(chatSendMessage, {
            sessionId,
            text,
          });
          await refreshSelected();
          await subscribeRun(result.runId);
        } catch (failure) {
          await refreshSelected().catch(() => undefined);
          const accepted = document()?.entries.some(
            (entry) => entry.role === "user" && entry.content === text,
          );
          if (!accepted) {
            setDraft(text);
          }
          setError(describeError(failure));
        } finally {
          setSending(false);
        }
      };

      const spawnSubAgent = async (): Promise<void> => {
        const parentSessionId = document()?.session.id;
        const task = subAgentTask().trim();
        if (!parentSessionId || !task) {
          return;
        }
        setError(undefined);
        try {
          const result = await context.bus.invoke(chatSpawnSubAgent, {
            parentSessionId,
            task,
          });
          setSubAgentTask("");
          await refreshSessions(result.childSessionId);
        } catch (failure) {
          setError(describeError(failure));
        }
      };

      return (
        <section
          class="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--panel)]"
          data-testid="chat-workspace"
        >
          <div class="grid min-h-[640px] grid-cols-[14rem_minmax(20rem,1fr)_15rem]">
            <aside class="border-r border-[var(--border)] bg-[var(--panel-muted)]/45 p-3">
              <button
                type="button"
                class="flex w-full items-center justify-center gap-2 rounded-xl bg-[var(--accent)] px-3 py-2.5 text-sm font-semibold text-[var(--background)]"
                onClick={() => void createSession()}
                data-testid="chat-new-session"
              >
                <MessageSquarePlus aria-hidden="true" size={16} />
                New session
              </button>
              <div class="mt-3 grid gap-1" data-testid="chat-session-list">
                <For each={sessions()}>
                  {(session) => (
                    <button
                      type="button"
                      class="rounded-xl px-3 py-2.5 text-left text-sm transition hover:bg-[var(--panel)]"
                      classList={{
                        "bg-[var(--panel)] text-[var(--accent)]":
                          document()?.session.id === session.id,
                      }}
                      onClick={() => void selectSession(session.id)}
                      data-testid={`chat-session-item-${session.id}`}
                    >
                      <span class="block truncate font-medium">{session.title}</span>
                      <span class="mt-1 block text-[10px] uppercase tracking-wider text-[var(--text-subtle)]">
                        {session.parentSessionId ? "sub-agent · " : ""}
                        {session.status}
                      </span>
                    </button>
                  )}
                </For>
              </div>
              <div class="mt-5 border-t border-[var(--border)] pt-4">
                <p class="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-subtle)]">
                  Sub-agent
                </p>
                <input
                  value={subAgentTask()}
                  onInput={(event) =>
                    setSubAgentTask(event.currentTarget.value)
                  }
                  class="mt-2 w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-2.5 py-2 text-xs"
                  placeholder="Delegate a task"
                  data-testid="chat-subagent-task"
                />
                <button
                  type="button"
                  class="mt-2 w-full rounded-lg border border-[var(--border)] px-2 py-2 text-xs hover:border-[var(--accent)]"
                  disabled={!subAgentTask().trim()}
                  onClick={() => void spawnSubAgent()}
                  data-testid="chat-spawn-subagent"
                >
                  Spawn child session
                </button>
              </div>
            </aside>

            <div class="flex min-w-0 flex-col">
              <header class="flex items-center justify-between border-b border-[var(--border)] px-5 py-3">
                <div>
                  <h2 class="font-semibold">{document()?.session.title ?? "Chat"}</h2>
                  <p
                    class="text-xs text-[var(--text-muted)]"
                    data-testid="chat-session-status"
                  >
                    {document()?.session.status ?? "loading"}
                  </p>
                  <p
                    class="text-xs text-[var(--text-subtle)]"
                    data-testid="chat-session-persona"
                  >
                    {document()?.session.personaId ?? ""}
                  </p>
                </div>
                <button
                  type="button"
                  aria-label="Delete session"
                  class="rounded-lg p-2 text-[var(--text-subtle)] hover:bg-[var(--danger)]/10 hover:text-[var(--danger)]"
                  onClick={() => void deleteSession()}
                  data-testid="chat-delete-session"
                >
                  <Trash2 aria-hidden="true" size={16} />
                </button>
              </header>

              <div
                class="flex-1 space-y-4 overflow-y-auto p-5"
                data-testid="chat-transcript"
              >
                <For each={document()?.entries ?? []}>
                  {(entry) => (
                    <div
                      class="max-w-[85%] rounded-2xl border border-[var(--border)] px-4 py-3 text-sm"
                      classList={{
                        "ml-auto bg-[var(--accent)]/10":
                          entry.role === "user",
                        "bg-[var(--panel-muted)]":
                          entry.role === "assistant",
                        "text-xs text-[var(--text-muted)]":
                          entry.role === "tool" || entry.role === "event",
                      }}
                      data-testid="chat-message"
                      data-message-id={entry.id}
                      data-role={entry.role}
                    >
                      <p class="whitespace-pre-wrap">{entry.content}</p>
                    </div>
                  )}
                </For>
                <Show when={streaming()}>
                  {(content) => (
                    <div
                      class="max-w-[85%] rounded-2xl border border-[var(--accent)]/30 bg-[var(--panel-muted)] px-4 py-3 text-sm"
                      data-testid="chat-streaming-message"
                    >
                      {content()}
                    </div>
                  )}
                </Show>
              </div>

              <Show when={error()}>
                {(message) => (
                  <p class="px-5 pb-2 text-xs text-[var(--danger)]">
                    {message()}
                  </p>
                )}
              </Show>
              <div class="flex gap-3 border-t border-[var(--border)] p-4">
                <textarea
                  rows="2"
                  value={draft()}
                  onInput={(event) => setDraft(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void send();
                    }
                  }}
                  class="min-w-0 flex-1 resize-none rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2.5 text-sm outline-none focus:border-[var(--accent)]"
                  placeholder="Message Borg"
                  data-testid="chat-composer-input"
                />
                <button
                  type="button"
                  class="self-end rounded-xl bg-[var(--accent)] p-3 text-[var(--background)] disabled:opacity-40"
                  disabled={!draft().trim() || sending()}
                  onClick={() => void send()}
                  data-testid="chat-send"
                  aria-label="Send message"
                >
                  <Send aria-hidden="true" size={17} />
                </button>
              </div>
            </div>

            <aside
              class="border-l border-[var(--border)] bg-[var(--panel-muted)]/30 p-4"
              data-testid="chat-workspace-browser"
            >
              <div class="flex items-center gap-2">
                <FolderOpen
                  aria-hidden="true"
                  size={17}
                  class="text-[var(--accent)]"
                />
                <h3 class="text-sm font-semibold">Workspace</h3>
              </div>
              <div class="mt-4 grid gap-2">
                <For
                  each={files()}
                  fallback={
                    <p class="text-xs text-[var(--text-subtle)]">
                      No files yet.
                    </p>
                  }
                >
                  {(file) => (
                    <div
                      class="flex items-start gap-2 rounded-lg border border-[var(--border)] px-2.5 py-2"
                      data-testid="chat-workspace-file"
                      data-path={file.path}
                    >
                      <FileText
                        aria-hidden="true"
                        size={14}
                        class="mt-0.5 shrink-0 text-[var(--text-muted)]"
                      />
                      <div class="min-w-0">
                        <p class="break-all text-xs">{file.path}</p>
                        <p class="mt-1 text-[10px] text-[var(--text-subtle)]">
                          {file.size} bytes
                        </p>
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </aside>
          </div>
        </section>
      );
    };

    const PersonaSetup: Component = () => {
      const [personas, setPersonas] = createSignal<readonly Persona[]>([]);
      const [models, setModels] = createSignal<readonly ModelDescriptor[]>([]);
      const [selected, setSelected] = createSignal("");
      const [selectedModel, setSelectedModel] = createSignal("");
      const [name, setName] = createSignal("");
      const [instructions, setInstructions] = createSignal("");
      const [status, setStatus] = createSignal("Loading personas…");

      const ensureAvailableModel = async (
        persona: Persona,
        availableModels: readonly ModelDescriptor[],
      ): Promise<string | undefined> => {
        const configured = persona.preferredModels
          .map((preference) =>
            availableModels.find((model) =>
              matchesModelPreference(model, preference),
            ),
          )
          .find((model) => model !== undefined);
        const fallback = availableModels[0]?.preferenceId;
        if (!configured && fallback) {
          await context.personas.update(persona.id, {
            preferredModels: [
              fallback,
              ...persona.preferredModels.filter(
                (preference) => preference !== fallback,
              ),
            ],
          });
        }
        return configured?.preferenceId ?? fallback;
      };

      const load = async (): Promise<void> => {
        const [available, current, availableModels] = await Promise.all([
          context.personas.list(),
          context.personas.getDefault(),
          context.models.list(),
        ]);
        setPersonas(available);
        setModels(availableModels);
        setSelected(current.id);
        const model = await ensureAvailableModel(current, availableModels);
        setSelectedModel(model ?? "");
        setPersonaReady(model !== undefined);
        setStatus(
          model ? "Persona ready" : "Choose an available model to continue",
        );
      };

      onMount(() => {
        void load().catch((error: unknown) => {
          setPersonaReady(false);
          setStatus(describeError(error));
        });
      });

      const choose = async (personaId: string): Promise<void> => {
        setSelected(personaId);
        setStatus("Saving…");
        try {
          await context.personas.setDefault(personaId);
          const persona = await context.personas.get(personaId);
          const model = persona
            ? await ensureAvailableModel(persona, models())
            : undefined;
          setSelectedModel(model ?? "");
          setPersonaReady(model !== undefined);
          setStatus("Default persona saved");
        } catch (error) {
          setPersonaReady(false);
          setStatus(describeError(error));
        }
      };

      const chooseModel = async (preferenceId: string): Promise<void> => {
        if (!preferenceId || !selected()) {
          setPersonaReady(false);
          return;
        }
        setSelectedModel(preferenceId);
        setStatus("Saving model…");
        try {
          const persona = await context.personas.get(selected());
          if (!persona) {
            throw new Error("Selected persona is unavailable");
          }
          await context.personas.update(persona.id, {
            preferredModels: [
              preferenceId,
              ...persona.preferredModels.filter(
                (preference) => preference !== preferenceId,
              ),
            ],
          });
          setPersonaReady(true);
          setStatus("Default model saved");
        } catch (error) {
          setPersonaReady(false);
          setStatus(describeError(error));
        }
      };

      const createPersona = async (): Promise<void> => {
        const slug = name()
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9_-]+/g, "-")
          .replace(/^-+|-+$/g, "");
        if (!slug || !instructions().trim()) {
          setStatus("Name and instructions are required");
          return;
        }
        setStatus("Creating…");
        try {
          const persona = await context.personas.create({
            id: `user/${slug}`,
            name: name().trim(),
            instructions: instructions().trim(),
            preferredModels: [selectedModel()],
            secondaryModels: [],
            allowedTools: ["*"],
            mcpServers: [],
            loopStrategy: "react",
            toolExecutionMode: "sequential-partial",
            skillIds: [],
            contextMapStrategy: "general",
            archived: false,
          });
          await context.personas.setDefault(persona.id);
          setName("");
          setInstructions("");
          await load();
          setSelected(persona.id);
          setStatus("Custom persona created");
        } catch (error) {
          setStatus(describeError(error));
        }
      };

      return (
        <section data-testid="wizard-persona-step">
          <div class="flex items-center gap-3">
            <UserRoundCog
              aria-hidden="true"
              size={20}
              class="text-[var(--accent)]"
            />
            <div>
              <h3 class="font-semibold">Model and persona</h3>
              <p class="text-xs text-[var(--text-muted)]">
                Choose the policy used for new chat sessions.
              </p>
            </div>
          </div>
          <label class="mt-5 block text-sm text-[var(--text-muted)]">
            Model provider
            <select
              value={selectedModel()}
              onChange={(event) =>
                void chooseModel(event.currentTarget.value)
              }
              class="mt-2 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2"
              data-testid="wizard-model-select"
            >
              <For each={models()}>
                {(model) => (
                  <option value={model.preferenceId}>
                    {model.providerId} · {model.modelId}
                  </option>
                )}
              </For>
            </select>
          </label>
          <label class="mt-4 block text-sm text-[var(--text-muted)]">
            Default persona
            <select
              value={selected()}
              onChange={(event) => void choose(event.currentTarget.value)}
              class="mt-2 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2"
              data-testid="wizard-persona-select"
            >
              <For each={personas()}>
                {(persona) => <option value={persona.id}>{persona.name}</option>}
              </For>
            </select>
          </label>
          <details class="mt-5 rounded-xl border border-[var(--border)] p-4">
            <summary class="cursor-pointer text-sm font-semibold">
              Create a persona
            </summary>
            <input
              value={name()}
              onInput={(event) => setName(event.currentTarget.value)}
              class="mt-4 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm"
              placeholder="Persona name"
              data-testid="settings-persona-name"
            />
            <textarea
              value={instructions()}
              onInput={(event) => setInstructions(event.currentTarget.value)}
              class="mt-3 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm"
              placeholder="Instructions"
              data-testid="settings-persona-instructions"
            />
            <button
              type="button"
              class="mt-3 rounded-xl border border-[var(--accent)] px-4 py-2 text-sm text-[var(--accent)]"
              disabled={!selectedModel()}
              onClick={() => void createPersona()}
              data-testid="settings-persona-create"
            >
              Create and select
            </button>
          </details>
          <p class="mt-3 text-xs text-[var(--text-muted)]">{status()}</p>
        </section>
      );
    };

    const ActiveSessions: Component = () => {
      const [sessions, setSessions] = createSignal<readonly ChatSession[]>([]);
      const activeSessions = createMemo(() =>
        sessions().filter(({ status }) =>
          ["running", "waiting"].includes(status),
        ),
      );
      let active = true;
      const subscriptions: Disposable[] = [];

      const refresh = async (): Promise<void> => {
        const result = await context.bus.invoke(chatListSessions, {});
        if (active) {
          setSessions(result.sessions);
        }
      };

      const subscribe = async (): Promise<void> => {
        for (const event of [
          chatSessionUpdated,
          chatSessionDeleted,
          chatTurnCompleted,
        ] as const) {
          const disposable = await context.bus.on(event, () => refresh());
          if (active) {
            subscriptions.push(disposable);
          } else {
            await disposable.dispose();
          }
        }
      };

      onMount(() => {
        void subscribe().then(refresh);
      });
      onCleanup(() => {
        active = false;
        for (const subscription of subscriptions) {
          void subscription.dispose();
        }
      });

      return (
        <Panel data-testid="flightdeck-chat-sessions">
          <div class="flex items-center gap-3">
            <Bot aria-hidden="true" size={20} class="text-[var(--accent)]" />
            <div>
              <p class="text-sm font-semibold">Active chat sessions</p>
              <p class="text-xs text-[var(--text-muted)]">
                <span data-testid="flightdeck-active-session-count">
                  {activeSessions().length}
                </span>{" "}
                running or waiting
              </p>
            </div>
          </div>
          <For each={activeSessions()}>
            {(session) => (
              <p class="mt-3 truncate text-xs text-[var(--text-muted)]">
                {session.title}
              </p>
            )}
          </For>
        </Panel>
      );
    };

    const workspace = context.ui.registerWorkspaceView({
      id: "borg.chat.workspace",
      label: "Chat",
      order: 0,
      component: ChatWorkspace,
    });
    const wizard = context.ui.registerWizardStep({
      id: "borg.chat.persona",
      label: "Model and persona",
      order: 30,
      required: true,
      isComplete: personaReady,
      component: PersonaSetup,
    });
    const settings = context.ui.registerSettingsPage({
      id: "borg.chat.personas",
      label: "Personas",
      order: 10,
      component: PersonaSetup,
    });
    const widget = context.ui.registerFlightDeckWidget({
      id: "borg.chat.active-sessions",
      label: "Active sessions",
      order: 10,
      component: ActiveSessions,
    });
    return {
      dispose: async () => {
        await widget.dispose();
        await settings.dispose();
        await wizard.dispose();
        await workspace.dispose();
      },
    };
  },
});
