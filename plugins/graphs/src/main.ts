import {
  channelInboundMessage,
  modelOperationPrefixSchema,
  type LoopEvent,
} from "@borg/contracts";
import {
  graphDefinitionDeleted,
  graphDefinitionSaved,
  graphDefinitionSchema,
  graphInstanceCompleted,
  graphInstanceFailed,
  graphInstanceSchema,
  graphInstanceStarted,
  graphInstanceUpdated,
  graphStepCompleted,
  graphsAssist,
  graphsCancelInstance,
  graphsDeleteDefinition,
  graphsGetDefinition,
  graphsGetInstance,
  graphsLaunch,
  graphsListCatalog,
  graphsListContributions,
  graphsListDefinitions,
  graphsListInstances,
  graphsListRunning,
  graphsSaveDefinition,
  type AssistQuestion,
  type GraphDefinition,
} from "./contract";
import {
  definePlugin,
  defineTool,
  z,
  type ExecutionBinding,
} from "@borg/plugin-sdk";
import { randomUUID } from "node:crypto";
import {
  AssistAskGate,
  GRAPH_ASK_USER_TOOL_ID,
  buildAssistLoopPrompt,
  formatAssistAnswer,
  parseAskUser,
  parseAssistedTurn,
} from "./assist";
import { GraphEngine } from "./executor";
import { builtInKinds } from "./kind-registry";

