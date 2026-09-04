import {
  chatAppend,
  chatCreateSession,
  chatDeleteSession,
  chatDocumentSchema,
  chatEntrySchema,
  chatGetSession,
  chatListSessions,
  chatListWorkspace,
  chatMessageAppended,
  chatSendMessage,
  chatSessionDeleted,
  chatSessionSchema,
  chatSessionUpdated,
  chatSpawnSubAgent,
  chatTurnCompleted,
  chatTurnStarted,
  embeddedContentRegistered,
  embeddedContentSnapshotSchema,
  feedbackRequested,
  feedbackResolved,
  emptyChatUsage,
  type ChatEntry,
  type ChatSession,
  type ChatUsage,
  type LoopEvent,
  type LoopRunSnapshot,
} from "@borg/contracts";
import {
  definePlugin,
  type Disposable,
  type JsonValue,
  z,
} from "@borg/plugin-sdk";
import { randomUUID } from "node:crypto";

type ChatDocument = z.infer<typeof chatDocumentSchema>;
const persistedChatDocumentSchema = z
  .object({
    version: z.literal(1),
    document: chatDocumentSchema,
  })
  .strict();

function asJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function addUsage(base: ChatUsage, snapshot: LoopRunSnapshot): ChatUsage {
  const costsByCurrency: Record<string, number> = { ...base.costsByCurrency };
  for (const [currency, amount] of Object.entries(snapshot.costsByCurrency)) {
    costsByCurrency[currency] = (costsByCurrency[currency] ?? 0) + amount;
  }
  return {
    inputTokens: base.inputTokens + snapshot.inputTokens,
    outputTokens: base.outputTokens + snapshot.outputTokens,
    cachedInputTokens: base.cachedInputTokens + snapshot.cachedInputTokens,
    cacheWriteTokens: base.cacheWriteTokens + snapshot.cacheWriteTokens,
    costsByCurrency,
  };
}

function createEntry(
  role: ChatEntry["role"],
  content: string,
  metadata?: ChatEntry["metadata"],
): ChatEntry {
  return chatEntrySchema.parse({
    id: randomUUID(),
    role,
    content,
    metadata,
    createdAt: new Date().toISOString(),
  });
}

