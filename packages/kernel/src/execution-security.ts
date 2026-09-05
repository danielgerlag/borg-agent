import {
  boundedProvenanceSchema,
  executionCloseInputSchema,
  executionIdSchema,
  executionObservationInputSchema,
  executionResultFlowSchema,
  executionResumeBindInputSchema,
  executionRootBindInputSchema,
  executionSecurityContextSchema,
  executionSecuritySummarySchema,
  executionSubjectSchema,
  provenanceSeedSchema,
  securityObservationSchema,
  type BoundedProvenance,
  type DataClassification,
  type ExecutionCloseInput,
  type ExecutionId,
  type ExecutionObservationInput,
  type ExecutionResultFlow,
  type ExecutionResumeBindInput,
  type ExecutionRootBindInput,
  type ExecutionSecurityContext,
  type ExecutionSecuritySummary,
  type ExecutionSubject,
  type ProvenanceSeed,
  type SecurityObservation,
} from "@borg/contracts";
import {
  z,
  type JsonValue,
  type ParentExecutionGrant,
} from "@borg/plugin-sdk";
import { createHash, randomUUID } from "node:crypto";
import { compareClassification } from "./classification-service";
import { StoreFacade } from "./persistence";

export {
  boundedProvenanceSchema,
  executionIdSchema,
  executionSecurityContextSchema,
  executionSecuritySummarySchema,
  executionSubjectSchema,
  provenanceSeedSchema,
};

const STORE_NAMESPACE = "kernel.execution-security";
const CONTEXT_PREFIX = "contexts/";
const SUBJECT_PREFIX = "subjects/";
const MAX_PROVENANCE_OBSERVATIONS = 64;
const ownerPluginIdSchema = z.string().min(1).max(200);
const jsonValueSchema = z.json();
const childBindInputSchema = z
  .object({
    mode: z.literal("child"),
    subject: executionSubjectSchema,
    parent: z.unknown(),
  })
  .strict();

export type { ParentExecutionGrant } from "@borg/plugin-sdk";

export type ExecutionBindIntent =
  | ExecutionRootBindInput
  | ExecutionResumeBindInput
  | {
      readonly mode: "child";
      readonly subject: ExecutionSubject;
      readonly parent: ParentExecutionGrant;
    };

export interface ExecutionBinding {
  readonly id: ExecutionId;
  observe(
    input: ExecutionObservationInput,
  ): Promise<ExecutionSecuritySummary>;
  importDetachedResult(
    childExecutionId: ExecutionId,
  ): Promise<ExecutionSecuritySummary>;
  summary(): Promise<ExecutionSecuritySummary>;
  close(input: ExecutionCloseInput): Promise<ExecutionSecuritySummary>;
}

export type ExecutionDispatchCommitResult<T> =
  | {
      readonly committed: true;
      readonly value: T;
    }
  | {
      readonly committed: false;
    };

interface ParentGrantRecord {
  readonly parentExecutionId: ExecutionId;
  readonly granteePluginId: string;
  used: boolean;
}

function contextKey(executionId: ExecutionId): string {
  return `${CONTEXT_PREFIX}${executionId}`;
}

function subjectKey(
  ownerPluginId: string,
  subject: ExecutionSubject,
): string {
  return [
    SUBJECT_PREFIX.slice(0, -1),
    encodeURIComponent(ownerPluginId),
    encodeURIComponent(subject.kind),
    encodeURIComponent(subject.id),
  ].join("/");
}

function toJsonValue(value: unknown): JsonValue {
  return jsonValueSchema.parse(value);
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(toJsonValue(value)))
    .digest("hex");
}

function makeObservation(input: {
  readonly classification: DataClassification;
  readonly source: ProvenanceSeed;
  readonly reason: string;
  readonly observedAt: string;
}): SecurityObservation {
  return securityObservationSchema.parse({
    id: randomUUID(),
    classification: input.classification,
    source: input.source,
    reason: input.reason,
    observedAt: input.observedAt,
  });
}

