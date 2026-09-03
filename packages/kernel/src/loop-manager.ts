import {
  loopEventSchema,
  loopRunSnapshotSchema,
  loopStartInputSchema,
  type LoopEvent,
  type LoopRunSnapshot,
  type LoopStartInput,
} from "@borg/contracts";
import type { Disposable, JsonValue, ModelMessage } from "@borg/plugin-sdk";
import { randomUUID } from "node:crypto";
import { CostLedger } from "./cost-ledger";
import { ModelRouter } from "./model-router";
import { ToolInvocationError, ToolService } from "./tool-service";

interface LoopRun {
  snapshot: LoopRunSnapshot;
  readonly controller: AbortController;
  readonly ownerPluginId: string;
  readonly toolInvocationAllowed: boolean;
  readonly ownerSignal?: AbortSignal | undefined;
  readonly onOwnerAbort?: (() => void) | undefined;
  toolPolicy?: Disposable | undefined;
  activeToolCallId?: string | undefined;
  activeToolPluginId?: string | undefined;
  pauseRequested: boolean;
  resumeFromPause?: (() => void) | undefined;
}

type ParsedLoopStartInput = ReturnType<typeof loopStartInputSchema.parse>;
type WithoutTimestamp<T> = T extends { readonly timestamp: string }
  ? Omit<T, "timestamp">
  : never;
type LoopEventCandidate = WithoutTimestamp<LoopEvent>;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) {
      deepFreeze(entry);
    }
    Object.freeze(value);
  }
  return value;
}

export class LoopManager {
  readonly #runs = new Map<string, LoopRun>();
  readonly #subscribers = new Map<
    symbol,
    (snapshot: LoopRunSnapshot) => void | Promise<void>
  >();
  readonly #eventSubscribers = new Map<
    symbol,
    (event: LoopEvent) => void | Promise<void>
  >();
  readonly #eventHistory = new Map<string, LoopEvent[]>();
  readonly #announcedInteractionIds = new Set<string>();

