/**
 * Snapshot, busy flag, and act runner passed into the design screen.
 */

import type { ActInput, BenchSnapshot } from "../contract.js";

export interface BenchControl {
  readonly snapshot: BenchSnapshot;
  readonly busy: boolean;
  run(input: ActInput): void;
}