export default definePlugin({
  id: "borg.graphs",
  version: "0.1.0",
  engines: {
    borg: "^0.1.0",
  },
  permissions: [
    "executions.manage",
    "graphs.readContributions",
    "loops.start",
    "models.complete",
    "personas.read",
    "runtime.background",
    "scheduler.manage",
    "tools.invoke",
    "tools.register",
    "ui.flightDeck",
    "ui.settings",
    "ui.workspace",
    "workspace.manage",
  ],
  contributes: {
    commands: [
      graphsAssist.id,
      graphsCancelInstance.id,
      graphsDeleteDefinition.id,
      graphsGetDefinition.id,
      graphsGetInstance.id,
      graphsLaunch.id,
      graphsListCatalog.id,
      graphsListContributions.id,
      graphsListDefinitions.id,
      graphsListInstances.id,
      graphsListRunning.id,
      graphsSaveDefinition.id,
    ],
    events: [
      graphDefinitionDeleted.id,
      graphDefinitionSaved.id,
      graphInstanceCompleted.id,
      graphInstanceFailed.id,
      graphInstanceStarted.id,
      graphInstanceUpdated.id,
      graphStepCompleted.id,
    ],
    extensionPoints: [
      "borg.graphs.graphStep",
      "borg.graphs.graphTrigger",
    ],
    kinds: [
      "flightDeckWidget",
      "graphEngine",
      "settingsPage",
      "tool",
      "workspaceView",
    ],
  },
  async activate(context) {
    const engine = new GraphEngine(context);
    type LiveAssist = {
      readonly id: string;
      readonly execution: ExecutionBinding;
      readonly runId: string;
      readonly gate: AssistAskGate;
      readonly loopUnsubscribe: { dispose(): void };
      current?: GraphDefinition;
      fallbackQuestion?: AssistQuestion;
    };
    const liveAssists = new Map<string, LiveAssist>();
    const liveByRunId = new Map<string, LiveAssist>();
    let attaching:
      | {
          readonly id: string;
          readonly execution: ExecutionBinding;
          readonly gate: AssistAskGate;
          readonly current?: GraphDefinition;
        }
      | undefined;

    const closeLive = async (
      session: LiveAssist,
      outcome: "completed" | "failed" | "cancelled",
      reason: string,
    ): Promise<void> => {
      liveAssists.delete(session.id);
      liveByRunId.delete(session.runId);
      session.loopUnsubscribe.dispose();
      context.loops.cancel(session.runId);
      session.gate.fail(reason);
      await session.execution.close({ outcome, reason });
    };

    context.bus.handle(graphsSaveDefinition, async ({ definition }) => ({
      definition: await engine.saveDefinition(definition),
    }));
    context.bus.handle(graphsListDefinitions, async () => {
      await engine.refreshContributions();
      return { definitions: engine.listDefinitions() };
    });
    context.bus.handle(graphsListCatalog, () => ({
      tools: context.tools.listCatalog().map((tool) => ({
        id: tool.id,
        description: tool.description,
        inputSchema: z.json().parse(JSON.parse(JSON.stringify(tool.inputSchema))),
      })),
    }));
    context.bus.handle(graphsListContributions, () => ({
      contributions: [
        ...context.graphs.listTriggers().map(({ kind, label }) => ({
          kind,
          label,
          type: "trigger" as const,
        })),
        ...context.graphs.listSteps().map(({ kind, label, type }) => ({
          kind,
          label,
          type,
        })),
      ],
    }));
    context.bus.handle(graphsGetDefinition, async ({ graphId }) => {
      await engine.refreshContributions();
      return { definition: engine.getDefinition(graphId) };
    });
    context.bus.handle(graphsDeleteDefinition, async ({ graphId }) => ({
      deleted: await engine.deleteDefinition(graphId),
    }));
    context.bus.handle(graphsLaunch, async (input, _signal, envelope) => ({
      instanceId: await engine.launch({
        ...input,
        security: envelope.parentExecutionGrant
          ? {
              kind: "child",
              parent: envelope.parentExecutionGrant,
            }
          : {
              kind: "root",
              classification: "internal",
              provenance: {
                kind: "plugin",
                id: "borg.graphs.manual",
              },
            },
      }),
    }));
    context.bus.handle(graphsListRunning, ({ sessionId }) => ({
      instances: engine
        .listInstances(undefined, sessionId)
        .filter(
          ({ status }) => status === "running" || status === "waiting",
        ),
    }));
    context.bus.handle(graphsListInstances, ({ graphId }) => ({
      instances: engine.listInstances(graphId),
    }));
    context.bus.handle(graphsGetInstance, ({ instanceId }) => ({
      instance: engine.getInstance(instanceId),
    }));
    context.bus.handle(graphsCancelInstance, async ({ instanceId }) => ({
      cancelled: await engine.cancel(instanceId),
    }));
    const catalogContext = () => ({
      kinds: [
        ...builtInKinds.map(({ kind, label, type }) => ({
          kind,
          label,
          type,
        })),
        ...context.graphs.listTriggers().map(({ kind, label }) => ({
          kind,
          label,
          type: "trigger" as const,
        })),
        ...context.graphs.listSteps().map(({ kind, label, type }) => ({
          kind,
          label,
          type,
        })),
      ],
      tools: context.tools.listCatalog().map((tool) => ({
        id: tool.id,
        description: tool.description,
      })),
      personas: context.personas.list().map((persona) => ({
        id: persona.id,
        name: persona.name,
      })),
    });

    const turnFromState = async (
      session: LiveAssist,
    ): Promise<
      | {
          kind: "question";
          sessionId: string;
          summary: string;
          question: AssistQuestion;
        }
      | {
          kind: "graph";
          sessionId: string;
          summary: string;
          definition: GraphDefinition;
        }
    > => {
      const state = await session.gate.wait();
      if (state.kind === "question") {
        return {
          kind: "question",
          sessionId: session.id,
          summary: state.question.text,
          question: state.question,
        };
      }
      if (state.kind === "failed") {
        await closeLive(session, "failed", state.error);
        throw new Error(state.error);
      }
      const turn = parseAssistedTurn(state.output, session.current);
      if (turn.kind === "question") {
        session.fallbackQuestion = turn.question;
        return {
          kind: "question",
          sessionId: session.id,
          summary: turn.summary,
          question: turn.question,
        };
      }
      await closeLive(session, "completed", "Graph assist completed");
      return {
        kind: "graph",
        sessionId: session.id,
        summary: turn.summary,
        definition: turn.definition,
      };
    };

    const startAssistLoop = async (
      sessionId: string,
      prompt: string,
      current: GraphDefinition | undefined,
    ): Promise<LiveAssist> => {
      const execution = await context.executions.bind({
        mode: "root",
        subject: { kind: "graph-assist", id: sessionId },
        classification: "internal",
        provenance: { kind: "plugin", id: "borg.graphs" },
      });
      const gate = new AssistAskGate();
      attaching = {
        id: sessionId,
        execution,
        gate,
        ...(current !== undefined ? { current } : {}),
      };
      let snapshot;
      try {
        snapshot = await context.loops.start({
          prompt: buildAssistLoopPrompt({
            prompt,
            ...(current !== undefined ? { current } : {}),
            ...catalogContext(),
          }),
          personaId: context.personas.getDefault().id,
          allowedTools: [GRAPH_ASK_USER_TOOL_ID],
          security: {
            kind: "bound",
            executionId: execution.id,
            operationPrefix: modelOperationPrefixSchema.parse(
              `graph/assist/${execution.id}`,
            ),
          },
        });
      } finally {
        attaching = undefined;
      }
      const attachFinal = (event: LoopEvent): void => {
        if (event.type === "final") {
          gate.complete(event.output);
          return;
        }
        if (event.type === "failed") {
          gate.fail(event.error);
          return;
        }
        if (event.type === "state" && event.status === "completed") {
          const run = context.loops.get(snapshot.id);
          if (run?.output !== undefined) {
            gate.complete(run.output);
          }
        }
        if (
          event.type === "state" &&
          (event.status === "failed" || event.status === "cancelled")
        ) {
          const run = context.loops.get(snapshot.id);
          gate.fail(run?.error ?? `Assist ${event.status}`);
        }
      };
      const existing = context.loops.get(snapshot.id);
      if (existing?.status === "completed" && existing.output !== undefined) {
        gate.complete(existing.output);
      }
      if (
        existing?.status === "failed" ||
        existing?.status === "cancelled"
      ) {
        gate.fail(existing.error ?? `Assist ${existing.status}`);
      }
      const loopUnsubscribe = context.loops.subscribe(
        snapshot.id,
        attachFinal,
      );
      const session: LiveAssist = {
        id: sessionId,
        execution,
        runId: snapshot.id,
        gate,
        loopUnsubscribe,
        ...(current !== undefined ? { current } : {}),
      };
      liveAssists.set(sessionId, session);
      liveByRunId.set(snapshot.id, session);
      return session;
    };

    context.bus.handle(graphsAssist, async (input) => {
      if (input.kind === "cancel") {
        const session = liveAssists.get(input.sessionId);
        if (session !== undefined) {
          await closeLive(
            session,
            "cancelled",
            "Graph assist cancelled",
          );
        }
        return { kind: "cancelled" as const, sessionId: input.sessionId };
      }
      const parsedCurrent =
        input.current !== undefined
          ? graphDefinitionSchema.parse(input.current)
          : undefined;
      if (input.kind === "prompt") {
        const existing =
          input.sessionId !== undefined
            ? liveAssists.get(input.sessionId)
            : undefined;
        if (existing !== undefined) {
          const pending = existing.gate.snapshot();
          if (
            pending.kind === "question" ||
            existing.fallbackQuestion !== undefined
          ) {
            throw new Error("Answer the current question first");
          }
          await closeLive(
            existing,
            "cancelled",
            "Graph assist replaced",
          );
        }
        const session = await startAssistLoop(
          input.sessionId ?? randomUUID(),
          input.prompt,
          parsedCurrent,
        );
        return turnFromState(session);
      }
      const session = liveAssists.get(input.sessionId);
      if (session === undefined) {
        throw new Error("Unknown assist session");
      }
      if (parsedCurrent !== undefined) {
        session.current = parsedCurrent;
      }
      const parked = session.gate.snapshot();
      const question =
        parked.kind === "question"
          ? parked.question
          : session.fallbackQuestion;
      if (question === undefined) {
        throw new Error("Unknown assist question");
      }
      const spoken = formatAssistAnswer(question, {
        questionId: input.questionId,
        ...(input.text !== undefined ? { text: input.text } : {}),
        ...(input.choiceIds !== undefined
          ? { choiceIds: input.choiceIds }
          : {}),
      });
      if (parked.kind === "question") {
        session.gate.answer(input.questionId, spoken);
        return turnFromState(session);
      }
      await closeLive(session, "completed", "Graph assist continued");
      const continued = await startAssistLoop(
        input.sessionId,
        `The user answered:\n${spoken}\n\nContinue authoring the graph.`,
        parsedCurrent ?? session.current,
      );
      return turnFromState(continued);
    });

    context.tools.register(
      defineTool({
        id: GRAPH_ASK_USER_TOOL_ID,
        description:
          "Ask the user a clarifying question with optional choices while authoring a graph",
        input: z
          .object({
            question: z.string().trim().min(1).max(2_000),
            choices: z.array(z.string().trim().min(1)).max(8).optional(),
            allow_freeform: z.boolean().optional(),
            multi_select: z.boolean().optional(),
          })
          .strict(),
        output: z.object({ answer: z.string().min(1) }).strict(),
        approval: "auto",
        sideEffect: false,
        execute: async (input, execution) => {
          const runId = execution.runId;
          const session =
            (runId !== undefined ? liveByRunId.get(runId) : undefined) ??
            (attaching !== undefined
              ? {
                  id: attaching.id,
                  execution: attaching.execution,
                  runId: runId ?? attaching.id,
                  gate: attaching.gate,
                  loopUnsubscribe: { dispose() {} },
                  ...(attaching.current !== undefined
                    ? { current: attaching.current }
                    : {}),
                }
              : undefined);
          if (session === undefined) {
            throw new Error("Graph assist is not waiting for a question");
          }
          if (runId !== undefined) {
            liveByRunId.set(runId, session);
            liveAssists.set(session.id, session);
          }
          const question = parseAskUser(input);
          if (question === undefined) {
            throw new Error("graphs.ask input was invalid");
          }
          const answer = await session.gate.ask(question);
          return { answer };
        },
      }),
    );

    context.bus.on(channelInboundMessage, (payload) =>
      engine.handleInboundMessage(payload),
    );

    context.tools.register(
      defineTool({
        id: "graphs.list",
        description: "List saved graphs that can be launched",
        input: z.object({}).strict(),
        output: z
          .object({ definitions: z.array(graphDefinitionSchema) })
          .strict(),
        approval: "auto",
        sideEffect: false,
        execute: () => ({ definitions: engine.listDefinitions() }),
      }),
    );
    context.tools.register(
      defineTool({
        id: "graphs.run",
        description: "Launch a saved graph in the background",
        input: z
          .object({
            graphId: z.string().min(1),
            sessionId: z.string().uuid().optional(),
            input: z.record(z.string(), z.json()).default({}),
          })
          .strict(),
        output: z.object({ instanceId: z.string().uuid() }).strict(),
        approval: "auto",
        sideEffect: true,
        execute: (input, execution) =>
          context.bus.invoke(
            graphsLaunch,
            {
              graphId: input.graphId,
              input: input.input,
              trigger: "manual",
              ...(input.sessionId ?? execution.sessionId
                ? { sessionId: input.sessionId ?? execution.sessionId }
                : {}),
            },
            { signal: execution.signal },
          ),
      }),
    );
    context.tools.register(
      defineTool({
        id: "graphs.inspect",
        description: "Inspect a graph instance and its step checkpoints",
        input: z
          .object({ instanceId: z.string().uuid() })
          .strict(),
        output: z
          .object({ instance: graphInstanceSchema.nullable() })
          .strict(),
        approval: "auto",
        sideEffect: false,
        security: {
          outputClassification: "restricted",
          outputProvenance: "external",
        },
        execute: ({ instanceId }) => ({
          instance: engine.getInstance(instanceId),
        }),
      }),
    );

    await engine.initialize();
    return {
      dispose: async () => {
        await Promise.all(
          [...liveAssists.values()].map((session) =>
            closeLive(session, "cancelled", "Graph assist disposed"),
          ),
        );
        engine.dispose();
      },
    };
  },
});
