import {
  type ConfigStoreProvider,
  type JsonValue,
  type StoreEntry,
  type StoreTransactionOperation,
  z,
} from "@borg/plugin-sdk";
import { describe, expect, it } from "vitest";
import { PersistenceRegistry, StoreFacade } from "../src";
import {
  ExecutionSecurityService,
  type ExecutionBindIntent,
  type ExecutionBinding,
  executionIdSchema,
  executionSecurityContextSchema,
  executionSecuritySummarySchema,
  executionSubjectSchema,
  provenanceSeedSchema,
} from "../src/execution-security";

type ExecutionId = z.infer<typeof executionIdSchema>;
type ExecutionSecurityContext = z.infer<
  typeof executionSecurityContextSchema
>;
type ExecutionSecuritySummary = z.infer<
  typeof executionSecuritySummarySchema
>;
type ExecutionSubject = z.infer<typeof executionSubjectSchema>;
type ProvenanceSeed = z.infer<typeof provenanceSeedSchema>;

class MemoryConfigStore implements ConfigStoreProvider {
  readonly configs = new Map<string, JsonValue>();
  readonly values = new Map<string, Map<string, JsonValue>>();

  async readConfig(namespace: string): Promise<unknown | undefined> {
    return this.configs.get(namespace);
  }

  async writeConfig(namespace: string, value: JsonValue): Promise<void> {
    this.configs.set(namespace, value);
  }

  async getStore(namespace: string, key: string): Promise<JsonValue | undefined> {
    return this.values.get(namespace)?.get(key);
  }

  async listStore(
    namespace: string,
    prefix: string,
  ): Promise<readonly StoreEntry[]> {
    return [...(this.values.get(namespace) ?? new Map()).entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({ key, value }));
  }

  async applyStoreTransaction(
    namespace: string,
    operations: readonly StoreTransactionOperation[],
  ): Promise<void> {
    const values = new Map(this.values.get(namespace));
    for (const operation of operations) {
      if (operation.type === "set") {
        values.set(operation.key, operation.value);
      } else {
        values.delete(operation.key);
      }
    }
    this.values.set(namespace, values);
  }
}

async function createService(
  provider = new MemoryConfigStore(),
): Promise<ExecutionSecurityService> {
  const registry = new PersistenceRegistry();
  registry.registerConfigStore("test.config", provider);
  const service = new ExecutionSecurityService(new StoreFacade(registry));
  await service.initialize();
  return service;
}

function subject(kind: string, id: string): ExecutionSubject {
  return executionSubjectSchema.parse({ kind, id });
}

function userProvenance(id: string): ProvenanceSeed {
  return provenanceSeedSchema.parse({ kind: "user", id });
}

function pluginProvenance(id: string): ProvenanceSeed {
  return provenanceSeedSchema.parse({ kind: "plugin", id });
}

async function summary(
  binding: ExecutionBinding,
): Promise<ExecutionSecuritySummary> {
  return executionSecuritySummarySchema.parse(await binding.summary());
}

async function context(
  service: ExecutionSecurityService,
  ownerPluginId: string,
  executionId: ExecutionId,
): Promise<ExecutionSecurityContext> {
  return executionSecurityContextSchema.parse(
    await service.snapshot(ownerPluginId, executionId),
  );
}