function appendObservation(
  provenance: BoundedProvenance,
  observation: SecurityObservation,
): BoundedProvenance {
  const recent = [...provenance.recent, observation];
  if (recent.length <= MAX_PROVENANCE_OBSERVATIONS) {
    return boundedProvenanceSchema.parse({
      recent,
      overflow: provenance.overflow,
    });
  }
  const removed = recent.shift();
  if (!removed) {
    throw new Error("Execution provenance overflow lost its removed entry");
  }
  const priorDigest =
    provenance.overflow.kind === "truncated"
      ? provenance.overflow.digestSha256
      : undefined;
  return boundedProvenanceSchema.parse({
    recent,
    overflow: {
      kind: "truncated",
      omittedCount:
        provenance.overflow.kind === "truncated"
          ? provenance.overflow.omittedCount + 1
          : 1,
      digestSha256: digest({
        removed,
        ...(priorDigest === undefined ? {} : { priorDigest }),
      }),
    },
  });
}

function summaryOf(
  context: ExecutionSecurityContext,
): ExecutionSecuritySummary {
  return executionSecuritySummarySchema.parse({
    id: context.id,
    rootExecutionId: context.rootExecutionId,
    ownerPluginId: context.ownerPluginId,
    subject: context.subject,
    parentExecutionId: context.parentExecutionId,
    classification: context.classification,
    classificationRevision: context.classificationRevision,
    lifecycle: context.lifecycle,
  });
}

function ensureOpen(context: ExecutionSecurityContext): void {
  if (context.lifecycle.state === "closed") {
    throw new Error(`Execution ${context.id} is already closed`);
  }
}

function observeContext(
  context: ExecutionSecurityContext,
  input: ExecutionObservationInput,
  now: string,
): ExecutionSecurityContext {
  ensureOpen(context);
  const observation = makeObservation({
    classification: input.classification,
    source: input.provenance,
    reason: input.reason,
    observedAt: now,
  });
  const raises =
    compareClassification(input.classification, context.classification) > 0;
  return executionSecurityContextSchema.parse({
    ...context,
    classification: raises
      ? input.classification
      : context.classification,
    classificationRevision: raises
      ? context.classificationRevision + 1
      : context.classificationRevision,
    provenance: appendObservation(context.provenance, observation),
    updatedAt: now,
  });
}

export class ExecutionSecurityService {
  readonly #grants = new WeakMap<object, ParentGrantRecord>();
  #mutationTail: Promise<void> = Promise.resolve();

  constructor(readonly store: StoreFacade) {}

  async initialize(): Promise<void> {
    const entries = await this.store.list(
      STORE_NAMESPACE,
      CONTEXT_PREFIX,
    );
    for (const entry of entries) {
      executionSecurityContextSchema.parse(entry.value);
    }
  }

