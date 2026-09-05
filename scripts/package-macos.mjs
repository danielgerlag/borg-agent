import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  throw new Error("The macOS package command must run on macOS");
}

const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const packageRoot = path.join(projectRoot, ".package");
const stageDirectory = path.join(packageRoot, "stage");
const outputDirectory = path.join(packageRoot, "output");
const architecture = process.arch;
const appDirectory = path.join(
  outputDirectory,
  `Borg-darwin-${architecture}`,
);
const appPath = path.join(appDirectory, "Borg.app");
const archivePath = path.join(
  packageRoot,
  `Borg-darwin-${architecture}.zip`,
);
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const packager = path.join(
  projectRoot,
  "node_modules",
  ".bin",
  "electron-packager",
);

rmSync(packageRoot, { recursive: true, force: true });
mkdirSync(packageRoot, { recursive: true });

execFileSync(pnpm, ["build"], {
  cwd: projectRoot,
  stdio: "inherit",
});
execFileSync(
  pnpm,
  [
    "--config.inject-workspace-packages=true",
    "--filter",
    "@borg/desktop",
    "deploy",
    "--prod",
    "--trust-lockfile",
    "--node-linker=hoisted",
    stageDirectory,
  ],
  {
    cwd: projectRoot,
    stdio: "inherit",
  },
);
execFileSync(
  packager,
  [
    stageDirectory,
    "Borg",
    "--platform=darwin",
    `--arch=${architecture}`,
    "--electron-version=44.0.0",
    `--out=${outputDirectory}`,
    "--overwrite",
    "--asar",
    "--prune=false",
    "--app-bundle-id=com.danielgerlag.borg",
    "--ignore=^/test($|/)",
    "--ignore=^/src($|/)",
    "--ignore=^/tsconfig\\.",
    "--ignore=^/vite\\.config\\.",
  ],
  {
    cwd: projectRoot,
    stdio: "inherit",
  },
);

if (!existsSync(appPath)) {
  throw new Error(`Packager did not create ${appPath}`);
}

execFileSync(
  "ditto",
  [
    "-c",
    "-k",
    "--sequesterRsrc",
    "--keepParent",
    appPath,
    archivePath,
  ],
  {
    cwd: projectRoot,
    stdio: "inherit",
  },
);

process.stdout.write(`${archivePath}\n`);
