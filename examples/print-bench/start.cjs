/**
 * Builds the plugin and the desktop app, then opens Design on the print-bench distribution.
 */

const { spawn, spawnSync } = require("node:child_process");
const { createRequire } = require("node:module");
const path = require("node:path");

const packageDirectory = __dirname;
const root = path.resolve(packageDirectory, "../..");
const desktopDirectory = path.join(root, "apps/desktop");
const tsc = path.join(root, "node_modules/typescript/lib/tsc.js");
const vite = path.join(desktopDirectory, "node_modules/vite/bin/vite.js");
const workspaceId = "example.print-bench.design";
const distributionId = "borg.print-bench";

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

run(process.execPath, [tsc, "-p", "tsconfig.json"], packageDirectory);
run(process.execPath, [tsc, "-p", "tsconfig.json"], path.join(root, "distributions/desktop"));
run(process.execPath, [tsc, "-p", "tsconfig.json"], path.join(root, "distributions/print-bench"));
run(process.execPath, [path.join(root, "scripts/generate-bundled-plugins.mjs")], root);
run(process.execPath, [tsc, "-p", "tsconfig.electron.json"], desktopDirectory);
run(process.execPath, [vite, "build"], desktopDirectory);

const requireFromDesktop = createRequire(path.join(desktopDirectory, "package.json"));
const electronPath = requireFromDesktop("electron");
const { ELECTRON_RUN_AS_NODE: _runAsNode, ...environment } = process.env;
environment.BORG_DISTRIBUTION = distributionId;
environment.BORG_WORKSPACE = workspaceId;

const child = spawn(electronPath, [desktopDirectory], {
  cwd: root,
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
