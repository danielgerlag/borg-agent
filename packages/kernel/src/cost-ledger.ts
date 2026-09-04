import {
  costSummarySchema,
  usageRecordSchema,
  type CostSummary,
  type UsageRecord,
} from "@borg/contracts";
import { randomUUID } from "node:crypto";
import type { Disposable } from "@borg/plugin-sdk";

export interface CostRecord extends UsageRecord {
  readonly id: string;
  readonly createdAt: string;
}

export class CostLedger {
  readonly #records: CostRecord[] = [];
  readonly #subscribers = new Map<
    symbol,
    (summary: CostSummary) => void | Promise<void>
  >();

  record(candidate: unknown): CostRecord {
    const usage = usageRecordSchema.parse(candidate);
    const record: CostRecord = Object.freeze({
      ...usage,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    });
    this.#records.push(record);
    this.#publish();
    return record;
  }

  list(runId?: string): readonly CostRecord[] {
    return this.#records.filter(
      (record) => runId === undefined || record.runId === runId,
    );
  }

  summary(runId?: string): CostSummary {
    return this.#summarize(this.list(runId));
  }

  totalForRun(runId: string): CostSummary {
    return this.summary(runId);
  }

  subscribe(handler: (summary: CostSummary) => void | Promise<void>): Disposable {
    const token = Symbol("cost-subscriber");
    this.#subscribers.set(token, handler);
    this.#notify(handler, this.summary());
    return {
      dispose: () => {
        this.#subscribers.delete(token);
      },
    };
  }

  #summarize(records: readonly CostRecord[]): CostSummary {
    const amountsByCurrency: Record<string, number> = {};
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedInputTokens = 0;
    let cacheWriteTokens = 0;
    for (const record of records) {
      inputTokens += record.inputTokens;
      outputTokens += record.outputTokens;
      cachedInputTokens += record.cachedInputTokens ?? 0;
      cacheWriteTokens += record.cacheWriteTokens ?? 0;
      if (record.amount !== undefined && record.currency !== undefined) {
        amountsByCurrency[record.currency] =
          (amountsByCurrency[record.currency] ?? 0) + record.amount;
      }
    }
    return costSummarySchema.parse({
      inputTokens,
      outputTokens,
      cachedInputTokens,
      cacheWriteTokens,
      amountsByCurrency,
    });
  }

  #publish(): void {
    const snapshot = this.summary();
    for (const subscriber of this.#subscribers.values()) {
      this.#notify(subscriber, snapshot);
    }
  }

  #notify(
    handler: (summary: CostSummary) => void | Promise<void>,
    snapshot: CostSummary,
  ): void {
    try {
      void Promise.resolve(handler(snapshot)).catch((error: unknown) =>
        console.error("[kernel] cost subscriber failed", error),
      );
    } catch (error) {
      console.error("[kernel] cost subscriber failed", error);
    }
  }
}
