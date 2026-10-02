import type { ActInput, BenchSnapshot } from "../contract.js";
import type { BenchInteraction } from "./bridge.js";

export interface BenchControl {
  readonly snapshot: BenchSnapshot;
  readonly busy: boolean;
  run(input: ActInput): void;
}

export interface FlightDeckProps extends BenchControl {
  readonly pending: BenchInteraction | null;
  readonly startedAt: string;
}
