#!/usr/bin/env node
import { runDetachedLoop } from "./run";

const root = process.argv[2];
if (!root) {
  console.error("usage: borg-runtime <run-directory>");
  process.exit(2);
}

runDetachedLoop(root).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
