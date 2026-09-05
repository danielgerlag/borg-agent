import {
  dataClassificationSchema,
  defineCommand,
  executionIdSchema,
} from "@borg/contracts";
import {
  definePlugin,
  defineTool,
  z,
  type BorgPluginManifest,
} from "@borg/plugin-sdk";
import { describe, expect, it } from "vitest";
import { CommandEventBus, PluginManager } from "../src";
import { createSecurityRuntime } from "./security-runtime";

const launchChild = defineCommand({
  id: "test.launcher.launch-child",
  input: z.object({ childId: z.string().min(1) }).strict(),
  output: z
    .object({
      executionId: executionIdSchema,
      classification: dataClassificationSchema,
    })
    .strict(),
});

const forgeChild = defineCommand({
  id: "test.launcher.forge-child",
  input: z
    .object({
      childId: z.string().min(1),
      executionId: executionIdSchema,
    })
    .strict(),
  output: z.object({ executionId: executionIdSchema }).strict(),
});

const prepareScope = defineCommand({
  id: "test.launcher.prepare-scope",
  input: z
    .object({
      runId: z.string().min(1),
      executionId: executionIdSchema,
      sessionId: z.string().uuid(),
    })
    .strict(),
  output: z.object({ classification: dataClassificationSchema }).strict(),
});

const readScope = defineCommand({
  id: "test.launcher.read-scope",
  input: z
    .object({
      runId: z.string().min(1),
    })
    .strict(),
  output: z.object({ classification: dataClassificationSchema }).strict(),
});

const manifest = {
  id: "test.launcher",
  version: "0.1.0",
  engines: { borg: "^0.1.0" },
  main: "test.launcher/main",
  permissions: [
    "executions.manage",
    "tools.invoke",
    "tools.register",
  ],
  contributes: {
    commands: [
      launchChild.id,
      forgeChild.id,
      prepareScope.id,
      readScope.id,
    ],
    kinds: ["tool"],
  },
} as const satisfies BorgPluginManifest;

describe("execution handoffs", () => {
  it("carries a host grant through a tool and nested command", async () => {
    const runtime = createSecurityRuntime();
    const bus = new CommandEventBus();
    const manager = new PluginManager(bus, "0.1.0", {
      executions: runtime.executions,
      tools: runtime.tools,
    });
    await manager.activate({
      manifest,
      loadMain: async () =>
        definePlugin({
          ...manifest,
          activate(context) {
            context.bus.handle(
              launchChild,
              async ({ childId }, _signal, envelope) => {
                if (!envelope.parentExecutionGrant) {
                  throw new Error("Nested command received no parent grant");
                }
                const child = await context.executions.bind({
                  mode: "child",
                  subject: {
                    kind: "nested-command",
                    id: childId,
                  },
                  parent: envelope.parentExecutionGrant,
                });
                const summary = await child.summary();
                return {
                  executionId: child.id,
                  classification: summary.classification,
                };
              },
            );
            context.bus.handle(
              forgeChild,
              async ({ childId, executionId }) => {
                const child = await runtime.executions.bind(
                  manifest.id,
                  {
                    mode: "child",
                    subject: {
                      kind: "forged-command",
                      id: childId,
                    },
                    parent: { executionId },
                  },
                  "merge_to_parent",
                );
                return { executionId: child.id };
              },
            );
            context.bus.handle(
              prepareScope,
              async ({ runId, executionId, sessionId }) => {
                const scope = context.tools.registerExecutionScope({
                  runId,
                  executionId: executionIdSchema.parse(executionId),
                  sessionId,
                });
                await scope.prepare();
                return {
                  classification:
                    runtime.classification.snapshot(runId).level,
                };
              },
            );
            context.bus.handle(readScope, async ({ runId }) => {
              await context.tools.invoke(
                "test.launcher.observe",
                {},
                { runId },
              );
              return {
                classification:
                  runtime.classification.snapshot(runId).level,
              };
            });
            context.tools.register(
              defineTool({
                id: "test.launcher.run",
                description: "Launch nested secured work",
                input: z.object({ childId: z.string().min(1) }).strict(),
                output: z
                  .object({
                    executionId: executionIdSchema,
                    classification: dataClassificationSchema,
                  })
                  .strict(),
                approval: "auto",
                sideEffect: true,
                execute: ({ childId }) =>
                  context.bus.invoke(launchChild, { childId }),
              }),
            );
            context.tools.register(
              defineTool({
                id: "test.launcher.observe",
                description: "Observe refreshed execution classification",
                input: z.object({}).strict(),
                output: z.object({ ok: z.literal(true) }).strict(),
                approval: "auto",
                sideEffect: false,
                execute: () => ({ ok: true as const }),
              }),
            );
          },
        }),
    });

    const parent = await runtime.executions.bind(
      "test.owner",
      {
        mode: "root",
        subject: { kind: "loop", id: "parent" },
        classification: "restricted",
        provenance: {
          kind: "plugin",
          id: "test.owner",
        },
      },
      "detached",
    );
    const pluginExecution = await runtime.executions.bind(
      manifest.id,
      {
        mode: "root",
        subject: { kind: "graph", id: "scope-owner" },
        classification: "internal",
        provenance: {
          kind: "plugin",
          id: manifest.id,
        },
      },
      "detached",
    );
    await expect(
      bus.invoke(prepareScope, {
        runId: "graph-scope",
        executionId: pluginExecution.id,
        sessionId: crypto.randomUUID(),
      }),
    ).resolves.toEqual({ classification: "internal" });
    await runtime.executions.observe(
      manifest.id,
      pluginExecution.id,
      {
        classification: "restricted",
        provenance: {
          kind: "plugin",
          id: "test.launcher.child-result",
        },
        reason: "merged child result raised the execution",
      },
    );
    await expect(
      bus.invoke(readScope, { runId: "graph-scope" }),
    ).resolves.toEqual({ classification: "restricted" });
    runtime.tools.registerRunPolicy(
      "run-1",
      "test.owner",
      ["test.launcher.run"],
      {
        executionId: parent.id,
        initialClassification: "restricted",
      },
    );

    await expect(
      runtime.tools.invoke(
        "test.launcher.run",
        { childId: "from-tool" },
        {
          callerPluginId: "test.owner",
          runId: "run-1",
        },
      ),
    ).resolves.toMatchObject({
      classification: "restricted",
    });

    await expect(
      bus.invoke(forgeChild, {
        childId: "copied-id",
        executionId: parent.id,
      }),
    ).rejects.toMatchObject({
      code: "failed",
      cause: expect.objectContaining({
        message: expect.stringMatching(/parent grant|grant/i),
      }),
    });
  });
});
