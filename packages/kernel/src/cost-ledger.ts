import { usageRecordSchema, type UsageRecord } from "@borg/contracts";
import { randomUUID } from "node:crypto";

export interface CostRecord extends UsageRecord {
  readonly id: string;
  readonly createdAt: string;
}

export class CostLedger {
  readonly #records: CostRecord[] = [];

  record(candidate: unknown): CostRecord {
    const usage = usageRecordSchema.parse(candidate);
    const record: CostRecord = Object.freeze({
      ...usage,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    });
    this.#records.push(record);
    return record;
  }

  list(runId?: string): readonly CostRecord[] {
    return this.#records.filter(
      (record) => runId === undefined || record.runId === runId,
    );
  }

  totalForRun(runId: string): {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly amountsByCurrency: Readonly<Record<string, number>>;
  } {
    const amountsByCurrency: Record<string, number> = {};
    let inputTokens = 0;
    let outputTokens = 0;
    for (const record of this.list(runId)) {
      inputTokens += record.inputTokens;
      outputTokens += record.outputTokens;
      if (record.amount !== undefined && record.currency !== undefined) {
        amountsByCurrency[record.currency] =
          (amountsByCurrency[record.currency] ?? 0) + record.amount;
      }
    }
    return {
      inputTokens,
      outputTokens,
      amountsByCurrency: Object.freeze(amountsByCurrency),
    };
  }
}
