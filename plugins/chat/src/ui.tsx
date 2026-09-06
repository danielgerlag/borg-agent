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
  embeddedContentSnapshotSchema,
  emptyChatUsage,
  type ChatEntry,
  type EmbeddedContentSnapshot,
  type ChatSession,
  type ChatUsage,
  type ModelDescriptor,
  type Persona,
  type WorkspaceFile,
} from "@borg/contracts";
import {
  defineUiPlugin,
  type Disposable,
  type EmbeddedContentRendererProps,
  z,
} from "@borg/plugin-sdk";
import { Button, Panel } from "@borg/ui-kit";
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
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  type Component,
} from "solid-js";
import { Dynamic, Portal } from "solid-js/web";
import { adoptChatDocument } from "./adopt-document";
import { matchesModelPreference } from "./model-preference";

type ChatDocument = z.infer<typeof chatDocumentSchema>;

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/\bChat sessions\b/g, "Chats")
    .replace(/\bChat session\b/g, "Chat")
    .replace(/\bSessions\b/g, "Chats")
    .replace(/\bSession\b/g, "Chat")
    .replace(/\bchat sessions\b/gi, "chats")
    .replace(/\bchat session\b/gi, "chat")
    .replace(/\bsessions\b/gi, "chats")
    .replace(/\bsession\b/gi, "chat");
}

function displayTitle(title: string): string {
  return title === "New session" ? "New chat" : title;
}

function displayStatus(status: ChatSession["status"]): string {
  switch (status) {
    case "running":
      return "Thinking";
    case "waiting":
      return "Needs your input";
    case "error":
      return "Error";
    default:
      return "Ready";
  }
}

function formatChatUsage(usage: ChatUsage): string {
  const costs = Object.entries(usage.costsByCurrency)
    .map(([currency, amount]) => `${currency} ${amount.toFixed(4)}`)
    .join(" + ");
  const cache =
    usage.cachedInputTokens + usage.cacheWriteTokens > 0
      ? ` · cache ${usage.cachedInputTokens}/${usage.cacheWriteTokens}`
      : "";
  return `${usage.inputTokens} in · ${usage.outputTokens} out${cache} · ${costs || "no cost"}`;
}

function addChatUsage(base: ChatUsage, extra: ChatUsage): ChatUsage {
  const costsByCurrency: Record<string, number> = { ...base.costsByCurrency };
  for (const [currency, amount] of Object.entries(extra.costsByCurrency)) {
    costsByCurrency[currency] = (costsByCurrency[currency] ?? 0) + amount;
  }
  return {
    inputTokens: base.inputTokens + extra.inputTokens,
    outputTokens: base.outputTokens + extra.outputTokens,
    cachedInputTokens: base.cachedInputTokens + extra.cachedInputTokens,
    cacheWriteTokens: base.cacheWriteTokens + extra.cacheWriteTokens,
    costsByCurrency,
  };
}