describe("ExecutionSecurityService", () => {
  it("reconstructs durable bindings from the same store", async () => {
    const provider = new MemoryConfigStore();
    const ownerPluginId = "test.chat";
    const rootSubject = subject("chat-session", "session-1");
    const rootProvenance = userProvenance("user-1");
    const firstService = await createService(provider);
    const firstBinding = await firstService.bind(
      ownerPluginId,
      {
        mode: "root",
        subject: rootSubject,
        classification: "internal",
        provenance: rootProvenance,
      },
      "detached",
    );

    await firstBinding.observe({
      classification: "confidential",
      provenance: provenanceSeedSchema.parse({
        kind: "channel",
        id: "message-source-1",
        messageId: "message-1",
      }),
      reason: "received a confidential channel message",
    });
    const firstSummary = await summary(firstBinding);
    const firstContext = await context(
      firstService,
      ownerPluginId,
      firstBinding.id,
    );

    const restoredService = await createService(provider);
    const resumed = await restoredService.bind(
      ownerPluginId,
      { mode: "resume", executionId: firstBinding.id },
      "detached",
    );
    const rebound = await restoredService.bind(
      ownerPluginId,
      {
        mode: "root",
        subject: rootSubject,
        classification: "internal",
        provenance: rootProvenance,
      },
      "detached",
    );

    expect(await summary(resumed)).toEqual(firstSummary);
    expect(
      (await context(restoredService, ownerPluginId, firstBinding.id))
        .provenance,
    ).toEqual(firstContext.provenance);
    expect(rebound.id).toBe(firstBinding.id);
  });

  it("requires explicit root classification and provenance", async () => {
    const service = await createService();
    const ownerPluginId = "test.graphs";
    const rootSubject = subject("graph-instance", "graph-1");

    await expect(
      service.bind(
        ownerPluginId,
        { mode: "root", subject: rootSubject },
        "detached",
      ),
    ).rejects.toThrow(/classification|provenance/i);

    const rootProvenance = provenanceSeedSchema.parse({
      kind: "channel",
      id: "inbound-1",
      messageId: "message-1",
    });
    const binding = await service.bind(
      ownerPluginId,
      {
        mode: "root",
        subject: rootSubject,
        classification: "confidential",
        provenance: rootProvenance,
      },
      "detached",
    );
    const bindingSummary = await summary(binding);
    const bindingContext = await context(service, ownerPluginId, binding.id);

    expect(bindingSummary).toMatchObject({
      id: binding.id,
      ownerPluginId,
      subject: rootSubject,
      classification: "confidential",
      classificationRevision: 1,
      lifecycle: { state: "open" },
    });
    expect(bindingContext.provenance.recent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          classification: "confidential",
          source: rootProvenance,
        }),
      ]),
    );
  });

  it("binds idempotently by owner and subject", async () => {
    const service = await createService();
    const rootSubject = subject("bot", "bot-1");
    const intent = {
      mode: "root",
      subject: rootSubject,
      classification: "internal",
      provenance: pluginProvenance("scheduler"),
    } satisfies ExecutionBindIntent;

    const first = await service.bind("test.bots", intent, "detached");
    const repeated = await service.bind("test.bots", intent, "detached");
    const otherOwner = await service.bind(
      "test.other-bots",
      intent,
      "detached",
    );

    expect(executionIdSchema.safeParse(first.id).success).toBe(true);
    expect(repeated.id).toBe(first.id);
    expect(otherOwner.id).not.toBe(first.id);
  });

  it("rejects subject reuse with different security intent", async () => {
    const service = await createService();
    const rootSubject = subject("graph-instance", "reused-root");
    await service.bind(
      "test.graphs",
      {
        mode: "root",
        subject: rootSubject,
        classification: "public",
        provenance: userProvenance("user-root"),
      },
      "detached",
    );
    await expect(
      service.bind(
        "test.graphs",
        {
          mode: "root",
          subject: rootSubject,
          classification: "restricted",
          provenance: userProvenance("user-root"),
        },
        "detached",
      ),
    ).rejects.toThrow(/different root security/i);

    const firstParent = await service.bind(
      "test.tools",
      {
        mode: "root",
        subject: subject("tool-call", "parent-one"),
        classification: "public",
        provenance: userProvenance("user-parent-one"),
      },
      "detached",
    );
    const secondParent = await service.bind(
      "test.tools",
      {
        mode: "root",
        subject: subject("tool-call", "parent-two"),
        classification: "restricted",
        provenance: userProvenance("user-parent-two"),
      },
      "detached",
    );
    const childSubject = subject("graph-agent", "reused-child");
    await service.bind(
      "test.graphs",
      {
        mode: "child",
        subject: childSubject,
        parent: await service.createParentGrant({
          parentExecutionId: firstParent.id,
          granteePluginId: "test.graphs",
        }),
      },
      "merge_to_parent",
    );
    await expect(
      service.bind(
        "test.graphs",
        {
          mode: "child",
          subject: childSubject,
          parent: await service.createParentGrant({
            parentExecutionId: secondParent.id,
            granteePluginId: "test.graphs",
          }),
        },
        "merge_to_parent",
      ),
    ).rejects.toThrow(/different parent security context/i);
  });

  it("raises classification monotonically and bounds provenance", async () => {
    const service = await createService();
    const ownerPluginId = "test.graphs";
    const binding = await service.bind(
      ownerPluginId,
      {
        mode: "root",
        subject: subject("graph-instance", "graph-2"),
        classification: "public",
        provenance: userProvenance("user-2"),
      },
      "detached",
    );

    const raised = executionSecuritySummarySchema.parse(
      await binding.observe({
        classification: "confidential",
        provenance: pluginProvenance("secret-tool"),
        reason: "read a confidential tool result",
      }),
    );
    const lower = executionSecuritySummarySchema.parse(
      await binding.observe({
        classification: "internal",
        provenance: pluginProvenance("ordinary-tool"),
        reason: "read an internal tool result",
      }),
    );
    const restricted = executionSecuritySummarySchema.parse(
      await binding.observe({
        classification: "restricted",
        provenance: pluginProvenance("local-secret"),
        reason: "read a local secret",
      }),
    );

    expect(raised).toMatchObject({
      classification: "confidential",
      classificationRevision: 2,
    });

    expect(lower).toMatchObject({
      classification: "confidential",
      classificationRevision: 2,
    });
    expect(restricted).toMatchObject({
      classification: "restricted",
      classificationRevision: 3,
    });

    const observationCount = 80;
    for (let index = 0; index < observationCount; index += 1) {
      await binding.observe({
        classification: "public",
        provenance: pluginProvenance(`source-${index}`),
        reason: `bounded provenance observation ${index}`,
      });
    }

    const finalSummary = await summary(binding);
    const finalContext = await context(service, ownerPluginId, binding.id);
    const totalProvenanceCount = 4 + observationCount;

    expect(finalSummary).toMatchObject({
      classification: "restricted",
      classificationRevision: 3,
    });
    expect(finalContext.provenance.recent.length).toBeLessThan(
      totalProvenanceCount,
    );
    expect(finalContext.provenance.overflow).toMatchObject({
      kind: "truncated",
      omittedCount:
        totalProvenanceCount - finalContext.provenance.recent.length,
    });
    await expect(
      service.bind(
        ownerPluginId,
        {
          mode: "root",
          subject: subject("graph-instance", "graph-2"),
          classification: "public",
          provenance: userProvenance("user-2"),
        },
        "detached",
      ),
    ).resolves.toMatchObject({ id: binding.id });
  });

  it("serializes a dispatch commit against classification raises", async () => {
    const service = await createService();
    const ownerPluginId = "test.graphs";
    const binding = await service.bind(
      ownerPluginId,
      {
        mode: "root",
        subject: subject("graph-instance", "dispatch-race"),
        classification: "internal",
        provenance: userProvenance("user-dispatch"),
      },
      "detached",
    );
    let releaseCommit = (): void => {
      throw new Error("Dispatch commit was not entered");
    };
    let markCommitEntered = (): void => {
      throw new Error("Dispatch entry signal was not initialized");
    };
    const commitEntered = new Promise<void>((resolve) => {
      markCommitEntered = resolve;
    });
    const commitGate = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    const commit = service.commitIfCurrent(
      ownerPluginId,
      binding.id,
      1,
      async (current) => {
        markCommitEntered();
        await commitGate;
        return current.classification;
      },
    );
    await commitEntered;
    let raiseFinished = false;
    const raise = binding
      .observe({
        classification: "restricted",
        provenance: pluginProvenance("concurrent-secret"),
        reason: "classification rose during dispatch preparation",
      })
      .then((result) => {
        raiseFinished = true;
        return result;
      });
    await Promise.resolve();
    expect(raiseFinished).toBe(false);

    releaseCommit();
    await expect(commit).resolves.toEqual({
      committed: true,
      value: "internal",
    });
    await expect(raise).resolves.toMatchObject({
      classification: "restricted",
      classificationRevision: 2,
    });
    await expect(
      service.commitIfCurrent(
        ownerPluginId,
        binding.id,
        1,
        async () => "stale",
      ),
    ).resolves.toEqual({ committed: false });
  });

  it("inherits through a live parent grant scoped to the child owner", async () => {
    const service = await createService();
    const parent = await service.bind(
      "test.tools",
      {
        mode: "root",
        subject: subject("tool-call", "tool-call-1"),
        classification: "restricted",
        provenance: userProvenance("user-3"),
      },
      "detached",
    );
    const rejectedGrant = await service.createParentGrant({
      parentExecutionId: parent.id,
      granteePluginId: "test.graphs",
    });

    await expect(
      service.bind(
        "test.bots",
        {
          mode: "child",
          subject: subject("bot", "forbidden-bot"),
          parent: rejectedGrant,
        },
        "merge_to_parent",
      ),
    ).rejects.toThrow(/grant|grantee/i);

    const grant = await service.createParentGrant({
      parentExecutionId: parent.id,
      granteePluginId: "test.graphs",
    });
    const child = await service.bind(
      "test.graphs",
      {
        mode: "child",
        subject: subject("graph-instance", "graph-child-1"),
        parent: grant,
      },
      "merge_to_parent",
    );

    expect(await summary(child)).toMatchObject({
      parentExecutionId: parent.id,
      ownerPluginId: "test.graphs",
      classification: "restricted",
      lifecycle: { state: "open" },
    });
    await child.observe({
      classification: "restricted",
      provenance: pluginProvenance("child-secret"),
      reason: "child classification rose after binding",
    });
    const replayGrant = await service.createParentGrant({
      parentExecutionId: parent.id,
      granteePluginId: "test.graphs",
    });
    await expect(
      service.bind(
        "test.graphs",
        {
          mode: "child",
          subject: subject("graph-instance", "graph-child-1"),
          parent: replayGrant,
        },
        "merge_to_parent",
      ),
    ).resolves.toMatchObject({ id: child.id });
  });

  it("rejects copied and execution-id-shaped grants at the bind boundary", async () => {
    const provider = new MemoryConfigStore();
    const service = await createService(provider);
    const parent = await service.bind(
      "test.tools",
      {
        mode: "root",
        subject: subject("tool-call", "tool-call-2"),
        classification: "internal",
        provenance: userProvenance("user-4"),
      },
      "detached",
    );
    const grant = await service.createParentGrant({
      parentExecutionId: parent.id,
      granteePluginId: "test.graphs",
    });
    const copiedGrant = { ...grant };

    await expect(
      service.bind(
        "test.graphs",
        {
          mode: "child",
          subject: subject("graph-instance", "graph-forged-1"),
          parent: copiedGrant,
        },
        "detached",
      ),
    ).rejects.toThrow(/parent grant|grant/i);
    await expect(
      service.bind(
        "test.graphs",
        {
          mode: "child",
          subject: subject("graph-instance", "graph-forged-2"),
          parent: { executionId: parent.id },
        },
        "detached",
      ),
    ).rejects.toThrow(/parent grant|grant/i);

    const restoredService = await createService(provider);
    await expect(
      restoredService.bind(
        "test.graphs",
        {
          mode: "child",
          subject: subject("graph-instance", "graph-stale-grant"),
          parent: grant,
        },
        "detached",
      ),
    ).rejects.toThrow(/parent grant|grant/i);
  });

  it("uses the host-selected merge mode when children close", async () => {
    const service = await createService();
    const parent = await service.bind(
      "test.chat",
      {
        mode: "root",
        subject: subject("chat-session", "parent-chat"),
        classification: "public",
        provenance: userProvenance("user-5"),
      },
      "detached",
    );
    const mergeGrant = await service.createParentGrant({
      parentExecutionId: parent.id,
      granteePluginId: "test.loops",
    });
    const detachedGrant = await service.createParentGrant({
      parentExecutionId: parent.id,
      granteePluginId: "test.chat",
    });
    const mergedChild = await service.bind(
      "test.loops",
      {
        mode: "child",
        subject: subject("loop-run", "loop-1"),
        parent: mergeGrant,
      },
      "merge_to_parent",
    );
    const detachedChild = await service.bind(
      "test.chat",
      {
        mode: "child",
        subject: subject("chat-session", "detached-chat"),
        parent: detachedGrant,
      },
      "detached",
    );

    await mergedChild.observe({
      classification: "confidential",
      provenance: pluginProvenance("model-output"),
      reason: "approved model output",
    });
    await detachedChild.observe({
      classification: "restricted",
      provenance: pluginProvenance("local-secret"),
      reason: "detached child read a local secret",
    });

    await detachedChild.close({
      outcome: "completed",
      reason: "detached child completed",
    });
    expect(await summary(parent)).toMatchObject({
      classification: "public",
      classificationRevision: 1,
    });

    await mergedChild.close({
      outcome: "completed",
      reason: "merged child completed",
    });
    expect(await summary(parent)).toMatchObject({
      classification: "confidential",
      classificationRevision: 2,
    });
  });

  it("imports a detached child result exactly once", async () => {
    const service = await createService();
    const ownerPluginId = "test.chat";
    const parent = await service.bind(
      ownerPluginId,
      {
        mode: "root",
        subject: subject("chat-session", "import-parent"),
        classification: "public",
        provenance: userProvenance("user-6"),
      },
      "detached",
    );
    const grant = await service.createParentGrant({
      parentExecutionId: parent.id,
      granteePluginId: ownerPluginId,
    });
    const child = await service.bind(
      ownerPluginId,
      {
        mode: "child",
        subject: subject("chat-session", "import-child"),
        parent: grant,
      },
      "detached",
    );

    await child.observe({
      classification: "restricted",
      provenance: pluginProvenance("child-local-secret"),
      reason: "child consumed a restricted local result",
    });
    await child.close({
      outcome: "completed",
      reason: "child completed",
    });

    const firstImport = executionSecuritySummarySchema.parse(
      await parent.importDetachedResult(child.id),
    );
    const afterFirstImport = await context(service, ownerPluginId, parent.id);
    const repeatedImport = executionSecuritySummarySchema.parse(
      await parent.importDetachedResult(child.id),
    );
    const afterRepeatedImport = await context(
      service,
      ownerPluginId,
      parent.id,
    );

    expect(firstImport).toMatchObject({
      id: parent.id,
      classification: "restricted",
      classificationRevision: 2,
    });
    expect(repeatedImport).toEqual(firstImport);
    expect(afterRepeatedImport.provenance).toEqual(
      afterFirstImport.provenance,
    );
  });

  it("closes idempotently and rejects a conflicting close", async () => {
    const service = await createService();
    const binding = await service.bind(
      "test.bots",
      {
        mode: "root",
        subject: subject("bot", "closable-bot"),
        classification: "internal",
        provenance: pluginProvenance("scheduler"),
      },
      "detached",
    );

    const firstClose = executionSecuritySummarySchema.parse(
      await binding.close({
        outcome: "completed",
        reason: "bot completed",
      }),
    );
    const repeatedClose = executionSecuritySummarySchema.parse(
      await binding.close({
        outcome: "completed",
        reason: "retry after losing the close acknowledgement",
      }),
    );

    expect(firstClose.lifecycle).toMatchObject({
      state: "closed",
      outcome: "completed",
    });
    expect(repeatedClose).toEqual(firstClose);
    await expect(
      binding.close({
        outcome: "failed",
        reason: "conflicting terminal state",
      }),
    ).rejects.toThrow(/already closed|conflict/i);
  });
});