  constructor(
    readonly models: ModelRouter,
    readonly tools: ToolService,
    readonly costs: CostLedger,
    readonly canInvokeTools: (pluginId: string) => boolean = (pluginId) =>
      pluginId === "kernel.loop",
  ) {
    this.tools.interactions.subscribe((pending) => {
      const waitingRunIds = new Set(
        pending.flatMap((interaction) => {
          const run = interaction.source.runId
            ? this.#runs.get(interaction.source.runId)
            : undefined;
          return run && this.#belongsToActiveTool(run, interaction)
            ? [run.snapshot.id]
            : [];
        }),
      );
      const pendingInteractionIds = new Set(pending.map(({ id }) => id));
      for (const interactionId of this.#announcedInteractionIds) {
        if (!pendingInteractionIds.has(interactionId)) {
          this.#announcedInteractionIds.delete(interactionId);
        }
      }
      for (const interaction of pending) {
        if (
          interaction.source.runId &&
          !this.#announcedInteractionIds.has(interaction.id) &&
          (() => {
            const run = this.#runs.get(interaction.source.runId);
            return run
              ? this.#belongsToActiveTool(run, interaction)
              : false;
          })()
        ) {
          this.#announcedInteractionIds.add(interaction.id);
          this.#emit({
            type: "interaction_wait",
            runId: interaction.source.runId,
            interactionId: interaction.id,
            kind: interaction.kind,
          });
        }
      }
      for (const run of this.#runs.values()) {
        if (!["running", "waiting"].includes(run.snapshot.status)) {
          continue;
        }
        const status = waitingRunIds.has(run.snapshot.id)
          ? "waiting"
          : "running";
        if (run.snapshot.status !== status) {
          this.#update(run, { status });
        }
      }
    });
  }

  start(
    candidate: LoopStartInput,
    ownerPluginId = "kernel.loop",
    ownerSignal?: AbortSignal,
    toolInvocationAllowed = this.canInvokeTools(ownerPluginId),
  ): LoopRunSnapshot {
    ownerSignal?.throwIfAborted();
    const input = loopStartInputSchema.parse(candidate);
    const now = new Date().toISOString();
    const controller = new AbortController();
    let run: LoopRun;
    const onOwnerAbort = (): void => {
      this.cancel(run.snapshot.id, ownerPluginId);
    };
    run = {
      controller,
      ownerPluginId,
      toolInvocationAllowed,
      ownerSignal,
      onOwnerAbort: ownerSignal ? onOwnerAbort : undefined,
      pauseRequested: false,
      snapshot: Object.freeze(loopRunSnapshotSchema.parse({
        id: randomUUID(),
        status: "running",
        prompt: input.prompt,
        providerId: input.providerId,
        modelId: input.modelId,
        inputTokens: 0,
        outputTokens: 0,
        costsByCurrency: {},
        createdAt: now,
        updatedAt: now,
      })),
    };
    run.toolPolicy = this.tools.registerRunPolicy(
      run.snapshot.id,
      ownerPluginId,
      input.allowedTools,
    );
    this.#runs.set(run.snapshot.id, run);
    ownerSignal?.addEventListener("abort", onOwnerAbort, { once: true });
    if (ownerSignal?.aborted) {
      this.cancel(run.snapshot.id, ownerPluginId);
      return run.snapshot;
    }
    this.#publish(run.snapshot);
    this.#emit({
      type: "state",
      runId: run.snapshot.id,
      status: "running",
    });
    void this.#execute(run, input);
    return run.snapshot;
  }

  get(
    runId: string,
    requesterPluginId?: string,
  ): LoopRunSnapshot | undefined {
    const run = this.#runs.get(runId);
    if (
      !run ||
      (requesterPluginId !== undefined &&
        requesterPluginId !== run.ownerPluginId)
    ) {
      return undefined;
    }
    return run.snapshot;
  }

  list(requesterPluginId?: string): readonly LoopRunSnapshot[] {
    return [...this.#runs.values()]
      .filter(
        (run) =>
          requesterPluginId === undefined ||
          requesterPluginId === run.ownerPluginId,
      )
      .map(({ snapshot }) => snapshot)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  cancel(runId: string, requesterPluginId?: string): boolean {
    const run = this.#runs.get(runId);
    if (
      !run ||
      (requesterPluginId !== undefined &&
        requesterPluginId !== run.ownerPluginId) ||
      !["running", "waiting", "paused"].includes(run.snapshot.status)
    ) {
      return false;
    }
    run.pauseRequested = false;
    run.resumeFromPause?.();
    run.controller.abort(new Error(`Loop ${runId} was cancelled`));
    this.#update(run, { status: "cancelled", error: "Cancelled" });
    return true;
  }

  pause(runId: string, requesterPluginId?: string): boolean {
    const run = this.#runs.get(runId);
    if (
      !run ||
      (requesterPluginId !== undefined &&
        requesterPluginId !== run.ownerPluginId) ||
      !["running", "waiting"].includes(run.snapshot.status)
    ) {
      return false;
    }
    run.pauseRequested = true;
    return true;
  }

  resume(runId: string, requesterPluginId?: string): boolean {
    const run = this.#runs.get(runId);
    if (
      !run ||
      (requesterPluginId !== undefined &&
        requesterPluginId !== run.ownerPluginId) ||
      (!run.pauseRequested && run.snapshot.status !== "paused")
    ) {
      return false;
    }
    run.pauseRequested = false;
    run.resumeFromPause?.();
    return true;
  }

  cancelOwned(pluginId: string): void {
    for (const run of this.#runs.values()) {
      if (run.ownerPluginId === pluginId) {
        this.cancel(run.snapshot.id, pluginId);
      }
    }
  }

  shutdown(): void {
    for (const run of this.#runs.values()) {
      if (["running", "waiting", "paused"].includes(run.snapshot.status)) {
        this.cancel(run.snapshot.id);
      }
    }
  }

  subscribe(
    subscriber: (snapshot: LoopRunSnapshot) => void | Promise<void>,
  ): Disposable {
    const token = Symbol("loop-subscriber");
    this.#subscribers.set(token, subscriber);
    return {
      dispose: () => {
        this.#subscribers.delete(token);
      },
    };
  }

  subscribeRun(
    runId: string,
    requesterPluginId: string,
    subscriber: (event: LoopEvent) => void | Promise<void>,
  ): Disposable {
    if (!this.get(runId, requesterPluginId)) {
      throw new Error(`Loop ${runId} is unavailable`);
    }
    const token = Symbol("loop-event-subscriber");
    const runSubscriber = (event: LoopEvent): void | Promise<void> => {
      if (event.runId === runId) {
        return subscriber(event);
      }
    };
    this.#eventSubscribers.set(token, runSubscriber);
    for (const event of this.#eventHistory.get(runId) ?? []) {
      Promise.resolve()
        .then(async () => runSubscriber(event))
        .catch((error: unknown) =>
          console.error("[kernel] loop event replay subscriber failed", error),
        );
    }
    return {
      dispose: () => {
        this.#eventSubscribers.delete(token);
      },
    };
  }

  async #execute(run: LoopRun, input: ParsedLoopStartInput): Promise<void> {
    const messages: ModelMessage[] = [{ role: "user", content: input.prompt }];
    let providerId = input.providerId;
    let modelId = input.modelId;
    try {
      for (let turn = 0; turn < 8; turn += 1) {
        if (run.controller.signal.aborted) {
          return;
        }
        await this.#waitAtSafePoint(run);
        this.#update(run, { status: "running" });
        this.#emit({
          type: "model_start",
          runId: run.snapshot.id,
          providerId,
          modelId,
        });
        const completion = await this.models.complete(
          {
            providerId,
            modelId,
            runId: run.snapshot.id,
            correlationId: run.snapshot.id,
            messages,
            tools: run.toolInvocationAllowed
              ? this.tools.listDefinitions(input.allowedTools)
              : [],
          },
          run.controller.signal,
        );
        providerId = completion.providerId;
        modelId = completion.modelId;
        await this.#waitAtSafePoint(run);
        if (completion.result.content) {
          this.#emit({
            type: "model_token",
            runId: run.snapshot.id,
            token: completion.result.content,
          });
        }
        this.#emit({
          type: "model_end",
          runId: run.snapshot.id,
          providerId,
          modelId,
        });
        this.#refreshUsage(run, completion.providerId, completion.modelId);

        if (completion.result.toolCalls?.length) {
          messages.push({
            role: "assistant",
            content: completion.result.content ?? "",
            toolCalls: completion.result.toolCalls,
          });
          for (const toolCall of completion.result.toolCalls) {
            await this.#waitAtSafePoint(run);
            if (!run.toolInvocationAllowed) {
              throw new ToolInvocationError(
                "forbidden",
                `Plugin ${run.ownerPluginId} cannot invoke tools from a loop`,
              );
            }
            this.#emit({
              type: "tool_start",
              runId: run.snapshot.id,
              toolId: toolCall.name,
              toolCallId: toolCall.id,
              input: toolCall.input,
            });
            run.activeToolCallId = toolCall.id;
            run.activeToolPluginId = this.tools.getProviderPluginId(toolCall.name);
            let output: JsonValue;
            try {
              output = await this.tools.invoke(toolCall.name, toolCall.input, {
                callerPluginId: run.ownerPluginId,
                runId: run.snapshot.id,
                toolCallId: toolCall.id,
                signal: run.controller.signal,
                onInteraction: () => this.#update(run, { status: "waiting" }),
              });
            } finally {
              run.activeToolCallId = undefined;
              run.activeToolPluginId = undefined;
            }
            run.controller.signal.throwIfAborted();
            this.#update(run, { status: "running" });
            messages.push({
              role: "tool",
              toolCallId: toolCall.id,
              content: JSON.stringify(output),
            });
            this.#emit({
              type: "tool_result",
              runId: run.snapshot.id,
              toolId: toolCall.name,
              toolCallId: toolCall.id,
              output,
            });
          }
          continue;
        }

        if (completion.result.content !== undefined) {
          run.controller.signal.throwIfAborted();
          this.#update(run, {
            status: "completed",
            output: completion.result.content,
          });
          this.#emit({
            type: "final",
            runId: run.snapshot.id,
            output: completion.result.content,
          });
          return;
        }
        throw new Error("Model returned neither content nor tool calls");
      }
      throw new Error("ReAct loop exceeded its eight-turn budget");
    } catch (error) {
      this.#refreshUsage(run, providerId, modelId);
      if (run.controller.signal.aborted) {
        if (run.snapshot.status !== "cancelled") {
          this.#update(run, { status: "cancelled", error: "Cancelled" });
        }
        return;
      }
      const message =
        error instanceof ToolInvocationError
          ? `${error.code}: ${error.message}`
          : error instanceof Error
            ? error.message
            : String(error);
      this.#update(run, { status: "failed", error: message });
      this.#emit({
        type: "failed",
        runId: run.snapshot.id,
        error: message,
      });
    }
  }

  #refreshUsage(
    run: LoopRun,
    providerId?: string,
    modelId?: string,
  ): void {
    const totals = this.costs.totalForRun(run.snapshot.id);
    const records = this.costs.list(run.snapshot.id);
    if (records.length === 0) {
      return;
    }
    const latest = records.at(-1);
    const resolvedProviderId = providerId ?? latest?.providerId;
    const resolvedModelId = modelId ?? latest?.modelId;
    if (
      run.snapshot.inputTokens === totals.inputTokens &&
      run.snapshot.outputTokens === totals.outputTokens &&
      JSON.stringify(run.snapshot.costsByCurrency) ===
        JSON.stringify(totals.amountsByCurrency) &&
      run.snapshot.providerId === resolvedProviderId &&
      run.snapshot.modelId === resolvedModelId
    ) {
      return;
    }
    const usagePatch = {
      providerId: resolvedProviderId,
      modelId: resolvedModelId,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      costsByCurrency: totals.amountsByCurrency,
    };
    if (["completed", "failed", "cancelled"].includes(run.snapshot.status)) {
      run.snapshot = Object.freeze(
        loopRunSnapshotSchema.parse({
          ...run.snapshot,
          ...usagePatch,
          updatedAt: new Date().toISOString(),
        }),
      );
      this.#publish(run.snapshot);
    } else {
      this.#update(run, usagePatch);
    }
    this.#emit({
      type: "usage",
      runId: run.snapshot.id,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      costsByCurrency: totals.amountsByCurrency,
    });
  }

  #belongsToActiveTool(
    run: LoopRun,
    interaction: {
      readonly kind: string;
      readonly source: {
        readonly pluginId: string;
        readonly toolCallId?: string | undefined;
      };
    },
  ): boolean {
    if (
      !run.activeToolCallId ||
      interaction.source.toolCallId !== run.activeToolCallId
    ) {
      return false;
    }
    return interaction.kind === "human_input"
      ? interaction.source.pluginId === run.activeToolPluginId
      : interaction.source.pluginId === run.ownerPluginId;
  }

  async #waitAtSafePoint(run: LoopRun): Promise<void> {
    run.controller.signal.throwIfAborted();
    if (!run.pauseRequested) {
      return;
    }
    this.#update(run, { status: "paused" });
    await new Promise<void>((resolve) => {
      const resume = (): void => {
        run.controller.signal.removeEventListener("abort", resume);
        if (run.resumeFromPause === resume) {
          run.resumeFromPause = undefined;
        }
        resolve();
      };
      run.resumeFromPause = resume;
      run.controller.signal.addEventListener("abort", resume, { once: true });
      if (!run.pauseRequested || run.controller.signal.aborted) {
        resume();
      }
    });
    run.controller.signal.throwIfAborted();
    this.#update(run, { status: "running" });
  }

  #update(
    run: LoopRun,
    patch: Partial<LoopRunSnapshot>,
  ): void {
    if (["completed", "failed", "cancelled"].includes(run.snapshot.status)) {
      return;
    }
    const previousStatus = run.snapshot.status;
    run.snapshot = Object.freeze(loopRunSnapshotSchema.parse({
      ...run.snapshot,
      ...patch,
      updatedAt: new Date().toISOString(),
    }));
    if (["completed", "failed", "cancelled"].includes(run.snapshot.status)) {
      if (run.ownerSignal && run.onOwnerAbort) {
        run.ownerSignal.removeEventListener("abort", run.onOwnerAbort);
      }
      void run.toolPolicy?.dispose();
      run.toolPolicy = undefined;
    }
    this.#publish(run.snapshot);
    if (run.snapshot.status !== previousStatus) {
      this.#emit({
        type: "state",
        runId: run.snapshot.id,
        status: run.snapshot.status,
      });
    }
  }

  #publish(snapshot: LoopRunSnapshot): void {
    for (const subscriber of this.#subscribers.values()) {
      Promise.resolve()
        .then(async () => subscriber(snapshot))
        .catch((error: unknown) =>
          console.error("[kernel] loop subscriber failed", error),
        );
    }
  }

  #emit(
    candidate: LoopEventCandidate,
  ): void {
    const event = deepFreeze(
      loopEventSchema.parse({
        ...candidate,
        timestamp: new Date().toISOString(),
      }),
    );
    const history = this.#eventHistory.get(event.runId) ?? [];
    history.push(event);
    if (history.length > 256) {
      history.shift();
    }
    this.#eventHistory.set(event.runId, history);
    for (const subscriber of this.#eventSubscribers.values()) {
      Promise.resolve()
        .then(async () => subscriber(event))
        .catch((error: unknown) =>
          console.error("[kernel] loop event subscriber failed", error),
        );
    }
  }
}
