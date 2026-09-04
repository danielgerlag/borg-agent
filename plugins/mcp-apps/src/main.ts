import {
  MCP_APP_RENDERER_ID,
  chatSessionDeleted,
  embeddedContentRegistered,
  mcpAppDiscovered,
  mcpAppSnapshotSchema,
  mcpAppToolResponded,
  mcpAppsCancelTool,
  mcpAppsInvokeTool,
  type CommandErrorCode,
  type McpAppSnapshot,
} from "@borg/contracts";
import {
  definePlugin,
  type Disposable,
} from "@borg/plugin-sdk";

interface ActiveInvocation {
  readonly appInstanceId: string;
  readonly controller: AbortController;
  readonly scope: Disposable;
}

function asJsonValue(value: unknown): McpAppSnapshot["callResult"] {
  return JSON.parse(
    JSON.stringify(value),
  ) as McpAppSnapshot["callResult"];
}

function commandError(error: unknown): {
  readonly code: CommandErrorCode;
  readonly message: string;
} {
  const candidate =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "failed";
  const code: CommandErrorCode = [
    "unavailable",
    "invalid_input",
    "invalid_output",
    "forbidden",
    "timeout",
    "failed",
  ].includes(candidate)
    ? (candidate as CommandErrorCode)
    : candidate === "invalid"
      ? "invalid_input"
      : candidate === "denied"
        ? "forbidden"
      : "failed";
  return {
    code,
    message: (
      error instanceof Error ? error.message : "MCP App tool call failed"
    ).slice(0, 1_000),
  };
}

