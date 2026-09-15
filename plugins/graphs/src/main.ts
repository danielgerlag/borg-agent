import {
  channelInboundMessage,
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
  type ModelMessage,
} from "@borg/contracts";
import { definePlugin, defineTool, z } from "@borg/plugin-sdk";
import { randomUUID } from "node:crypto";
import {
  applyAnswer,
  buildAssistMessages,
  createAssistSessions,
  formatAssistUserContent,
  generateAssistedTurn,
  withCurrentGraph,
  type AssistSession,
} from "./assist";
import { builtInKinds } from "./kind-registry";
import { GraphEngine } from "./executor";

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
    const assistSessions = createAssistSessions();

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
    context.bus.handle(graphsAssist, async (input, signal) => {
      const execution = await context.executions.bind({
        mode: "root",
        subject: { kind: "graph-assist", id: randomUUID() },
        classification: "internal",
        provenance: { kind: "plugin", id: "borg.graphs" },
      });
      let outcome: "completed" | "failed" = "failed";
      try {
        const kinds = [
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
        ];
        const tools = context.tools.listCatalog().map((tool) => ({
          id: tool.id,
          description: tool.description,
        }));
        const personas = context.personas.list().map((persona) => ({
          id: persona.id,
          name: persona.name,
        }));
        const parsedCurrent =
          input.current !== undefined
            ? graphDefinitionSchema.parse(input.current)
            : undefined;
        let completeIndex = 0;
        const complete = async (
          messages: readonly ModelMessage[],
        ): Promise<string> => {
          completeIndex += 1;
          const completion = await context.models.complete(
            {
              executionId: execution.id,
              operationKey: `graph/assist/${execution.id}/${completeIndex}`,
              personaId: context.personas.getDefault().id,
              messages,
            },
            signal,
          );
          if (
            completion.content === undefined ||
            completion.content.length === 0
          ) {
            throw new Error("The model returned no graph");
          }
          return completion.content;
        };
        const runTurn = async (
          session: AssistSession,
          current: GraphDefinition | undefined,
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
          const generated = await generateAssistedTurn({
            messages: session.messages,
            ...(current !== undefined ? { current } : {}),
            kinds,
            tools,
            personas,
            complete,
          });
          const turn = generated.turn;
          const messages: ModelMessage[] = [
            ...session.messages,
            { role: "assistant", content: generated.raw },
          ];
          if (turn.kind === "question") {
            assistSessions.save({
              id: session.id,
              messages,
              pendingQuestion: turn.question,
            });
            return {
              kind: "question",
              sessionId: session.id,
              summary: turn.summary,
              question: turn.question,
            };
          }
          assistSessions.save({
            id: session.id,
            messages,
          });
          return {
            kind: "graph",
            sessionId: session.id,
            summary: turn.summary,
            definition: turn.definition,
          };
        };
        if (input.kind === "prompt") {
          const existing =
            input.sessionId !== undefined
              ? assistSessions.get(input.sessionId)
              : undefined;
          if (existing !== undefined && existing.pendingQuestion !== undefined) {
            throw new Error("Answer the current question first");
          }
          const session: AssistSession =
            existing === undefined
              ? {
                  id: input.sessionId ?? randomUUID(),
                  messages: buildAssistMessages({
                    prompt: input.prompt,
                    ...(parsedCurrent !== undefined
                      ? { current: parsedCurrent }
                      : {}),
                    kinds,
                    tools,
                    personas,
                  }),
                }
              : {
                  id: existing.id,
                  messages: [
                    ...existing.messages,
                    {
                      role: "user",
                      content:
                        parsedCurrent === undefined
                          ? formatAssistUserContent(input.prompt)
                          : formatAssistUserContent(
                              input.prompt,
                              parsedCurrent,
                            ),
                    },
                  ],
                };
          const result = await runTurn(session, parsedCurrent);
          outcome = "completed";
          return result;
        }
        const existing = assistSessions.get(input.sessionId);
        if (existing === undefined) {
          throw new Error("Unknown assist session");
        }
        let session = applyAnswer(existing, {
          questionId: input.questionId,
          ...(input.text !== undefined ? { text: input.text } : {}),
          ...(input.choiceIds !== undefined
            ? { choiceIds: input.choiceIds }
            : {}),
        });
        if (parsedCurrent !== undefined) {
          session = withCurrentGraph(session, parsedCurrent);
        }
        const result = await runTurn(session, parsedCurrent);
        outcome = "completed";
        return result;
      } finally {
        await execution.close({
          outcome,
          reason:
            outcome === "completed"
              ? "Graph assist completed"
              : "Graph assist failed",
        });
      }
    });

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
      dispose: () => engine.dispose(),
    };
  },
});
