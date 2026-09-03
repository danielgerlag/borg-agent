import { spawn } from "node:child_process";
import electronPath from "electron";

const { ELECTRON_RUN_AS_NODE: _runAsNode, ...environment } = process.env;
const child = spawn(electronPath, ["apps/desktop", ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env: environment,
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exitCode = code ?? 1;
});
