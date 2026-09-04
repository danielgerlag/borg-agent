import {
  channelCapacitySchema,
  dataClassificationSchema,
  type ChannelCapacity,
  type DataClassification,
} from "@borg/contracts";
import type { Disposable } from "@borg/plugin-sdk";

export const CLASSIFICATION_ORDER: readonly DataClassification[] = Object.freeze(
  ["public", "internal", "confidential", "restricted"],
);

export const CAPACITY_CEILINGS: Readonly<
  Record<ChannelCapacity, DataClassification>
> = Object.freeze({
  public: "public",
  internal: "internal",
  private: "confidential",
  "local-only": "restricted",
});

export const DEFAULT_RUN_CLASSIFICATION: DataClassification = "internal";

const MAX_RAISE_HISTORY = 64;
const MAX_REASON_LENGTH = 512;

export interface ClassificationSnapshot {
  readonly level: DataClassification;
  readonly version: number;
}

export interface ClassificationRaise {
  readonly level: DataClassification;
  readonly version: number;
  readonly reason: string;
}

export const UNCLASSIFIED_SNAPSHOT: ClassificationSnapshot = Object.freeze({
  level: "public",
  version: 0,
});

interface RunClassification {
  level: DataClassification;
  version: number;
  readonly history: ClassificationRaise[];
}

export function classificationRank(level: DataClassification): number {
  const rank = CLASSIFICATION_ORDER.indexOf(level);
  if (rank < 0) {
    throw new Error(`Data classification ${String(level)} is unknown`);
  }
  return rank;
}

export function compareClassification(
  left: DataClassification,
  right: DataClassification,
): number {
  return classificationRank(left) - classificationRank(right);
}

export function maxClassification(
  ...levels: readonly DataClassification[]
): DataClassification {
  let highest: DataClassification = "public";
  for (const level of levels) {
    if (compareClassification(level, highest) > 0) {
      highest = level;
    }
  }
  return highest;
}

export function capacityCeiling(capacity: ChannelCapacity): DataClassification {
  const ceiling = CAPACITY_CEILINGS[capacity];
  if (ceiling === undefined) {
    throw new Error(`Channel capacity ${String(capacity)} is unknown`);
  }
  return ceiling;
}

export function exceedsCapacity(
  level: DataClassification,
  capacity: ChannelCapacity,
): boolean {
  return compareClassification(level, capacityCeiling(capacity)) > 0;
}

export class ClassificationService {
  readonly #runs = new Map<string, RunClassification>();

  openRun(
    runId: string,
    initial: DataClassification = DEFAULT_RUN_CLASSIFICATION,
  ): Disposable {
    if (typeof runId !== "string" || runId.length === 0) {
      throw new Error("Classification run id is invalid");
    }
    if (this.#runs.has(runId)) {
      throw new Error(`Classification run ${runId} is already open`);
    }
    const parsed = dataClassificationSchema.safeParse(initial);
    if (!parsed.success) {
      throw new Error(
        `Initial classification ${String(initial)} for run ${runId} is invalid`,
      );
    }
    const entry: RunClassification = {
      level: parsed.data,
      version: 1,
      history: [],
    };
    this.#runs.set(runId, entry);
    return {
      dispose: () => {
        if (this.#runs.get(runId) === entry) {
          this.#runs.delete(runId);
          entry.history.length = 0;
        }
      },
    };
  }

  isOpen(runId: string): boolean {
    return this.#runs.has(runId);
  }

  snapshot(runId?: string): ClassificationSnapshot {
    if (runId === undefined) {
      return UNCLASSIFIED_SNAPSHOT;
    }
    const entry = this.#runs.get(runId);
    if (!entry) {
      return UNCLASSIFIED_SNAPSHOT;
    }
    return Object.freeze({ level: entry.level, version: entry.version });
  }

  raise(
    runId: string,
    level: DataClassification,
    reason: string,
  ): ClassificationSnapshot {
    const parsed = dataClassificationSchema.safeParse(level);
    if (!parsed.success) {
      throw new Error(`Data classification ${String(level)} is invalid`);
    }
    const entry = this.#runs.get(runId);
    if (!entry) {
      return UNCLASSIFIED_SNAPSHOT;
    }
    if (compareClassification(parsed.data, entry.level) <= 0) {
      return Object.freeze({ level: entry.level, version: entry.version });
    }
    entry.level = parsed.data;
    entry.version += 1;
    entry.history.push(
      Object.freeze({
        level: entry.level,
        version: entry.version,
        reason: String(reason ?? "").slice(0, MAX_REASON_LENGTH),
      }),
    );
    const overflow = entry.history.length - MAX_RAISE_HISTORY;
    if (overflow > 0) {
      entry.history.splice(0, overflow);
    }
    return Object.freeze({ level: entry.level, version: entry.version });
  }

  history(runId: string): readonly ClassificationRaise[] {
    return Object.freeze([...(this.#runs.get(runId)?.history ?? [])]);
  }

  ceilingFor(capacity: ChannelCapacity): DataClassification {
    const parsed = channelCapacitySchema.safeParse(capacity);
    if (!parsed.success) {
      throw new Error(`Channel capacity ${String(capacity)} is invalid`);
    }
    return capacityCeiling(parsed.data);
  }

  exceeds(level: DataClassification, capacity: ChannelCapacity): boolean {
    return compareClassification(level, this.ceilingFor(capacity)) > 0;
  }
}