export default definePlugin({
  id: "borg.mcp-apps",
  version: "0.1.0",
  engines: {
    borg: "^0.1.0",
  },
  permissions: [
    "personas.read",
    "tools.invoke",
    "ui.embeddedContent.render",
  ],
  contributes: {
    commands: [mcpAppsCancelTool.id, mcpAppsInvokeTool.id],
    events: [embeddedContentRegistered.id, mcpAppToolResponded.id],
    kinds: ["embeddedContentRenderer"],
  },
  async activate(context) {
    const apps = new Map<string, McpAppSnapshot>();
    const invocations = new Map<string, ActiveInvocation>();
    const discoveries = new Map<string, Promise<void>>();
    const deletedSessions = new Set<string>();

    for (const entry of await context.store.list("apps/")) {
      const parsed = mcpAppSnapshotSchema.safeParse(entry.value);
      if (parsed.success) {
        apps.set(parsed.data.appInstanceId, parsed.data);
      } else {
        await context.store.delete(entry.key);
      }
    }

    const publish = async (snapshot: McpAppSnapshot): Promise<void> => {
      await context.bus.emit(embeddedContentRegistered, {
        sessionId: snapshot.sessionId,
        content: {
          instanceId: snapshot.appInstanceId,
          rendererId: MCP_APP_RENDERER_ID,
          title: snapshot.sourceToolName,
          payload: asJsonValue(snapshot),
          createdAt: snapshot.discoveredAt,
        },
      });
    };

    const discovered = context.bus.on(mcpAppDiscovered, async (candidate) => {
      const run = async (): Promise<void> => {
        if (deletedSessions.has(candidate.sessionId)) {
          return;
        }
        const snapshot = mcpAppSnapshotSchema.parse({
          ...candidate,
          version: 1,
        });
        const existing = apps.get(snapshot.appInstanceId);
        if (existing) {
          if (JSON.stringify(existing) !== JSON.stringify(snapshot)) {
            context.logger.warn("Ignored conflicting MCP App snapshot", {
              appInstanceId: snapshot.appInstanceId,
            });
          }
          return;
        }
        apps.set(snapshot.appInstanceId, snapshot);
        let stored = false;
        try {
          await context.store.set(
            `apps/${snapshot.appInstanceId}`,
            asJsonValue(snapshot),
          );
          stored = true;
          await publish(snapshot);
        } catch (error) {
          if (apps.get(snapshot.appInstanceId) === snapshot) {
            apps.delete(snapshot.appInstanceId);
          }
          if (stored) {
            await context.store
              .delete(`apps/${snapshot.appInstanceId}`)
              .catch((rollbackError: unknown) => {
                context.logger.warn("Could not roll back MCP App snapshot", {
                  appInstanceId: snapshot.appInstanceId,
                  error:
                    rollbackError instanceof Error
                      ? rollbackError.message
                      : "Store rollback failed",
                });
              });
          }
          throw error;
        }
      };
      const previous = discoveries.get(candidate.appInstanceId);
      const operation = previous ? previous.then(run, run) : run();
      discoveries.set(candidate.appInstanceId, operation);
      try {
        await operation;
      } finally {
        if (discoveries.get(candidate.appInstanceId) === operation) {
          discoveries.delete(candidate.appInstanceId);
        }
      }
    });

    const deleted = context.bus.on(chatSessionDeleted, async ({ sessionId }) => {
      deletedSessions.add(sessionId);
      await Promise.allSettled(
        [...apps.values()]
          .filter((snapshot) => snapshot.sessionId === sessionId)
          .map((snapshot) => discoveries.get(snapshot.appInstanceId))
          .filter(
            (operation): operation is Promise<void> =>
              operation !== undefined,
          ),
      );
      const matches = [...apps.values()].filter(
        (snapshot) => snapshot.sessionId === sessionId,
      );
      if (matches.length === 0) {
        return;
      }
      await context.store.transaction(
        matches.map((snapshot) => ({
          type: "delete",
          key: `apps/${snapshot.appInstanceId}`,
        })),
      );
      for (const snapshot of matches) {
        apps.delete(snapshot.appInstanceId);
      }
      const removed = new Set(matches.map(({ appInstanceId }) => appInstanceId));
      const scopes: Promise<void>[] = [];
      for (const [invocationId, invocation] of invocations) {
        if (removed.has(invocation.appInstanceId)) {
          invocation.controller.abort(new Error("MCP App session was deleted"));
          scopes.push(Promise.resolve(invocation.scope.dispose()));
          invocations.delete(invocationId);
        }
      }
      await Promise.allSettled(scopes);
    });

    const invoke = context.bus.handle(
      mcpAppsInvokeTool,
      async (input, signal) => {
        const snapshot = apps.get(input.appInstanceId);
        if (!snapshot) {
          throw new Error(`MCP App ${input.appInstanceId} is unavailable`);
        }
        const tool = snapshot.tools.find(({ name }) => name === input.toolName);
        if (!tool) {
          throw new Error(
            `MCP App tool ${input.toolName} is unavailable to ${input.appInstanceId}`,
          );
        }
        if (invocations.has(input.invocationId)) {
          throw new Error(`MCP App invocation ${input.invocationId} already exists`);
        }

        const controller = new AbortController();
        const scope = context.tools.registerExecutionScope({
          runId: input.invocationId,
          sessionId: snapshot.sessionId,
          personaId: snapshot.personaId,
          allowedTools: [tool.toolId],
        });
        const active: ActiveInvocation = {
          appInstanceId: input.appInstanceId,
          controller,
          scope,
        };
        invocations.set(input.invocationId, active);
        const abort = (): void => controller.abort(signal.reason);
        if (signal.aborted) {
          abort();
        } else {
          signal.addEventListener("abort", abort, { once: true });
        }

        try {
          await scope.prepare();
          controller.signal.throwIfAborted();
          const result = asJsonValue(
            await context.tools.invoke(tool.toolId, input.arguments, {
              runId: input.invocationId,
              signal: controller.signal,
            }),
          );
          controller.signal.throwIfAborted();
          await context.bus.emit(mcpAppToolResponded, {
            appInstanceId: input.appInstanceId,
            invocationId: input.invocationId,
            requestId: input.requestId,
            response: { status: "succeeded", result },
            respondedAt: new Date().toISOString(),
          });
          return { requestId: input.requestId, result };
        } catch (error) {
          await context.bus.emit(mcpAppToolResponded, {
            appInstanceId: input.appInstanceId,
            invocationId: input.invocationId,
            requestId: input.requestId,
            response:
              signal.aborted || controller.signal.aborted
                ? { status: "cancelled" }
                : { status: "failed", error: commandError(error) },
            respondedAt: new Date().toISOString(),
          });
          throw error;
        } finally {
          signal.removeEventListener("abort", abort);
          invocations.delete(input.invocationId);
          await scope.dispose();
        }
      },
    );

    const cancel = context.bus.handle(
      mcpAppsCancelTool,
      async ({ appInstanceId, invocationId }) => {
        const active = invocations.get(invocationId);
        if (!active || active.appInstanceId !== appInstanceId) {
          return { cancelled: false };
        }
        active.controller.abort(new Error("MCP App tool call was cancelled"));
        await active.scope.dispose();
        return { cancelled: true };
      },
    );

    for (const snapshot of apps.values()) {
      await publish(snapshot);
    }

    return {
      dispose: async () => {
        for (const active of invocations.values()) {
          active.controller.abort(new Error("MCP Apps plugin was deactivated"));
        }
        cancel.dispose();
        invoke.dispose();
        deleted.dispose();
        discovered.dispose();
        await Promise.allSettled(discoveries.values());
        discoveries.clear();
        await Promise.allSettled(
          [...invocations.values()].map(({ scope }) => scope.dispose()),
        );
        invocations.clear();
      },
    };
  },
});