function displayModelName(model: ModelDescriptor): string {
  if (model.modelId === "mock:scripted") {
    return "Built-in demo model";
  }
  if (model.modelId === "claude-sonnet-5") {
    return "Claude Sonnet 5";
  }
  if (model.modelId === "claude-haiku-4-5") {
    return "Claude Haiku 4.5";
  }
  if (model.modelId === "claude-opus-5") {
    return "Claude Opus 5";
  }
  if (model.modelId === "gpt-5-mini") {
    return "GPT-5 Mini";
  }
  if (model.modelId === "gpt-5-nano") {
    return "GPT-5 Nano";
  }
  if (model.modelId === "gpt-5") {
    return "GPT-5";
  }
  return model.modelId
    .replace(/^[^:]+:/, "")
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function activityLabel(entry: ChatEntry): string {
  if (entry.role === "tool") {
    const toolId = entry.metadata?.toolId;
    return typeof toolId === "string" ? `Used ${toolId}` : "Tool activity";
  }

  const kind = entry.metadata?.kind;
  const status = entry.metadata?.status;
  if (kind === "human_input" && entry.content.startsWith("Waiting for input")) {
    return "Requested your input";
  }
  if (status === "failed" || status === "failed_to_start") {
    return "An error occurred";
  }
  if (status === "cancelled") {
    return "Turn cancelled";
  }
  if (status === "interrupted") {
    return "Previous turn interrupted";
  }
  return "Conversation update";
}

function embeddedContent(
  entry: ChatEntry,
): EmbeddedContentSnapshot | undefined {
  const parsed = embeddedContentSnapshotSchema.safeParse(
    entry.metadata?.embeddedContent,
  );
  return parsed.success ? parsed.data : undefined;
}

export default defineUiPlugin<Component>({
  id: "borg.chat",
  activate(context) {
    const [personaReady, setPersonaReady] = createSignal(false);

    const EmbeddedContent: Component<{
      readonly content: EmbeddedContentSnapshot;
    }> = (props) => {
      const renderer = context.ui.getEmbeddedContentRenderer(
        props.content.rendererId,
      );
      return (
        <Show
          when={renderer}
          fallback={
            <div
              class="mx-auto w-full max-w-[92%] rounded-xl border border-[var(--border)] bg-[var(--panel-muted)]/45 p-3 text-sm text-[var(--text-muted)]"
              data-testid="chat-embedded-content-unavailable"
            >
              Interactive content is unavailable.
            </div>
          }
        >
          {(match) => (
            <div
              class="mx-auto w-full max-w-[92%]"
              data-testid="chat-embedded-content"
              data-content-instance-id={props.content.instanceId}
            >
              <Dynamic
                component={
                  match().component as Component<EmbeddedContentRendererProps>
                }
                content={props.content}
              />
            </div>
          )}
        </Show>
      );
    };

    const ChatWorkspace: Component = () => {
      const [sessions, setSessions] = createSignal<readonly ChatSession[]>([]);
      const [document, setDocument] = createSignal<ChatDocument>();
      const [files, setFiles] = createSignal<readonly WorkspaceFile[]>([]);
      const [personas, setPersonas] = createSignal<readonly Persona[]>([]);
      const [defaultPersonaId, setDefaultPersonaId] = createSignal("");
      const [draft, setDraft] = createSignal("");
      const [subAgentTask, setSubAgentTask] = createSignal("");
      const [streaming, setStreaming] = createSignal("");
      const [liveUsage, setLiveUsage] = createSignal<ChatUsage>();
      const [sending, setSending] = createSignal(false);
      const [spawningSubAgent, setSpawningSubAgent] = createSignal(false);
      const [composingNew, setComposingNew] = createSignal(false);
      const [workspaceOpen, setWorkspaceOpen] = createSignal(false);
      const [deleteCandidate, setDeleteCandidate] = createSignal<ChatSession>();
      const [initialLoadComplete, setInitialLoadComplete] = createSignal(false);
      const [error, setError] = createSignal<string>();
      const disposables: Disposable[] = [];
      let loopSubscription: Disposable | undefined;
      let subscribedRunId: string | undefined;
      let active = true;
      let selectionGeneration = 0;
      let refreshGeneration = 0;
      let loopGeneration = 0;
      let composerInput: HTMLTextAreaElement | undefined;
      let conversationHeading: HTMLHeadingElement | undefined;
      let deleteTrigger: HTMLButtonElement | undefined;
      let deleteCancelButton: HTMLButtonElement | undefined;
      let deleteConfirmButton: HTMLButtonElement | undefined;

      const orderedSessions = createMemo(
        (): readonly {
          readonly session: ChatSession;
          readonly depth: number;
        }[] => {
          const available = sessions();
          const ids = new Set(available.map(({ id }) => id));
          const visited = new Set<string>();
          const ordered: { session: ChatSession; depth: number }[] = [];

          const visit = (session: ChatSession, depth: number): void => {
            if (visited.has(session.id)) {
              return;
            }
            visited.add(session.id);
            ordered.push({ session, depth });
            for (const child of available) {
              if (child.parentSessionId === session.id) {
                visit(child, depth + 1);
              }
            }
          };

          for (const session of available) {
            if (!session.parentSessionId || !ids.has(session.parentSessionId)) {
              visit(session, 0);
            }
          }
          for (const session of available) {
            visit(session, 0);
          }
          return ordered;
        },
      );

      const personaName = createMemo(() => {
        const personaId =
          document()?.session.personaId ?? defaultPersonaId();
        return (
          personas().find(({ id }) => id === personaId)?.name ?? "Assistant"
        );
      });

      const emptyConversation = createMemo(
        () =>
          initialLoadComplete() &&
          (document()?.entries.length ?? 0) === 0 &&
          !streaming(),
      );

      const focusComposer = (): void => {
        queueMicrotask(() => composerInput?.focus());
      };

      const closeDeleteConfirmation = (restoreFocus = true): void => {
        setDeleteCandidate(undefined);
        if (restoreFocus) {
          queueMicrotask(() => deleteTrigger?.focus());
        }
      };

      createEffect(() => {
        if (deleteCandidate()) {
          const applicationRoot = globalThis.document.getElementById("root");
          applicationRoot?.setAttribute("inert", "");
          queueMicrotask(() => deleteCancelButton?.focus());
          onCleanup(() => applicationRoot?.removeAttribute("inert"));
        }
      });

      const abandonLoopSubscription = (): void => {
        loopGeneration += 1;
        const subscription = loopSubscription;
        loopSubscription = undefined;
        subscribedRunId = undefined;
        setStreaming("");
        setLiveUsage(undefined);
        if (subscription) {
          void subscription.dispose();
        }
      };

      const beginNewChat = (): void => {
        selectionGeneration += 1;
        refreshGeneration += 1;
        abandonLoopSubscription();
        setDocument(undefined);
        setFiles([]);
        setDraft("");
        setSubAgentTask("");
        setError(undefined);
        setComposingNew(true);
        setWorkspaceOpen(false);
        setDeleteCandidate(undefined);
        focusComposer();
      };

      const refreshSessions = async (
        preferredSessionId?: string,
      ): Promise<void> => {
        const result = await context.bus.invoke(chatListSessions, {});
        if (!active) {
          return;
        }
        setSessions(result.sessions);

        const preferred = preferredSessionId
          ? result.sessions.find(({ id }) => id === preferredSessionId)
          : undefined;
        const currentId = document()?.session.id;
        const currentExists = result.sessions.some(({ id }) => id === currentId);

        if (preferred && preferred.id !== currentId) {
          await selectSession(preferred.id);
          return;
        }
        if (currentId && currentExists) {
          return;
        }
        if (composingNew()) {
          return;
        }
        const next = result.sessions[0];
        if (next) {
          await selectSession(next.id);
        } else {
          beginNewChat();
        }
      };

      const subscribeRun = async (runId: string): Promise<void> => {
        if (loopSubscription && subscribedRunId === runId) {
          return;
        }
        const generation = ++loopGeneration;
        const previousSubscription = loopSubscription;
        loopSubscription = undefined;
        subscribedRunId = undefined;
        await previousSubscription?.dispose();
        setStreaming("");
        setLiveUsage(undefined);
        const subscription = await context.loops.subscribe(runId, (event) => {
          if (
            !active ||
            generation !== loopGeneration ||
            document()?.session.activeRunId !== runId
          ) {
            return;
          }
          if (event.type === "model_start") {
            setStreaming("");
          }
          if (event.type === "model_token") {
            setStreaming((current) => `${current}${event.token}`);
          }
          if (event.type === "usage") {
            setLiveUsage({
              inputTokens: event.inputTokens,
              outputTokens: event.outputTokens,
              cachedInputTokens: event.cachedInputTokens,
              cacheWriteTokens: event.cacheWriteTokens,
              costsByCurrency: event.costsByCurrency,
            });
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
        subscribedRunId = runId;
      };

      const refreshSelected = async (): Promise<void> => {
        const sessionId = document()?.session.id;
        const selection = selectionGeneration;
        const refresh = ++refreshGeneration;
        if (!sessionId) {
          return;
        }
        const [next, workspace] = await Promise.all([
          context.bus.invoke(chatGetSession, { sessionId }),
          context.bus.invoke(chatListWorkspace, { sessionId }),
        ]);
        if (
          !active ||
          selection !== selectionGeneration ||
          refresh !== refreshGeneration ||
          document()?.session.id !== sessionId
        ) {
          return;
        }
        setDocument((current) => adoptChatDocument({ current, next }));
        setFiles(workspace.files);
        if (next.session.activeRunId) {
          await subscribeRun(next.session.activeRunId);
        } else if (loopSubscription) {
          abandonLoopSubscription();
        }
      };

      const selectSession = async (sessionId: string): Promise<void> => {
        setDeleteCandidate(undefined);
        const generation = ++selectionGeneration;
        refreshGeneration += 1;
        const [next, workspace] = await Promise.all([
          context.bus.invoke(chatGetSession, { sessionId }),
          context.bus.invoke(chatListWorkspace, { sessionId }),
        ]);
        if (!active || generation !== selectionGeneration) {
          return;
        }
        ++loopGeneration;
        const previousSubscription = loopSubscription;
        loopSubscription = undefined;
        subscribedRunId = undefined;
        await previousSubscription?.dispose();
        if (!active || generation !== selectionGeneration) {
          return;
        }
        setStreaming("");
        setDocument((current) => adoptChatDocument({ current, next }));
        setFiles(workspace.files);
        setSubAgentTask("");
        setComposingNew(false);
        setError(undefined);
        if (next.entries.length === 0) {
          focusComposer();
        }
        if (next.session.activeRunId) {
          await subscribeRun(next.session.activeRunId);
        }
      };

      const loadPersonas = async (): Promise<void> => {
        const [available, defaultPersona] = await Promise.all([
          context.personas.list(true),
          context.personas.getDefault(),
        ]);
        if (!active) {
          return;
        }
        setPersonas(available);
        setDefaultPersonaId(defaultPersona.id);
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
              refreshGeneration += 1;
              setDocument((current) =>
                current ? { ...current, session } : current,
              );
              if (session.activeRunId) {
                void subscribeRun(session.activeRunId);
              } else {
                abandonLoopSubscription();
              }
              void refreshSelected();
            }
          }),
        );
        void addEventSubscription(
          context.bus.on(chatSessionDeleted, ({ sessionId }) => {
            if (deleteCandidate()?.id === sessionId) {
              setDeleteCandidate(undefined);
            }
            setSessions((current) =>
              current.filter(({ id }) => id !== sessionId),
            );
            if (document()?.session.id === sessionId) {
              selectionGeneration += 1;
              refreshGeneration += 1;
              abandonLoopSubscription();
              setDocument(undefined);
              setFiles([]);
              setDraft("");
              setComposingNew(false);
              setWorkspaceOpen(false);
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
        void refreshSessions()
          .catch((failure: unknown) => setError(describeError(failure)))
          .finally(() => {
            if (active) {
              setInitialLoadComplete(true);
            }
          });
        void loadPersonas().catch((failure: unknown) =>
          setError(describeError(failure)),
        );
      });

      onCleanup(() => {
        active = false;
        selectionGeneration += 1;
        refreshGeneration += 1;
        loopGeneration += 1;
        loopSubscription?.dispose();
        for (const disposable of disposables) {
          void disposable.dispose();
        }
      });

      const deleteSession = async (sessionId: string): Promise<void> => {
        setError(undefined);
        try {
          await context.bus.invoke(chatDeleteSession, {
            sessionId,
          });
          if (document()?.session.id === sessionId) {
            selectionGeneration += 1;
            refreshGeneration += 1;
            abandonLoopSubscription();
            setDocument(undefined);
            setFiles([]);
            setDraft("");
            setComposingNew(false);
            setWorkspaceOpen(false);
          }
          await refreshSessions();
          queueMicrotask(() => {
            if (document()) {
              conversationHeading?.focus();
            } else {
              composerInput?.focus();
            }
          });
        } catch (failure) {
          setError(describeError(failure));
          queueMicrotask(() => deleteTrigger?.focus());
        }
      };

      const send = async (): Promise<void> => {
        const text = draft().trim();
        const selectedSessionId = document()?.session.id;
        const startsNewChat = !selectedSessionId && composingNew();
        const generation = selectionGeneration;
        if (
          (!selectedSessionId && !startsNewChat) ||
          !text ||
          sending()
        ) {
          return;
        }
        setSending(true);
        setError(undefined);
        setDraft("");
        let sessionId = selectedSessionId;
        let createdSession = false;
        let initialStartError: string | undefined;
        try {
          if (!sessionId) {
            const created = await context.bus.invoke(chatCreateSession, {
              initialMessage: text,
            });
            sessionId = created.sessionId;
            createdSession = true;
            initialStartError = created.startError;
          } else {
            await context.bus.invoke(chatSendMessage, {
              sessionId,
              text,
            });
          }

          if (!active) {
            return;
          }
          if (
            startsNewChat &&
            generation === selectionGeneration &&
            composingNew()
          ) {
            await refreshSessions(sessionId);
          } else if (
            generation === selectionGeneration &&
            document()?.session.id === sessionId
          ) {
            await refreshSelected();
            await refreshSessions();
          } else {
            await refreshSessions();
          }
          if (
            initialStartError &&
            document()?.session.id === sessionId
          ) {
            setError(describeError(initialStartError));
          }
        } catch (failure) {
          if (!active) {
            return;
          }

          let accepted = false;
          let inspected = false;
          let rolledBack = false;
          if (sessionId) {
            try {
              const persisted = await context.bus.invoke(chatGetSession, {
                sessionId,
              });
              inspected = true;
              accepted = persisted.entries.some(
                (entry) => entry.role === "user" && entry.content === text,
              );
            } catch {
              // The chat may already have been rolled back by the main plugin.
            }
          }
          if (createdSession && sessionId && inspected && !accepted) {
            try {
              await context.bus.invoke(chatDeleteSession, { sessionId });
              rolledBack = true;
            } catch {
              // Keep the empty chat visible if durable rollback also fails.
            }
          }

          const stillCurrent =
            generation === selectionGeneration &&
            (startsNewChat
              ? composingNew()
              : document()?.session.id === sessionId);
          if (sessionId && stillCurrent) {
            if (createdSession && !accepted && rolledBack) {
              beginNewChat();
              await refreshSessions().catch(() => undefined);
            } else if (startsNewChat) {
              await refreshSessions(sessionId).catch(() => undefined);
            } else {
              await refreshSelected().catch(() => undefined);
            }
          }
          if (!accepted && stillCurrent) {
            setDraft((current) => current.trim() || text);
            focusComposer();
          }
          if (stillCurrent) {
            setError(describeError(failure));
          }
        } finally {
          if (active) {
            setSending(false);
          }
        }
      };

      const spawnSubAgent = async (): Promise<void> => {
        const parentSessionId = document()?.session.id;
        const task = subAgentTask().trim();
        const generation = selectionGeneration;
        if (!parentSessionId || !task || spawningSubAgent()) {
          return;
        }
        setError(undefined);
        setSpawningSubAgent(true);
        try {
          const result = await context.bus.invoke(chatSpawnSubAgent, {
            parentSessionId,
            task,
          });
          setSubAgentTask("");
          if (
            active &&
            generation === selectionGeneration &&
            document()?.session.id === parentSessionId
          ) {
            await refreshSessions(result.childSessionId);
          } else {
            await refreshSessions();
          }
        } catch (failure) {
          setError(describeError(failure));
        } finally {
          if (active) {
            setSpawningSubAgent(false);
          }
        }
      };

      return (
        <section
          class="relative h-full min-h-0 overflow-hidden bg-[var(--panel)]"
          data-testid="chat-workspace"
        >
          <div
            class="grid h-full min-h-0 grid-cols-[13rem_minmax(20rem,1fr)]"
            inert={deleteCandidate() !== undefined}
          >
            <aside class="flex min-h-0 flex-col border-r border-[var(--border)] bg-[var(--panel-muted)]/45 p-3">
              <button
                type="button"
                class="flex w-full items-center justify-center gap-2 rounded-xl bg-[var(--accent)] px-3 py-2.5 text-sm font-semibold text-[var(--background)]"
                disabled={sending()}
                onClick={beginNewChat}
                data-testid="chat-new-session"
              >
                <MessageSquarePlus aria-hidden="true" size={16} />
                New chat
              </button>
              <div
                class="mt-3 grid min-h-0 gap-1 overflow-y-auto"
                data-testid="chat-session-list"
              >
                <For
                  each={orderedSessions()}
                  fallback={
                    <p class="px-3 py-4 text-center text-xs text-[var(--text-subtle)]">
                      No saved chats yet.
                    </p>
                  }
                >
                  {({ session, depth }) => (
                    <div
                      classList={{
                        "border-l border-[var(--border)] pl-2": depth > 0,
                      }}
                      style={{
                        "margin-left": `${Math.min(depth, 4) * 0.625}rem`,
                      }}
                      data-chat-depth={depth}
                    >
                      <button
                        type="button"
                        class="w-full rounded-xl px-3 py-2.5 text-left text-sm transition hover:bg-[var(--panel)]"
                        classList={{
                          "bg-[var(--panel)] text-[var(--accent)]":
                            document()?.session.id === session.id,
                        }}
                        onClick={() => void selectSession(session.id)}
                        data-testid={`chat-session-item-${session.id}`}
                      >
                        <span class="block truncate font-medium">
                          {displayTitle(session.title)}
                        </span>
                        <span class="mt-1 block text-[10px] uppercase tracking-wider text-[var(--text-subtle)]">
                          {session.parentSessionId ? "Child chat · " : ""}
                          {displayStatus(session.status)}
                        </span>
                      </button>
                    </div>
                  )}
                </For>
              </div>
            </aside>

            <div class="flex min-w-0 flex-col">
              <header class="flex items-center justify-between border-b border-[var(--border)] px-5 py-3">
                <div class="min-w-0">
                  <h2
                    ref={(element) => {
                      conversationHeading = element;
                    }}
                    class="truncate font-semibold outline-none"
                    tabIndex={-1}
                  >
                    {displayTitle(document()?.session.title ?? "New chat")}
                  </h2>
                  <p
                    class="text-xs text-[var(--text-muted)]"
                    data-testid="chat-session-status"
                  >
                    {displayStatus(document()?.session.status ?? "idle")}
                  </p>
                  <p
                    class="text-xs text-[var(--text-subtle)]"
                    data-testid="chat-session-persona"
                  >
                    Talking with {personaName()}
                  </p>
                  <Show when={document()}>
                    {(current) => (
                      <p
                        class="text-xs text-[var(--text-subtle)]"
                        data-testid="chat-session-usage"
                      >
                        {formatChatUsage(
                          current().session.activeRunId && liveUsage()
                            ? addChatUsage(
                                current().session.usage ?? emptyChatUsage,
                                liveUsage()!,
                              )
                            : (current().session.usage ?? emptyChatUsage),
                        )}
                      </p>
                    )}
                  </Show>
                </div>
                <Show when={document()}>
                  <div class="ml-3 flex items-center gap-1">
                    <button
                      type="button"
                      class="flex items-center gap-2 rounded-lg px-2.5 py-2 text-xs text-[var(--text-muted)] hover:bg-[var(--panel-muted)] hover:text-[var(--text)]"
                      aria-controls="chat-workspace-browser"
                      aria-expanded={workspaceOpen()}
                      onClick={() => setWorkspaceOpen((open) => !open)}
                      data-testid="chat-workspace-toggle"
                    >
                      <FolderOpen aria-hidden="true" size={15} />
                      Files
                    </button>
                    <button
                      ref={(element) => {
                        deleteTrigger = element;
                      }}
                      type="button"
                      aria-label="Delete conversation"
                      class="rounded-lg p-2 text-[var(--text-subtle)] hover:bg-[var(--danger)]/10 hover:text-[var(--danger)]"
                      onClick={() => {
                        const selected = document()?.session;
                        if (selected) {
                          setDeleteCandidate(selected);
                        }
                      }}
                      data-testid="chat-delete-session"
                    >
                      <Trash2 aria-hidden="true" size={16} />
                    </button>
                  </div>
                </Show>
              </header>

              <div class="flex min-h-0 flex-1">
                <main class="flex min-w-0 flex-1 flex-col">
                  <div
                    class="flex-1 space-y-4 overflow-y-auto p-5"
                    data-testid="chat-transcript"
                  >
                    <Show when={emptyConversation()}>
                      <div
                        class="mx-auto flex min-h-[360px] max-w-xl flex-col items-center justify-center text-center"
                        data-testid="chat-empty-state"
                      >
                        <div class="flex h-12 w-12 items-center justify-center rounded-2xl bg-[var(--accent)]/10 text-[var(--accent)]">
                          <Bot aria-hidden="true" size={24} />
                        </div>
                        <h3 class="mt-4 text-lg font-semibold">
                          What can we work on?
                        </h3>
                        <p class="mt-2 max-w-md text-sm text-[var(--text-muted)]">
                          Start a conversation with {personaName()}, or choose a
                          prompt to get moving.
                        </p>
                        <div class="mt-6 grid w-full gap-2 sm:grid-cols-3">
                          <For
                            each={[
                              "Help me plan a new feature",
                              "Review an approach for bugs",
                              "Explain this codebase to me",
                            ]}
                          >
                            {(prompt, index) => (
                              <button
                                type="button"
                                class="rounded-xl border border-[var(--border)] bg-[var(--panel-muted)]/45 px-3 py-3 text-left text-xs leading-relaxed transition hover:border-[var(--accent)] hover:bg-[var(--accent)]/5"
                                onClick={() => {
                                  setDraft(prompt);
                                  focusComposer();
                                }}
                                data-testid="chat-prompt-suggestion"
                                data-prompt-index={index()}
                              >
                                {prompt}
                              </button>
                            )}
                          </For>
                        </div>
                      </div>
                    </Show>

                    <For each={document()?.entries ?? []}>
                      {(entry) => {
                        const content = embeddedContent(entry);
                        return (
                          <Show
                            when={content}
                            fallback={
                              <Show
                                when={
                                  entry.role === "tool" ||
                                  entry.role === "event"
                                }
                                fallback={
                                  <div
                                    class="max-w-[85%] rounded-2xl border border-[var(--border)] px-4 py-3 text-sm"
                                    classList={{
                                      "ml-auto bg-[var(--accent)]/10":
                                        entry.role === "user",
                                      "bg-[var(--panel-muted)]":
                                        entry.role === "assistant",
                                      "mx-auto border-transparent bg-transparent text-xs text-[var(--text-muted)]":
                                        entry.role === "system",
                                    }}
                                    data-testid="chat-message"
                                    data-message-id={entry.id}
                                    data-role={entry.role}
                                  >
                                    <p class="whitespace-pre-wrap">
                                      {entry.content}
                                    </p>
                                  </div>
                                }
                              >
                                <details
                                  class="group mx-auto w-full max-w-[92%] rounded-lg px-2 py-1 text-xs text-[var(--text-subtle)] open:bg-[var(--panel-muted)]/45"
                                  data-testid="chat-message"
                                  data-message-id={entry.id}
                                  data-role={entry.role}
                                >
                                  <summary class="cursor-pointer py-1.5 transition hover:text-[var(--text-muted)]">
                                    {activityLabel(entry)}
                                  </summary>
                                  <p class="border-l border-[var(--border)] py-2 pl-3 pr-2 whitespace-pre-wrap text-[var(--text-muted)]">
                                    {entry.content}
                                  </p>
                                </details>
                              </Show>
                            }
                          >
                            {(snapshot) => (
                              <EmbeddedContent content={snapshot()} />
                            )}
                          </Show>
                        );
                      }}
                    </For>
                    <Show when={streaming()}>
                      {(content) => (
                        <div
                          class="max-w-[85%] rounded-2xl border border-[var(--accent)]/30 bg-[var(--panel-muted)] px-4 py-3 text-sm whitespace-pre-wrap"
                          data-testid="chat-streaming-message"
                        >
                          {content()}
                        </div>
                      )}
                    </Show>
                  </div>

                  <Show when={error()}>
                    {(message) => (
                      <p
                        class="px-5 pb-2 text-xs text-[var(--danger)]"
                        role="alert"
                      >
                        {message()}
                      </p>
                    )}
                  </Show>

                  <Show when={document()}>
                    <details
                      class="border-t border-[var(--border)] bg-[var(--panel-muted)]/20"
                      data-testid="chat-advanced-conversation"
                    >
                      <summary class="cursor-pointer px-5 py-2.5 text-xs font-medium text-[var(--text-muted)] hover:text-[var(--text)]">
                        Advanced conversation
                      </summary>
                      <div class="grid gap-2 border-t border-[var(--border)] px-5 py-3 sm:grid-cols-[minmax(0,1fr)_auto]">
                        <label class="sr-only" for="chat-subagent-task">
                          Task for child chat
                        </label>
                        <input
                          id="chat-subagent-task"
                          value={subAgentTask()}
                          onInput={(event) =>
                            setSubAgentTask(event.currentTarget.value)
                          }
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              void spawnSubAgent();
                            }
                          }}
                          class="w-full rounded-lg border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-xs outline-none focus:border-[var(--accent)]"
                          placeholder="Delegate a task to a child chat"
                          data-testid="chat-subagent-task"
                        />
                        <button
                          type="button"
                          class="rounded-lg border border-[var(--border)] px-3 py-2 text-xs hover:border-[var(--accent)] disabled:opacity-40"
                          disabled={
                            !subAgentTask().trim() || spawningSubAgent()
                          }
                          onClick={() => void spawnSubAgent()}
                          data-testid="chat-spawn-subagent"
                        >
                          {spawningSubAgent()
                            ? "Creating child chat…"
                            : "Create child chat"}
                        </button>
                      </div>
                    </details>
                  </Show>

                  <div class="flex gap-3 border-t border-[var(--border)] p-4">
                    <textarea
                      ref={(element) => {
                        composerInput = element;
                      }}
                      rows="2"
                      value={draft()}
                      onInput={(event) => setDraft(event.currentTarget.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && !event.shiftKey) {
                          event.preventDefault();
                          void send();
                        }
                      }}
                      class="min-w-0 flex-1 resize-none rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2.5 text-sm outline-none transition focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent)]/15"
                      placeholder={
                        document()
                          ? "Reply to this conversation"
                          : "What would you like to work on?"
                      }
                      aria-label="Message"
                      data-testid="chat-composer-input"
                    />
                    <button
                      type="button"
                      class="self-end rounded-xl bg-[var(--accent)] p-3 text-[var(--background)] disabled:opacity-40"
                      disabled={
                        !draft().trim() ||
                        sending() ||
                        (!document() && !composingNew())
                      }
                      onClick={() => void send()}
                      data-testid="chat-send"
                      aria-label={sending() ? "Sending message" : "Send message"}
                    >
                      <Send aria-hidden="true" size={17} />
                    </button>
                  </div>
                </main>

                <Show when={workspaceOpen() && document()}>
                  <aside
                    id="chat-workspace-browser"
                    class="w-72 shrink-0 overflow-y-auto border-l border-[var(--border)] bg-[var(--panel-muted)]/30 p-4"
                    data-testid="chat-workspace-browser"
                  >
                    <div class="flex items-center justify-between gap-2">
                      <div class="flex items-center gap-2">
                        <FolderOpen
                          aria-hidden="true"
                          size={17}
                          class="text-[var(--accent)]"
                        />
                        <h3 class="text-sm font-semibold">Workspace files</h3>
                      </div>
                      <button
                        type="button"
                        class="rounded-md px-2 py-1 text-[10px] text-[var(--text-subtle)] hover:bg-[var(--panel)] hover:text-[var(--text)]"
                        onClick={() => setWorkspaceOpen(false)}
                        data-testid="chat-workspace-close"
                      >
                        Close
                      </button>
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
                </Show>
              </div>
            </div>
          </div>
          <Portal>
            <Show keyed when={deleteCandidate()}>
              {(candidate) => (
                <div
                class="fixed inset-0 z-50 grid place-items-center bg-black/65 p-5 backdrop-blur-sm"
                role="alertdialog"
                aria-modal="true"
                aria-labelledby="chat-delete-title"
                aria-describedby="chat-delete-description"
                data-testid="chat-delete-confirm"
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault();
                    closeDeleteConfirmation();
                    return;
                  }
                  if (event.key !== "Tab") {
                    return;
                  }
                  if (
                    event.shiftKey &&
                    globalThis.document.activeElement === deleteCancelButton
                  ) {
                    event.preventDefault();
                    deleteConfirmButton?.focus();
                  } else if (
                    !event.shiftKey &&
                    globalThis.document.activeElement === deleteConfirmButton
                  ) {
                    event.preventDefault();
                    deleteCancelButton?.focus();
                  }
                }}
              >
                <Panel class="w-full max-w-md">
                  <p class="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--danger)]">
                    Delete conversation
                  </p>
                  <h3 id="chat-delete-title" class="mt-2 text-xl font-semibold">
                    Delete “{displayTitle(candidate.title)}”?
                  </h3>
                  <p
                    id="chat-delete-description"
                    class="mt-3 text-sm leading-6 text-[var(--text-muted)]"
                  >
                    This chat and its generated files will be permanently removed.
                  </p>
                  <div class="mt-6 flex justify-end gap-3">
                    <Button
                      ref={(element) => {
                        deleteCancelButton = element;
                      }}
                      type="button"
                      variant="secondary"
                      onClick={() => closeDeleteConfirmation()}
                      data-testid="chat-delete-cancel"
                    >
                      Keep chat
                    </Button>
                    <Button
                      ref={(element) => {
                        deleteConfirmButton = element;
                      }}
                      type="button"
                      variant="danger"
                      onClick={() => {
                        closeDeleteConfirmation(false);
                        void deleteSession(candidate.id);
                      }}
                      data-testid="chat-delete-confirm-action"
                    >
                      Delete chat
                    </Button>
                  </div>
                </Panel>
                </div>
              )}
            </Show>
          </Portal>
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
          model ? "Assistant ready" : "Choose an available model to continue",
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
          setStatus("Default assistant saved");
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
          setStatus("Custom assistant created");
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
              <h3 class="text-xl font-semibold">Choose your assistant</h3>
              <p class="text-xs text-[var(--text-muted)]">
                Pick who Borg should use for new conversations. The recommended
                defaults are ready to go.
              </p>
            </div>
          </div>
          <label class="mt-5 block text-sm text-[var(--text-muted)]">
            Model
            <select
              value={selectedModel()}
              onFocus={() => void load()}
              onChange={(event) =>
                void chooseModel(event.currentTarget.value)
              }
              class="mt-2 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2"
              data-testid="wizard-model-select"
            >
              <For each={models()}>
                {(model) => (
                  <option value={model.preferenceId}>
                    {displayModelName(model)}
                  </option>
                )}
              </For>
            </select>
          </label>
          <label class="mt-4 block text-sm text-[var(--text-muted)]">
            Assistant
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
              Create a custom assistant
            </summary>
            <input
              value={name()}
              onInput={(event) => setName(event.currentTarget.value)}
              class="mt-4 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm"
              placeholder="Assistant name"
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
              <p class="text-sm font-semibold">Active chats</p>
              <p class="text-xs text-[var(--text-muted)]">
                <span data-testid="flightdeck-active-session-count">
                  {activeSessions().length}
                </span>{" "}
                thinking or waiting for input
              </p>
            </div>
          </div>
          <For each={activeSessions()}>
            {(session) => (
              <p class="mt-3 truncate text-xs text-[var(--text-muted)]">
                {displayTitle(session.title)}
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
      placement: "primary",
      component: ChatWorkspace,
    });
    const wizard = context.ui.registerWizardStep({
      id: "borg.chat.persona",
      label: "Choose assistant",
      order: 30,
      required: true,
      isComplete: personaReady,
      component: PersonaSetup,
    });
    const settings = context.ui.registerSettingsPage({
      id: "borg.chat.personas",
      label: "Assistants",
      order: 10,
      component: PersonaSetup,
    });
    const widget = context.ui.registerFlightDeckWidget({
      id: "borg.chat.active-sessions",
      label: "Active chats",
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
