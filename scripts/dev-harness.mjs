/**
 * Builds the harness plugin and opens its workspace in the desktop host.
 * The renderer comes from the Vite dev server, so UI edits reload without a production build.
 */

import { spawn, spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktopDirectory = path.join(root, "apps/desktop");
const rendererUrl = "http://127.0.0.1:5173/";
const tsc = path.join(root, "node_modules/typescript/lib/tsc.js");
const vite = path.join(desktopDirectory, "node_modules/vite/bin/vite.js");

const packageJson = JSON.parse(
  readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
);
const distributionId = packageJson.borg?.distribution;
const workspaceId = packageJson.borg?.workspace;
if (typeof distributionId !== "string" || typeof workspaceId !== "string") {
  console.error(
    "package.json needs borg.distribution and borg.workspace before this harness can start.",
  );
  process.exit(1);
}

function run(args, cwd) {
  const result = spawnSync(process.execPath, args, {
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

function packageDirectories(parent) {
  return readdirSync(parent, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(parent, entry.name))
    .filter((directory) => {
      try {
        readFileSync(path.join(directory, "tsconfig.json"));
        return true;
      } catch {
        return false;
      }
    });
}

run([tsc, "-p", "tsconfig.json"], process.cwd());
run([tsc, "-p", "tsconfig.json"], path.join(root, "packages/harness"));
run([tsc, "-p", "tsconfig.main.json"], path.join(root, "plugins/personas"));
for (const directory of packageDirectories(path.join(root, "distributions"))) {
  run([tsc, "-p", "tsconfig.json"], directory);
}
run([path.join(root, "scripts/generate-bundled-plugins.mjs")], root);
run([tsc, "-p", "tsconfig.electron.json"], desktopDirectory);

const viteProcess = spawn(
  process.execPath,
  [vite, "--host", "127.0.0.1", "--port", "5173", "--strictPort"],
  {
    cwd: desktopDirectory,
    stdio: "inherit",
  },
);

const deadline = Date.now() + 30_000;
let viteReady = false;
while (Date.now() < deadline) {
  if (viteProcess.exitCode !== null) {
    process.exit(viteProcess.exitCode ?? 1);
  }
  try {
    const response = await fetch(rendererUrl);
    if (response.ok) {
      viteReady = true;
      break;
    }
  } catch {
    // The server is still starting.
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
}
if (!viteReady) {
  viteProcess.kill("SIGTERM");
  console.error(`Vite did not answer at ${rendererUrl}`);
  process.exit(1);
}

const requireFromDesktop = createRequire(path.join(desktopDirectory, "package.json"));
const electronPath = requireFromDesktop("electron");
const { ELECTRON_RUN_AS_NODE: _runAsNode, ...environment } = process.env;
environment.BORG_DISTRIBUTION = distributionId;
environment.BORG_WORKSPACE = workspaceId;
environment.BORG_RENDERER_URL = rendererUrl;

const electron = spawn(electronPath, [desktopDirectory], {
  cwd: root,
  env: environment,
  stdio: "inherit",
});

function stop() {
  if (electron.exitCode === null) {
    electron.kill("SIGTERM");
  }
  if (viteProcess.exitCode === null) {
    viteProcess.kill("SIGTERM");
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, stop);
}

electron.on("exit", (code, signal) => {
  if (viteProcess.exitCode === null) {
    viteProcess.kill("SIGTERM");
  }
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