  async bind(
    ownerPluginIdCandidate: unknown,
    candidate: unknown,
    resultFlowCandidate: unknown,
  ): Promise<ExecutionBinding> {
    const ownerPluginId = ownerPluginIdSchema.parse(
      ownerPluginIdCandidate,
    );
    const resultFlow = executionResultFlowSchema.parse(
      resultFlowCandidate,
    );
    const root = executionRootBindInputSchema.safeParse(candidate);
    if (root.success) {
      return await this.#bindNew(ownerPluginId, root.data, resultFlow);
    }
    const resume = executionResumeBindInputSchema.safeParse(candidate);
    if (resume.success) {
      return await this.#resume(ownerPluginId, resume.data);
    }
    const child = childBindInputSchema.safeParse(candidate);
    if (child.success) {
      return await this.#bindChild(
        ownerPluginId,
        child.data,
        resultFlow,
      );
    }
    throw new Error(
      "Execution binding requires an explicit root classification and provenance, a live parent grant, or an execution ID to resume",
    );
  }

  async createParentGrant(input: {
    readonly parentExecutionId: ExecutionId;
    readonly granteePluginId: string;
  }): Promise<ParentExecutionGrant> {
    const parentExecutionId = executionIdSchema.parse(
      input.parentExecutionId,
    );
    const granteePluginId = ownerPluginIdSchema.parse(
      input.granteePluginId,
    );
    await this.#loadContext(parentExecutionId);
    const grant = Object.freeze({
      [Symbol.toStringTag]: "ParentExecutionGrant",
    } satisfies ParentExecutionGrant);
    this.#grants.set(grant, {
      parentExecutionId,
      granteePluginId,
      used: false,
    });
    return grant;
  }

  async snapshot(
    ownerPluginIdCandidate: unknown,
    executionIdCandidate: unknown,
  ): Promise<ExecutionSecurityContext> {
    const ownerPluginId = ownerPluginIdSchema.parse(
      ownerPluginIdCandidate,
    );
    const executionId = executionIdSchema.parse(executionIdCandidate);
    const context = await this.#loadContext(executionId);
    if (context.ownerPluginId !== ownerPluginId) {
      throw new Error(
        `Execution ${executionId} does not belong to ${ownerPluginId}`,
      );
    }
    return context;
  }

  async observe(
    ownerPluginIdCandidate: unknown,
    executionIdCandidate: unknown,
    candidate: unknown,
  ): Promise<ExecutionSecuritySummary> {
    const ownerPluginId = ownerPluginIdSchema.parse(
      ownerPluginIdCandidate,
    );
    const executionId = executionIdSchema.parse(executionIdCandidate);
    const input = executionObservationInputSchema.parse(candidate);
    return this.#mutate(async () => {
      const context = await this.snapshot(ownerPluginId, executionId);
      const updated = observeContext(
        context,
        input,
        new Date().toISOString(),
      );
      await this.store.set(
        STORE_NAMESPACE,
        contextKey(executionId),
        toJsonValue(updated),
      );
      return summaryOf(updated);
    });
  }

  async summary(
    ownerPluginIdCandidate: unknown,
    executionIdCandidate: unknown,
  ): Promise<ExecutionSecuritySummary> {
    return summaryOf(
      await this.snapshot(
        ownerPluginIdCandidate,
        executionIdCandidate,
      ),
    );
  }

  commitIfCurrent<T>(
    ownerPluginIdCandidate: unknown,
    executionIdCandidate: unknown,
    expectedRevisionCandidate: unknown,
    operation: (
      summary: ExecutionSecuritySummary,
    ) => Promise<T>,
  ): Promise<ExecutionDispatchCommitResult<T>> {
    const ownerPluginId = ownerPluginIdSchema.parse(
      ownerPluginIdCandidate,
    );
    const executionId = executionIdSchema.parse(executionIdCandidate);
    const expectedRevision = z
      .number()
      .int()
      .positive()
      .parse(expectedRevisionCandidate);
    return this.#mutate(async () => {
      const context = await this.snapshot(ownerPluginId, executionId);
      ensureOpen(context);
      if (context.classificationRevision !== expectedRevision) {
        return { committed: false };
      }
      return {
        committed: true,
        value: await operation(summaryOf(context)),
      };
    });
  }

  async close(
    ownerPluginIdCandidate: unknown,
    executionIdCandidate: unknown,
    candidate: unknown,
  ): Promise<ExecutionSecuritySummary> {
    const ownerPluginId = ownerPluginIdSchema.parse(
      ownerPluginIdCandidate,
    );
    const executionId = executionIdSchema.parse(executionIdCandidate);
    const input = executionCloseInputSchema.parse(candidate);
    return this.#mutate(async () => {
      const context = await this.snapshot(ownerPluginId, executionId);
      if (context.lifecycle.state === "closed") {
        if (context.lifecycle.outcome !== input.outcome) {
          throw new Error(
            `Execution ${executionId} is already closed with ${context.lifecycle.outcome}`,
          );
        }
        return summaryOf(context);
      }
      const now = new Date().toISOString();
      const closed = executionSecurityContextSchema.parse({
        ...context,
        lifecycle: {
          state: "closed",
          outcome: input.outcome,
          reason: input.reason,
          closedAt: now,
        },
        updatedAt: now,
      });
      if (
        closed.parentExecutionId === undefined ||
        closed.resultFlow === "detached"
      ) {
        await this.store.set(
          STORE_NAMESPACE,
          contextKey(executionId),
          toJsonValue(closed),
        );
        return summaryOf(closed);
      }
      const parent = await this.#loadContext(closed.parentExecutionId);
      const mergedParent = observeContext(
        parent,
        {
          classification: closed.classification,
          provenance: {
            kind: "execution",
            id: closed.id,
            relation: "child-result",
          },
          reason: `Merged completed child execution ${closed.id}`,
        },
        now,
      );
      await this.store.transaction(STORE_NAMESPACE, [
        {
          type: "set",
          key: contextKey(closed.id),
          value: toJsonValue(closed),
        },
        {
          type: "set",
          key: contextKey(mergedParent.id),
          value: toJsonValue(mergedParent),
        },
      ]);
      return summaryOf(closed);
    });
  }

  async importDetachedResult(
    ownerPluginIdCandidate: unknown,
    parentExecutionIdCandidate: unknown,
    childExecutionIdCandidate: unknown,
  ): Promise<ExecutionSecuritySummary> {
    const ownerPluginId = ownerPluginIdSchema.parse(
      ownerPluginIdCandidate,
    );
    const parentExecutionId = executionIdSchema.parse(
      parentExecutionIdCandidate,
    );
    const childExecutionId = executionIdSchema.parse(
      childExecutionIdCandidate,
    );
    return this.#mutate(async () => {
      const parent = await this.snapshot(
        ownerPluginId,
        parentExecutionId,
      );
      ensureOpen(parent);
      if (parent.importedDetachedResultIds.includes(childExecutionId)) {
        return summaryOf(parent);
      }
      const child = await this.#loadContext(childExecutionId);
      if (
        child.parentExecutionId !== parent.id ||
        child.resultFlow !== "detached" ||
        child.lifecycle.state !== "closed"
      ) {
        throw new Error(
          `Execution ${childExecutionId} is not a closed detached child of ${parentExecutionId}`,
        );
      }
      const now = new Date().toISOString();
      const observed = observeContext(
        parent,
        {
          classification: child.classification,
          provenance: {
            kind: "execution",
            id: child.id,
            relation: "child-result",
          },
          reason: `Imported detached child execution ${child.id}`,
        },
        now,
      );
      const updated = executionSecurityContextSchema.parse({
        ...observed,
        importedDetachedResultIds: [
          ...observed.importedDetachedResultIds,
          child.id,
        ],
      });
      await this.store.set(
        STORE_NAMESPACE,
        contextKey(parent.id),
        toJsonValue(updated),
      );
      return summaryOf(updated);
    });
  }

  async #bindNew(
    ownerPluginId: string,
    input: ExecutionRootBindInput,
    resultFlow: ExecutionResultFlow,
  ): Promise<ExecutionBinding> {
    return this.#mutate(async () => {
      const existing = await this.#findBySubject(
        ownerPluginId,
        input.subject,
      );
      if (existing) {
        if (
          existing.binding.kind !== "root" ||
          existing.resultFlow !== resultFlow ||
          existing.binding.classification !== input.classification ||
          stableJsonValue(existing.binding.provenance) !==
            stableJsonValue(input.provenance)
        ) {
          throw new Error(
            `Execution subject ${input.subject.kind}/${input.subject.id} is already bound with different root security`,
          );
        }
        return this.#binding(ownerPluginId, existing.id);
      }
      const id = executionIdSchema.parse(randomUUID());
      const now = new Date().toISOString();
      const initialObservation = makeObservation({
        classification: input.classification,
        source: input.provenance,
        reason: "Execution root classification",
        observedAt: now,
      });
      const context = executionSecurityContextSchema.parse({
        version: 1,
        id,
        rootExecutionId: id,
        binding: {
          kind: "root",
          classification: input.classification,
          provenance: input.provenance,
        },
        ownerPluginId,
        subject: input.subject,
        classification: input.classification,
        classificationRevision: 1,
        lifecycle: { state: "open" },
        resultFlow,
        provenance: {
          recent: [initialObservation],
          overflow: { kind: "complete" },
        },
        importedDetachedResultIds: [],
        createdAt: now,
        updatedAt: now,
      });
      await this.store.transaction(STORE_NAMESPACE, [
        {
          type: "set",
          key: subjectKey(ownerPluginId, input.subject),
          value: id,
        },
        {
          type: "set",
          key: contextKey(id),
          value: toJsonValue(context),
        },
      ]);
      return this.#binding(ownerPluginId, id);
    });
  }

  async #bindChild(
    ownerPluginId: string,
    input: z.infer<typeof childBindInputSchema>,
    resultFlow: ExecutionResultFlow,
  ): Promise<ExecutionBinding> {
    return this.#mutate(async () => {
      if (
        typeof input.parent !== "object" ||
        input.parent === null
      ) {
        throw new Error("Execution child requires a live parent grant");
      }
      const grant = this.#grants.get(input.parent);
      if (!grant || grant.used) {
        throw new Error("Execution parent grant is invalid or expired");
      }
      if (grant.granteePluginId !== ownerPluginId) {
        throw new Error(
          `Execution parent grant does not allow grantee ${ownerPluginId}`,
        );
      }
      const parent = await this.#loadContext(grant.parentExecutionId);
      const existing = await this.#findBySubject(
        ownerPluginId,
        input.subject,
      );
      if (existing) {
        if (
          existing.binding.kind !== "child" ||
          existing.binding.parentExecutionId !== parent.id ||
          existing.binding.rootExecutionId !== parent.rootExecutionId ||
          existing.resultFlow !== resultFlow
        ) {
          throw new Error(
            `Execution subject ${input.subject.kind}/${input.subject.id} is already bound to a different parent security context`,
          );
        }
        grant.used = true;
        return this.#binding(ownerPluginId, existing.id);
      }
      const id = executionIdSchema.parse(randomUUID());
      const now = new Date().toISOString();
      const parentObservation = makeObservation({
        classification: parent.classification,
        source: {
          kind: "execution",
          id: parent.id,
          relation: "parent",
        },
        reason: `Forked from parent execution ${parent.id}`,
        observedAt: now,
      });
      const context = executionSecurityContextSchema.parse({
        version: 1,
        id,
        rootExecutionId: parent.rootExecutionId,
        binding: {
          kind: "child",
          parentExecutionId: parent.id,
          rootExecutionId: parent.rootExecutionId,
        },
        ownerPluginId,
        subject: input.subject,
        parentExecutionId: parent.id,
        classification: parent.classification,
        classificationRevision: 1,
        lifecycle: { state: "open" },
        resultFlow,
        provenance: {
          recent: [parentObservation],
          overflow: { kind: "complete" },
        },
        importedDetachedResultIds: [],
        createdAt: now,
        updatedAt: now,
      });
      await this.store.transaction(STORE_NAMESPACE, [
        {
          type: "set",
          key: subjectKey(ownerPluginId, input.subject),
          value: id,
        },
        {
          type: "set",
          key: contextKey(id),
          value: toJsonValue(context),
        },
      ]);
      grant.used = true;
      return this.#binding(ownerPluginId, id);
    });
  }

  async #resume(
    ownerPluginId: string,
    input: ExecutionResumeBindInput,
  ): Promise<ExecutionBinding> {
    const context = await this.snapshot(
      ownerPluginId,
      input.executionId,
    );
    return this.#binding(ownerPluginId, context.id);
  }

  async #findBySubject(
    ownerPluginId: string,
    subject: ExecutionSubject,
  ): Promise<ExecutionSecurityContext | undefined> {
    const value = await this.store.get(
      STORE_NAMESPACE,
      subjectKey(ownerPluginId, subject),
    );
    if (value === undefined) {
      return undefined;
    }
    const executionId = executionIdSchema.parse(value);
    const context = await this.#loadContext(executionId);
    if (
      context.ownerPluginId !== ownerPluginId ||
      context.subject.kind !== subject.kind ||
      context.subject.id !== subject.id
    ) {
      throw new Error(
        `Execution subject index for ${ownerPluginId}/${subject.kind}/${subject.id} is inconsistent`,
      );
    }
    return context;
  }

  async #loadContext(
    executionId: ExecutionId,
  ): Promise<ExecutionSecurityContext> {
    const value = await this.store.get(
      STORE_NAMESPACE,
      contextKey(executionId),
    );
    if (value === undefined) {
      throw new Error(`Execution ${executionId} does not exist`);
    }
    return executionSecurityContextSchema.parse(value);
  }

  #binding(
    ownerPluginId: string,
    executionId: ExecutionId,
  ): ExecutionBinding {
    return Object.freeze({
      id: executionId,
      observe: (input: ExecutionObservationInput) =>
        this.observe(ownerPluginId, executionId, input),
      importDetachedResult: (childExecutionId: ExecutionId) =>
        this.importDetachedResult(
          ownerPluginId,
          executionId,
          childExecutionId,
        ),
      summary: async () =>
        this.summary(ownerPluginId, executionId),
      close: (input: ExecutionCloseInput) =>
        this.close(ownerPluginId, executionId, input),
    });
  }

  #mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mutationTail.then(operation, operation);
    this.#mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function stableJsonValue(value: unknown): string {
  return JSON.stringify(toJsonValue(value));
}