export default definePlugin({
  id: "borg.chat",
  version: "0.1.0",
  engines: {
    borg: "^0.1.0",
  },
  permissions: [
    "loops.start",
    "models.read",
    "personas.read",
    "personas.write",
    "tools.invoke",
    "ui.embeddedContent.consume",
    "ui.flightDeck",
    "ui.settings",
    "ui.wizard",
    "ui.workspace",
    "workspace.manage",
  ],
  contributes: {
    commands: [
      chatAppend.id,
      chatCreateSession.id,
      chatDeleteSession.id,
      chatGetSession.id,
      chatListSessions.id,
      chatListWorkspace.id,
      chatSendMessage.id,
      chatSpawnSubAgent.id,
    ],
    events: [
      chatMessageAppended.id,
      chatSessionDeleted.id,
      chatSessionUpdated.id,
      chatTurnCompleted.id,
      chatTurnStarted.id,
    ],
    kinds: [
      "flightDeckWidget",
      "settingsPage",
      "wizardStep",
      "workspaceView",
    ],
  },
  async activate(context) {
    const documents = new Map<string, ChatDocument>();
    const queues = new Map<string, Promise<void>>();
    const runSubscriptions = new Map<string, Disposable>();

    const persist = async (document: ChatDocument): Promise<void> => {
      await context.store.set(
        `sessions/${document.session.id}`,
        asJsonValue({ version: 1, document }),
      );
    };

    const persistTerminal = async (document: ChatDocument): Promise<void> => {
      let failure: unknown;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          await persist(document);
          return;
        } catch (error) {
          failure = error;
          if (attempt < 3) {
            await new Promise((resolve) => setTimeout(resolve, attempt * 25));
          }
        }
      }
      throw failure;
    };

    const enqueue = async <T>(
      sessionId: string,
      operation: () => Promise<T>,
    ): Promise<T> => {
      const previous = queues.get(sessionId) ?? Promise.resolve();
      let result: T | undefined;
      const pending = previous.then(async () => {
        result = await operation();
      });
      const tail = pending.then(
        () => undefined,
        () => undefined,
      );
      queues.set(sessionId, tail);
      try {
        await pending;
        return result as T;
      } finally {
        if (queues.get(sessionId) === tail) {
          queues.delete(sessionId);
        }
      }
    };

    const publishSession = async (document: ChatDocument): Promise<void> => {
      await context.bus.emit(chatSessionUpdated, {
        session: document.session,
      });
    };

    const append = async (
      sessionId: string,
      entry: ChatEntry,
    ): Promise<void> => {
      const document = documents.get(sessionId);
      if (!document) {
        throw new Error(`Chat session ${sessionId} is unavailable`);
      }
      const next = chatDocumentSchema.parse({
        session: {
          ...document.session,
          updatedAt: new Date().toISOString(),
        },
        entries: [...document.entries, entry],
      });
      await persist(next);
      documents.set(sessionId, next);
      await context.bus.emit(chatMessageAppended, { sessionId, entry });
    };

    const updateSession = async (
      sessionId: string,
      patch: Readonly<Partial<ChatSession>>,
    ): Promise<ChatDocument> => {
      const document = documents.get(sessionId);
      if (!document) {
        throw new Error(`Chat session ${sessionId} is unavailable`);
      }
      const session = chatSessionSchema.parse({
        ...document.session,
        ...patch,
        updatedAt: new Date().toISOString(),
      });
      const next = chatDocumentSchema.parse({
        session,
        entries: document.entries,
      });
      await persist(next);
      documents.set(sessionId, next);
      await publishSession(next);
      return next;
    };

    const completeRun = async (
      sessionId: string,
      runId: string,
    ): Promise<void> => {
      const snapshot = context.loops.get(runId);
      if (
        !snapshot ||
        !["completed", "failed", "cancelled"].includes(snapshot.status)
      ) {
        return;
      }
      const document = documents.get(sessionId);
      if (!document || document.session.activeRunId !== runId) {
        return;
      }
      let entry: ChatEntry | undefined;
      if (snapshot.status === "completed" && snapshot.output !== undefined) {
        entry = createEntry("assistant", snapshot.output, { runId });
      } else if (snapshot.status === "failed") {
        entry = createEntry(
          "event",
          snapshot.error ?? "The turn failed.",
          { runId, status: "failed" },
        );
      } else if (snapshot.status === "cancelled") {
        entry = createEntry("event", "The turn was cancelled.", {
          runId,
          status: "cancelled",
        });
      }
      const session = chatSessionSchema.parse({
        ...document.session,
        status: snapshot.status === "failed" ? "error" : "idle",
        activeRunId: undefined,
        usage: addUsage(document.session.usage ?? emptyChatUsage, snapshot),
        updatedAt: new Date().toISOString(),
      });
      const next = chatDocumentSchema.parse({
        session,
        entries: entry ? [...document.entries, entry] : document.entries,
      });
      try {
        await persistTerminal(next);
        documents.set(sessionId, next);
      } catch (error) {
        const persistenceEntry = createEntry(
          "event",
          "The turn finished, but its result could not be saved.",
          { runId, status: "persistence_failed" },
        );
        const volatile = chatDocumentSchema.parse({
          session: {
            ...session,
            status: "error",
          },
          entries: [
            ...(entry ? [...document.entries, entry] : document.entries),
            persistenceEntry,
          ],
        });
        documents.set(sessionId, volatile);
        if (entry) {
          await context.bus.emit(chatMessageAppended, { sessionId, entry });
        }
        await context.bus.emit(chatMessageAppended, {
          sessionId,
          entry: persistenceEntry,
        });
        await publishSession(volatile);
        context.logger.error(
          `Failed to persist terminal state for chat session ${sessionId}`,
          { error: String(error), runId },
        );
        await runSubscriptions.get(runId)?.dispose();
        runSubscriptions.delete(runId);
        return;
      }
      if (entry) {
        await context.bus.emit(chatMessageAppended, { sessionId, entry });
      }
      await publishSession(next);
      await context.bus.emit(chatTurnCompleted, {
        sessionId,
        runId,
        status: snapshot.status as "completed" | "failed" | "cancelled",
        output: snapshot.output,
        error: snapshot.error,
      });
      await runSubscriptions.get(runId)?.dispose();
      runSubscriptions.delete(runId);
    };

    const handleLoopEvent = async (
      sessionId: string,
      event: LoopEvent,
    ): Promise<void> => {
      await enqueue(sessionId, async () => {
        const document = documents.get(sessionId);
        if (!document || document.session.activeRunId !== event.runId) {
          return;
        }
        if (
          event.type === "state" &&
          ["completed", "failed", "cancelled"].includes(event.status)
        ) {
          await completeRun(sessionId, event.runId);
          return;
        }
        if (
          event.type === "state" &&
          ["running", "waiting"].includes(event.status) &&
          document.session.status !== event.status
        ) {
          await updateSession(sessionId, {
            status: event.status as "running" | "waiting",
          });
          return;
        }
        if (event.type === "tool_result") {
          await append(
            sessionId,
            createEntry("tool", JSON.stringify(event.output), {
              runId: event.runId,
              toolId: event.toolId,
              toolCallId: event.toolCallId,
            }),
          );
        }
      });
    };

    for (const stored of await context.store.list("sessions/")) {
      const document =
        stored.value &&
        typeof stored.value === "object" &&
        !Array.isArray(stored.value) &&
        "version" in stored.value
          ? persistedChatDocumentSchema.parse(stored.value).document
          : chatDocumentSchema.parse(stored.value);
      context.workspace.allocate(document.session.id);
      const interrupted =
        document.session.activeRunId ||
        ["running", "waiting"].includes(document.session.status);
      const recovered =
        interrupted
          ? chatDocumentSchema.parse({
              session: {
                ...document.session,
                status: "idle",
                activeRunId: undefined,
                updatedAt: new Date().toISOString(),
              },
              entries: [
                ...document.entries,
                createEntry(
                  "event",
                  "The previous turn was interrupted when Borg stopped.",
                  {
                    ...(document.session.activeRunId
                      ? { runId: document.session.activeRunId }
                      : {}),
                    status: "interrupted",
                  },
                ),
              ],
            })
          : document;
      documents.set(recovered.session.id, recovered);
      if (recovered !== document) {
        await persist(recovered);
      }
    }

    const startTurn = async (
      sessionId: string,
      text: string,
      conversation: {
        readonly role: "user" | "assistant";
        readonly content: string;
      }[],
    ): Promise<string> => {
      const current = documents.get(sessionId);
      if (!current) {
        throw new Error(`Chat session ${sessionId} is unavailable`);
      }
      let run: Awaited<ReturnType<typeof context.loops.start>>;
      try {
        run = await context.loops.start({
          prompt: text,
          personaId: current.session.personaId,
          sessionId,
          conversation,
        });
      } catch (error) {
        await append(
          sessionId,
          createEntry("event", `The turn could not start: ${String(error)}`, {
            status: "failed_to_start",
          }),
        );
        await updateSession(sessionId, { status: "error" });
        throw error;
      }
      let running: ChatDocument;
      try {
        running = await updateSession(sessionId, {
          status: "running",
          activeRunId: run.id,
        });
      } catch (error) {
        context.loops.cancel(run.id);
        throw error;
      }
      await context.bus.emit(chatTurnStarted, {
        sessionId,
        runId: run.id,
        personaId: running.session.personaId,
      });
      const subscription = context.loops.subscribe(run.id, (event) =>
        handleLoopEvent(sessionId, event),
      );
      runSubscriptions.set(run.id, subscription);
      return run.id;
    };

    const createSession = async (input: {
      readonly personaId?: string | undefined;
      readonly title?: string | undefined;
      readonly parentSessionId?: string | undefined;
      readonly initialMessage?: string | undefined;
    }): Promise<string> => {
      const persona = input.personaId
        ? context.personas.get(input.personaId)
        : context.personas.getDefault();
      if (!persona || persona.archived) {
        throw new Error(`Persona ${input.personaId} is unavailable`);
      }
      if (
        input.parentSessionId &&
        !documents.has(input.parentSessionId)
      ) {
        throw new Error(
          `Parent chat session ${input.parentSessionId} is unavailable`,
        );
      }
      const now = new Date().toISOString();
      const initialMessage = input.initialMessage?.trim();
      const initialEntry = initialMessage
        ? createEntry("user", initialMessage)
        : undefined;
      const session = chatSessionSchema.parse({
        id: randomUUID(),
        title:
          input.title ??
          (initialMessage?.slice(0, 48) || "New session"),
        personaId: persona.id,
        parentSessionId: input.parentSessionId,
        status: "idle",
        createdAt: now,
        updatedAt: now,
      });
      const document = chatDocumentSchema.parse({
        session,
        entries: initialEntry ? [initialEntry] : [],
      });
      context.workspace.allocate(session.id);
      try {
        await persist(document);
        documents.set(session.id, document);
      } catch (error) {
        await context.workspace.release(session.id).catch(() => undefined);
        throw error;
      }
      await publishSession(document);
      if (initialEntry && initialMessage) {
        await context.bus.emit(chatMessageAppended, {
          sessionId: session.id,
          entry: initialEntry,
        });
      }
      return session.id;
    };

    const sendMessage = async (
      sessionId: string,
      text: string,
    ): Promise<string> =>
      enqueue(sessionId, async () => {
        const document = documents.get(sessionId);
        if (!document) {
          throw new Error(`Chat session ${sessionId} is unavailable`);
        }
        if (document.session.activeRunId) {
          throw new Error(`Chat session ${sessionId} already has an active turn`);
        }
        const conversation = document.entries.flatMap((entry) =>
          entry.role === "user" || entry.role === "assistant"
            ? [{ role: entry.role, content: entry.content }]
            : [],
        );
        const userEntry = createEntry("user", text);
        const titledSession = chatSessionSchema.parse({
          ...document.session,
          title:
            document.session.title === "New session"
              ? text.trim().slice(0, 48) || "New session"
              : document.session.title,
          updatedAt: new Date().toISOString(),
        });
        const withUser = chatDocumentSchema.parse({
          session: titledSession,
          entries: [...document.entries, userEntry],
        });
        await persist(withUser);
        documents.set(sessionId, withUser);
        await context.bus.emit(chatMessageAppended, {
          sessionId,
          entry: userEntry,
        });
        return startTurn(sessionId, text, conversation);
      });

    context.bus.handle(chatCreateSession, async (input) => {
      const sessionId = await createSession(input);
      let startError: string | undefined;
      const initialMessage = input.initialMessage;
      if (initialMessage) {
        try {
          await enqueue(sessionId, () =>
            startTurn(sessionId, initialMessage, []),
          );
        } catch (error) {
          startError = error instanceof Error ? error.message : String(error);
        }
      }
      return {
        sessionId,
        ...(startError ? { startError } : {}),
      };
    });

    context.bus.handle(chatListSessions, (input) => ({
      sessions: [...documents.values()]
        .map(({ session }) => session)
        .filter((session) =>
          input.parentSessionId
            ? session.parentSessionId === input.parentSessionId
            : input.includeChildren || !session.parentSessionId,
        )
        .sort((left, right) =>
          right.updatedAt.localeCompare(left.updatedAt),
        ),
    }));

    context.bus.handle(chatGetSession, ({ sessionId }) => {
      const document = documents.get(sessionId);
      if (!document) {
        throw new Error(`Chat session ${sessionId} is unavailable`);
      }
      return document;
    });

    context.bus.handle(chatSendMessage, async ({ sessionId, text }) => ({
      runId: await sendMessage(sessionId, text),
    }));

    context.bus.handle(chatAppend, async ({ sessionId, entry }) => {
      const appended = createEntry(entry.role, entry.content, entry.metadata);
      await enqueue(sessionId, async () => append(sessionId, appended));
      return { messageId: appended.id };
    });

    context.bus.handle(chatDeleteSession, async ({ sessionId }) => {
      return enqueue(sessionId, async () => {
        const document = documents.get(sessionId);
        if (!document) {
          return { deleted: false };
        }
        const children = [...documents.values()].filter(
          ({ session }) => session.parentSessionId === sessionId,
        );
        const detachedChildren = children.map((child) =>
          chatDocumentSchema.parse({
            ...child,
            session: {
              ...child.session,
              parentSessionId: undefined,
              updatedAt: new Date().toISOString(),
            },
          }),
        );
        await context.store.transaction([
          { type: "delete", key: `sessions/${sessionId}` },
          ...detachedChildren.map((child) => ({
            type: "set" as const,
            key: `sessions/${child.session.id}`,
            value: asJsonValue({ version: 1, document: child }),
          })),
        ]);
        for (const child of detachedChildren) {
          documents.set(child.session.id, child);
        }
        documents.delete(sessionId);
        const runId = document.session.activeRunId;
        if (runId) {
          context.loops.cancel(runId);
          await runSubscriptions.get(runId)?.dispose();
          runSubscriptions.delete(runId);
        }
        for (const child of detachedChildren) {
          await publishSession(child);
        }
        await context.workspace.release(sessionId).catch((error: unknown) => {
          context.logger.warn(
            `Failed to remove workspace for deleted session ${sessionId}`,
            { error: String(error) },
          );
        });
        await context.bus.emit(chatSessionDeleted, { sessionId });
        return { deleted: true };
      });
    });

    context.bus.handle(chatListWorkspace, async ({ sessionId }) => ({
      files: [...(await context.workspace.listFiles(sessionId))],
    }));

    context.bus.handle(
      chatSpawnSubAgent,
      ({ parentSessionId, personaId, task }) =>
        enqueue(parentSessionId, async () => {
          const parent = documents.get(parentSessionId);
          if (!parent) {
            throw new Error(
              `Parent chat session ${parentSessionId} is unavailable`,
            );
          }
          const childSessionId = await createSession({
            parentSessionId,
            personaId: personaId ?? parent.session.personaId,
            title: `Agent: ${task.slice(0, 40)}`,
          });
          try {
            return {
              childSessionId,
              runId: await sendMessage(childSessionId, task),
            };
          } catch (error) {
            try {
              await context.store.delete(`sessions/${childSessionId}`);
              documents.delete(childSessionId);
              await context.workspace
                .release(childSessionId)
                .catch(() => undefined);
              await context.bus.emit(chatSessionDeleted, {
                sessionId: childSessionId,
              });
            } catch (cleanupError) {
              throw new AggregateError(
                [error, cleanupError],
                `Failed to start and roll back child session ${childSessionId}`,
              );
            }
            throw error;
          }
        }),
    );

    context.bus.on(feedbackRequested, async ({ interactionId, request }) => {
      const sessionId = request.source?.sessionId;
      if (!sessionId || !documents.has(sessionId)) {
        return;
      }
      await enqueue(sessionId, async () =>
        append(
          sessionId,
          createEntry("event", `Waiting for input: ${request.prompt}`, {
            interactionId,
            kind: "human_input",
          }),
        ),
      );
    });

    context.bus.on(feedbackResolved, async ({ interactionId, source, status }) => {
      if (!source.sessionId || !documents.has(source.sessionId)) {
        return;
      }
      await enqueue(source.sessionId, async () =>
        append(
          source.sessionId!,
          createEntry("event", `Input request ${status}.`, {
            interactionId,
            kind: "human_input",
            status,
          }),
        ),
      );
    });

    const embeddedContent = context.bus.on(
      embeddedContentRegistered,
      async ({ sessionId, content }) => {
        if (!documents.has(sessionId)) {
          return;
        }
        await enqueue(sessionId, async () => {
          const document = documents.get(sessionId);
          if (
            !document ||
            document.entries.some((entry) => {
              const parsed = embeddedContentSnapshotSchema.safeParse(
                entry.metadata?.embeddedContent,
              );
              return (
                parsed.success &&
                parsed.data.instanceId === content.instanceId
              );
            })
          ) {
            return;
          }
          await append(
            sessionId,
            createEntry("event", `Interactive content: ${content.title}`, {
              kind: "embedded_content",
              embeddedContent: content,
            }),
          );
        });
      },
    );

    return {
      dispose: async () => {
        embeddedContent.dispose();
        await Promise.allSettled(
          [...runSubscriptions.values()].map(async (subscription) =>
            subscription.dispose(),
          ),
        );
        await Promise.allSettled(queues.values());
      },
    };
  },
});
