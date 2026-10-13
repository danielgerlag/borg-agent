/**
 * Snapshot, busy flag, and act runner passed into the chat screen.
 */

import type { ActInput, HelloWorldSnapshot } from "../contract.js";

export interface HelloWorldControl {
  readonly snapshot: HelloWorldSnapshot;
  readonly busy: boolean;
  run(input: ActInput): void;
}
