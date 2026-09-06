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
  executionIdSchema,
  modelOperationPrefixSchema,
  type ChatEntry,
  type ChatSession,
  type ChatUsage,
  type LoopEvent,
  type LoopRunSnapshot,
  type ExecutionId,
} from "@borg/contracts";
import {
  definePlugin,
  type Disposable,
  type JsonValue,
  z,
} from "@borg/plugin-sdk";
import { randomUUID } from "node:crypto";

type ChatDocument = z.infer<typeof chatDocumentSchema>;
const legacyPersistedChatDocumentSchema = z
  .object({
    version: z.literal(1),
    document: chatDocumentSchema,
  })
  .strict();

const chatSecurityStateSchema = z
  .object({
    headExecutionId: executionIdSchema,
    active: z
      .object({
        turnId: z.string().uuid(),
        executionId: executionIdSchema,
        operationPrefix: modelOperationPrefixSchema,
        runId: z.string().uuid().optional(),
      })
      .strict()
      .optional(),
    pendingClose: z
      .object({
        executionId: executionIdSchema,
        outcome: z.enum(["completed", "failed", "cancelled"]),
        reason: z.string().min(1),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.active && value.pendingClose) {
      context.addIssue({
        code: "custom",
        message:
          "Chat security cannot be active and pending close together",
      });
    }
  });

type ChatSecurityState = z.infer<typeof chatSecurityStateSchema>;

const persistedChatRecordSchema = z
  .object({
    version: z.literal(2),
    document: chatDocumentSchema,
    security: chatSecurityStateSchema,
  })
  .strict();

interface ChatRecord {
  readonly document: ChatDocument;
  readonly security: ChatSecurityState;
}

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
    "executions.manage",
    "loops.start",
    "memory.write",
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
    const records = new Map<string, ChatRecord>();
    const queues = new Map<string, Promise<void>>();
    const runSubscriptions = new Map<string, Disposable>();

    const persist = async (
      document: ChatDocument,
      security?: ChatSecurityState,
    ): Promise<void> => {
      const resolvedSecurity =
        security ?? records.get(document.session.id)?.security;
      if (!resolvedSecurity) {
        throw new Error(
          `Chat session ${document.session.id} has no execution security state`,
        );
      }
      await context.store.set(
        `sessions/${document.session.id}`,
        asJsonValue({
          version: 2,
          document,
          security: resolvedSecurity,
        }),
      );
    };

    const persistTerminal = async (
      document: ChatDocument,
      security: ChatSecurityState,
    ): Promise<void> => {
      let failure: unknown;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          await persist(document, security);
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

    const closePending = async (record: ChatRecord): Promise<void> => {
      if (!record.security.pendingClose) {
        return;
      }
      const execution = await context.executions.bind({
        mode: "resume",
        executionId: record.security.pendingClose.executionId,
      });
      await execution.close({
        outcome: record.security.pendingClose.outcome,
        reason: record.security.pendingClose.reason,
      });
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
      const record = records.get(sessionId);
      if (!record) {
        throw new Error(`Chat session ${sessionId} is unavailable`);
      }
      const document = record.document;
      const next = chatDocumentSchema.parse({
        session: {
          ...document.session,
          updatedAt: new Date().toISOString(),
        },
        entries: [...document.entries, entry],
      });
      await persist(next);
      records.set(sessionId, { ...record, document: next });
      await context.bus.emit(chatMessageAppended, { sessionId, entry });
    };

    const updateSession = async (
      sessionId: string,
      patch: Readonly<Partial<ChatSession>>,
    ): Promise<ChatDocument> => {
      const record = records.get(sessionId);
      if (!record) {
        throw new Error(`Chat session ${sessionId} is unavailable`);
      }
      const document = record.document;
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
      records.set(sessionId, { ...record, document: next });
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
        (snapshot.status !== "completed" &&
          snapshot.status !== "failed" &&
          snapshot.status !== "cancelled")
      ) {
        return;
      }
      const record = records.get(sessionId);
      const active = record?.security.active;
      if (
        !record ||
        record.document.session.activeRunId !== runId ||
        active?.runId !== runId
      ) {
        return;
      }
      const document = record.document;
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
      const nextSecurity = chatSecurityStateSchema.parse({
        headExecutionId: active.executionId,
        pendingClose: {
          executionId: active.executionId,
          outcome: snapshot.status,
          reason: `Chat turn ${active.turnId} ${snapshot.status}`,
        },
      });
      try {
        await persistTerminal(next, nextSecurity);
        records.set(sessionId, {
          document: next,
          security: nextSecurity,
        });
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
        records.set(sessionId, {
          document: volatile,
          security: nextSecurity,
        });
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
      const turnExecution = await context.executions.bind({
        mode: "resume",
        executionId: active.executionId,
      });
      await turnExecution.close({
        outcome: snapshot.status,
        reason: `Chat turn ${active.turnId} ${snapshot.status}`,
      });
      const closedSecurity = chatSecurityStateSchema.parse({
        headExecutionId: active.executionId,
      });
      await persist(next, closedSecurity);
      records.set(sessionId, {
        document: next,
        security: closedSecurity,
      });
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
        const document = records.get(sessionId)?.document;
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
      const current = persistedChatRecordSchema.safeParse(stored.value);
      const document = current.success
        ? current.data.document
        : stored.value &&
            typeof stored.value === "object" &&
            !Array.isArray(stored.value) &&
            "version" in stored.value
          ? legacyPersistedChatDocumentSchema.parse(stored.value).document
          : chatDocumentSchema.parse(stored.value);
      const legacyExecution = current.success
        ? undefined
        : await context.executions.bind({
            mode: "root",
            subject: {
              kind: "chat-session",
              id: document.session.id,
            },
            classification: "restricted",
            provenance: {
              kind: "legacy",
              id: `chat-session:${document.session.id}`,
            },
          });
      const security = current.success
        ? current.data.security
        : chatSecurityStateSchema.parse({
            headExecutionId: legacyExecution?.id,
          });
      if (security.pendingClose) {
        const pendingExecution = await context.executions.bind({
          mode: "resume",
          executionId: security.pendingClose.executionId,
        });
        await pendingExecution.close({
          outcome: security.pendingClose.outcome,
          reason: security.pendingClose.reason,
        });
      }
      context.workspace.allocate(document.session.id);
      const interrupted =
        security.active !== undefined ||
        document.session.activeRunId ||
        ["running", "waiting"].includes(document.session.status);
      const recovered = interrupted
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
      const recoveredSecurity = chatSecurityStateSchema.parse({
        headExecutionId:
          security.pendingClose?.executionId ??
          security.active?.executionId ??
          security.headExecutionId,
      });
      const record = {
        document: recovered,
        security: recoveredSecurity,
      } satisfies ChatRecord;
      records.set(recovered.session.id, record);
      if (!current.success || interrupted || security.pendingClose) {
        await persist(recovered, recoveredSecurity);
      }
      const head = await context.executions.bind({
        mode: "resume",
        executionId: recoveredSecurity.headExecutionId,
      });
      if ((await head.summary()).lifecycle.state === "open") {
        await head.close({
          outcome: interrupted ? "interrupted" : "completed",
          reason: interrupted
            ? `Chat session ${recovered.session.id} recovered an interrupted turn`
            : `Chat session ${recovered.session.id} security seed committed`,
        });
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
      const current = records.get(sessionId);
      if (!current) {
        throw new Error(`Chat session ${sessionId} is unavailable`);
      }
      const turnId = randomUUID();
      const parent = await context.executions.grant(
        current.security.headExecutionId,
      );
      const turn = await context.executions.bind({
        mode: "child",
        subject: {
          kind: "chat-turn",
          id: `${sessionId}/${turnId}`,
        },
        parent,
      });
      await turn.observe({
        classification: "internal",
        provenance: {
          kind: "user",
          id: `chat-turn:${turnId}`,
        },
        reason: `User started chat turn ${turnId}`,
      });
      const operationPrefix =
        modelOperationPrefixSchema.parse(
          `chat/session/${sessionId}/turn/${turnId}`,
        );
      const preparedSecurity = chatSecurityStateSchema.parse({
        headExecutionId: current.security.headExecutionId,
        active: {
          turnId,
          executionId: turn.id,
          operationPrefix,
        },
      });
      const preparedDocument = chatDocumentSchema.parse({
        ...current.document,
        session: {
          ...current.document.session,
          status: "running",
          activeRunId: undefined,
          updatedAt: new Date().toISOString(),
        },
      });
      await persist(preparedDocument, preparedSecurity);
      await closePending(current);
      records.set(sessionId, {
        document: preparedDocument,
        security: preparedSecurity,
      });
      let run: Awaited<ReturnType<typeof context.loops.start>>;
      try {
        run = await context.loops.start({
          prompt: text,
          personaId: current.document.session.personaId,
          sessionId,
          conversation,
          security: {
            kind: "bound",
            executionId: turn.id,
            operationPrefix,
          },
        });
      } catch (error) {
        const failedSecurity = chatSecurityStateSchema.parse({
          headExecutionId: turn.id,
        });
        const failedDocument = chatDocumentSchema.parse({
          ...preparedDocument,
          session: {
            ...preparedDocument.session,
            status: "error",
            activeRunId: undefined,
            updatedAt: new Date().toISOString(),
          },
        });
        await persist(failedDocument, failedSecurity);
        records.set(sessionId, {
          document: failedDocument,
          security: failedSecurity,
        });
        await turn.close({
          outcome: "failed",
          reason: `Chat turn ${turnId} could not start`,
        });
        await append(
          sessionId,
          createEntry("event", `The turn could not start: ${String(error)}`, {
            status: "failed_to_start",
          }),
        );
        throw error;
      }
      try {
        // Write after start so this turn's assemble cannot recall the same user text.
        await context.memory.write({
          text,
          personaId: current.document.session.personaId,
          sessionId,
        });
      } catch (error) {
        context.logger.warn("Memory write failed", {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      const runningSecurity = chatSecurityStateSchema.parse({
        ...preparedSecurity,
        active: {
          ...preparedSecurity.active,
          runId: run.id,
        },
      });
      const running = chatDocumentSchema.parse({
        ...preparedDocument,
        session: {
          ...preparedDocument.session,
          activeRunId: run.id,
          updatedAt: new Date().toISOString(),
        },
      });
      try {
        await persist(running, runningSecurity);
        records.set(sessionId, {
          document: running,
          security: runningSecurity,
        });
      } catch (error) {
        context.loops.cancel(run.id);
        const failedSecurity = chatSecurityStateSchema.parse({
          headExecutionId: turn.id,
          pendingClose: {
            executionId: turn.id,
            outcome: "cancelled",
            reason: `Chat turn ${turnId} lost its run link`,
          },
        });
        const failedDocument = chatDocumentSchema.parse({
          ...preparedDocument,
          session: {
            ...preparedDocument.session,
            status: "error",
            activeRunId: undefined,
            updatedAt: new Date().toISOString(),
          },
        });
        await persist(failedDocument, failedSecurity);
        records.set(sessionId, {
          document: failedDocument,
          security: failedSecurity,
        });
        await turn.close({
          outcome: "cancelled",
          reason: `Chat turn ${turnId} lost its run link`,
        });
        const closedSecurity = chatSecurityStateSchema.parse({
          headExecutionId: turn.id,
        });
        await persist(failedDocument, closedSecurity);
        records.set(sessionId, {
          document: failedDocument,
          security: closedSecurity,
        });
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
      const parentRecord = input.parentSessionId
        ? records.get(input.parentSessionId)
        : undefined;
      if (input.parentSessionId && !parentRecord) {
        throw new Error(
          `Parent chat session ${input.parentSessionId} is unavailable`,
        );
      }
      const now = new Date().toISOString();
      const sessionId = randomUUID();
      const initialMessage = input.initialMessage?.trim();
      const initialEntry = initialMessage
        ? createEntry("user", initialMessage)
        : undefined;
      const session = chatSessionSchema.parse({
        id: sessionId,
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
      const execution = parentRecord
        ? await context.executions.bind({
            mode: "child",
            subject: {
              kind: "chat-session",
              id: sessionId,
            },
            parent: await context.executions.grant(
              parentRecord.security.headExecutionId,
            ),
          })
        : await context.executions.bind({
            mode: "root",
            subject: {
              kind: "chat-session",
              id: sessionId,
            },
            classification: "internal",
            provenance: {
              kind: "user",
              id: `chat-session:${sessionId}`,
            },
          });
      const security = chatSecurityStateSchema.parse({
        headExecutionId: execution.id,
      });
      context.workspace.allocate(session.id);
      try {
        await persist(document, security);
        records.set(session.id, { document, security });
      } catch (error) {
        await context.workspace.release(session.id).catch(() => undefined);
        await execution.close({
          outcome: "deleted",
          reason: `Chat session ${sessionId} could not be persisted`,
        });
        throw error;
      }
      await execution.close({
        outcome: "completed",
        reason: `Chat session ${sessionId} was persisted`,
      });
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
        const record = records.get(sessionId);
        if (!record) {
          throw new Error(`Chat session ${sessionId} is unavailable`);
        }
        const document = record.document;
        if (document.session.activeRunId || record.security.active) {
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
        records.set(sessionId, { ...record, document: withUser });
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
      sessions: [...records.values()]
        .map(({ document }) => document.session)
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
      const document = records.get(sessionId)?.document;
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
        const record = records.get(sessionId);
        if (!record) {
          return { deleted: false };
        }
        const document = record.document;
        const children = [...records.values()].filter(
          ({ document: child }) =>
            child.session.parentSessionId === sessionId,
        );
        const detachedChildren = children.map((child) => ({
          ...child,
          document: chatDocumentSchema.parse({
            ...child.document,
            session: {
              ...child.document.session,
              parentSessionId: undefined,
              updatedAt: new Date().toISOString(),
            },
          }),
        }));
        await context.store.transaction([
          { type: "delete", key: `sessions/${sessionId}` },
          ...detachedChildren.map((child) => ({
            type: "set" as const,
            key: `sessions/${child.document.session.id}`,
            value: asJsonValue({
              version: 2,
              document: child.document,
              security: child.security,
            }),
          })),
        ]);
        for (const child of detachedChildren) {
          records.set(child.document.session.id, child);
        }
        records.delete(sessionId);
        const runId = document.session.activeRunId;
        if (runId) {
          context.loops.cancel(runId);
          await runSubscriptions.get(runId)?.dispose();
          runSubscriptions.delete(runId);
        }
        const executionIds = new Set<ExecutionId>([
          record.security.headExecutionId,
          ...(record.security.active
            ? [record.security.active.executionId]
            : []),
        ]);
        for (const executionId of executionIds) {
          const execution = await context.executions.bind({
            mode: "resume",
            executionId,
          });
          if ((await execution.summary()).lifecycle.state === "open") {
            await execution.close({
              outcome: "deleted",
              reason: `Chat session ${sessionId} was deleted`,
            });
          }
        }
        for (const child of detachedChildren) {
          await publishSession(child.document);
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
          const parent = records.get(parentSessionId)?.document;
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
              const child = records.get(childSessionId);
              records.delete(childSessionId);
              if (child) {
                const execution = await context.executions.bind({
                  mode: "resume",
                  executionId: child.security.headExecutionId,
                });
                if ((await execution.summary()).lifecycle.state === "open") {
                  await execution.close({
                    outcome: "deleted",
                    reason: `Child chat ${childSessionId} was rolled back`,
                  });
                }
              }
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
      if (!sessionId || !records.has(sessionId)) {
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
      if (!source.sessionId || !records.has(source.sessionId)) {
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
        if (!records.has(sessionId)) {
          return;
        }
        await enqueue(sessionId, async () => {
          const document = records.get(sessionId)?.document;
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
