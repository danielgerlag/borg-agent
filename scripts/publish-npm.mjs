import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const registry = "https://registry.npmjs.org";
const repositoryUrl = "git+https://github.com/danielgerlag/borg-agent.git";
const packages = [
  ["@borg-agent/contracts", "packages/contracts"],
  ["@borg-agent/plugin-sdk", "packages/plugin-sdk"],
  ["@borg-agent/kernel", "packages/kernel"],
];
const publicNames = new Set(packages.map(([name]) => name));
const dryRun = process.argv.includes("--dry-run");
const auth = process.env.BORG_NPM_AUTH ?? (dryRun ? "dry-run" : "");

const publishEnv = { ...process.env };
if (auth === "token") {
  // GitHub sets these whenever the job has id-token: write. npm then tries
  // trusted publishing and does not use NODE_AUTH_TOKEN. Drop them for a token run.
  delete publishEnv.ACTIONS_ID_TOKEN_REQUEST_URL;
  delete publishEnv.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!publishEnv.NODE_AUTH_TOKEN) {
    fail("NPM_TOKEN is empty. Add the repository secret, or run with auth set to trusted-publisher. See CONTRIBUTING.md.");
  }
} else if (auth === "trusted-publisher") {
  if (!publishEnv.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    fail("GitHub did not provide an OIDC token. Trusted publishing needs a GitHub-hosted runner and id-token: write.");
  }
} else if (!dryRun) {
  fail("Set BORG_NPM_AUTH to token or trusted-publisher.");
}

for (const [name, directory] of packages) {
  const manifest = readManifest(directory);
  assertPublishable(name, directory, manifest);
  if (!dryRun && alreadyPublished(name, manifest.version)) {
    console.log(`${name}@${manifest.version} is already on npm`);
    continue;
  }
  const args = [
    "--filter",
    name,
    "publish",
    "--access",
    "public",
    "--no-git-checks",
    "--registry",
    registry,
  ];
  if (dryRun) args.push("--dry-run");
  pnpm(args);
}

function readManifest(directory) {
  return JSON.parse(readFileSync(path.join(root, directory, "package.json"), "utf8"));
}

function assertPublishable(name, directory, manifest) {
  if (manifest.name !== name) fail(`${directory} is named ${manifest.name}`);
  if (manifest.private === true) fail(`${name} is private`);
  if (manifest.publishConfig?.access !== "public") fail(`${name} does not set publishConfig.access to public`);
  if (manifest.repository?.url !== repositoryUrl) fail(`${name} repository.url must be ${repositoryUrl}`);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version)) {
    fail(`${name} version ${manifest.version} is not a release version`);
  }
  for (const file of ["dist/index.js", "dist/index.d.ts"]) {
    try {
      readFileSync(path.join(root, directory, file));
    } catch {
      fail(`${name} is missing ${file}. Build the package before publishing.`);
    }
  }
  for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
    for (const [dependency, spec] of Object.entries(manifest[field] ?? {})) {
      if (typeof spec === "string" && spec.startsWith("workspace:") && !publicNames.has(dependency)) {
        fail(`${name} depends on unpublished ${dependency}`);
      }
    }
  }
}

function alreadyPublished(name, version) {
  const result = spawnSync(
    "npm",
    ["view", `${name}@${version}`, "version", "--registry", registry],
    { cwd: root, env: publishEnv, encoding: "utf8" },
  );
  if (result.status === 0) return result.stdout.trim() === version;
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (output.includes("E404") || output.includes("404")) return false;
  fail(`Could not check ${name}@${version} on npm.\n${output}`);
}

function pnpm(args) {
  const executable = process.env.PNPM;
  const result = executable
    ? spawnSync(executable, args, { cwd: root, env: publishEnv, stdio: "inherit" })
    : spawnSync("npx", ["--yes", "pnpm@12.0.0", ...args], {
        cwd: root,
        env: publishEnv,
        stdio: "inherit",
      });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
