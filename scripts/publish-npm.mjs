import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const registry = "https://registry.npmjs.org";
const repositoryUrl = "git+https://github.com/danielgerlag/borg-agent.git";

// The npm org "borg" is taken. Publish under the borg-agent org.
// The packed name, dependency names, and import specifiers are rewritten to match.
const packages = [
  ["@borg/contracts", "@borg-agent/contracts", "packages/contracts"],
  ["@borg/plugin-sdk", "@borg-agent/plugin-sdk", "packages/plugin-sdk"],
  ["@borg/kernel", "@borg-agent/kernel", "packages/kernel"],
];
const publishedNames = new Map(packages.map(([workspace, npmName]) => [workspace, npmName]));
const replacements = [...publishedNames.entries()].sort((a, b) => b[0].length - a[0].length);
const publicNames = new Set(publishedNames.keys());
const dependencyFields = ["dependencies", "peerDependencies", "optionalDependencies", "devDependencies"];
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

for (const [name, , directory] of packages) {
  const manifest = readManifest(directory);
  assertPublishable(name, directory, manifest);
  const packed = pack(name);
  try {
    const rewritten = rewriteTree(packed.packageDir);
    assertRewritten(name, packed.manifest, rewritten);
    const npmName = publishedNames.get(name);
    if (dryRun) {
      const dependencies = dependencyFields.flatMap((field) =>
        Object.entries(rewritten[field] ?? {}).map(([dependency, spec]) => `${dependency}@${spec}`),
      );
      console.log(
        `${name}@${manifest.version} packs as ${npmName}@${rewritten.version}${
          dependencies.length > 0 ? ` (${dependencies.join(", ")})` : ""
        }`,
      );
      continue;
    }
    if (alreadyPublished(npmName, rewritten.version)) {
      console.log(`${npmName}@${rewritten.version} is already on npm`);
      continue;
    }
    npmPublish(packed.packageDir);
  } finally {
    rmSync(packed.destination, { recursive: true, force: true });
  }
}

function readManifest(directory) {
  return JSON.parse(readFileSync(path.join(root, directory, "package.json"), "utf8"));
}

function assertPublishable(name, directory, manifest) {
  if (manifest.name !== name) {
    fail(`${directory} is named ${manifest.name}`);
  }
  if (!publishedNames.has(name)) {
    fail(`${name} has no npm name`);
  }
  if (manifest.private === true) {
    fail(`${name} is private`);
  }
  if (manifest.publishConfig?.access !== "public") {
    fail(`${name} does not set publishConfig.access to public`);
  }
  if (manifest.repository?.url !== repositoryUrl) {
    fail(`${name} repository.url must be ${repositoryUrl}`);
  }
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
  for (const field of dependencyFields) {
    for (const [dependency, spec] of Object.entries(manifest[field] ?? {})) {
      if (typeof spec === "string" && spec.startsWith("workspace:") && !publicNames.has(dependency)) {
        fail(`${name} depends on unpublished ${dependency}`);
      }
    }
  }
}

function pack(name) {
  const destination = mkdtempSync(path.join(tmpdir(), "borg-npm-"));
  pnpm(["--filter", name, "pack", "--pack-destination", destination]);
  const tarballs = readdirSync(destination).filter((entry) => entry.endsWith(".tgz"));
  if (tarballs.length !== 1) {
    fail(`expected one tarball for ${name}, found ${tarballs.join(", ") || "none"}`);
  }
  const extracted = spawnSync("tar", ["-xzf", path.join(destination, tarballs[0]), "-C", destination], {
    encoding: "utf8",
  });
  if (extracted.status !== 0) {
    fail(`could not extract ${tarballs[0]}\n${extracted.stderr ?? ""}`);
  }
  const packageDir = path.join(destination, "package");
  return {
    destination,
    packageDir,
    manifest: JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8")),
  };
}

function rewriteTree(packageDir) {
  const manifestPath = path.join(packageDir, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.name = publishedNames.get(manifest.name) ?? manifest.name;
  for (const field of dependencyFields) {
    if (manifest[field] == null) continue;
    manifest[field] = Object.fromEntries(
      Object.entries(manifest[field]).map(([dependency, spec]) => [
        publishedNames.get(dependency) ?? dependency,
        spec,
      ]),
    );
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  walk(packageDir, (file) => {
    if (file === manifestPath) return;
    if (file.endsWith(".map")) {
      const sourceMap = JSON.parse(readFileSync(file, "utf8"));
      if (Array.isArray(sourceMap.sourcesContent)) {
        sourceMap.sourcesContent = sourceMap.sourcesContent.map((source) =>
          typeof source === "string" ? rewriteSpecifiers(source) : source,
        );
        writeFileSync(file, JSON.stringify(sourceMap));
      }
      return;
    }
    if (!isSpecifierFile(file)) return;
    const original = readFileSync(file, "utf8");
    const rewritten = rewriteSpecifiers(original);
    if (rewritten !== original) writeFileSync(file, rewritten);
  });

  const leftovers = [];
  walk(packageDir, (file) => {
    const text = specifierText(file);
    if (text == null) return;
    for (const workspace of publishedNames.keys()) {
      if (text.includes(workspace)) {
        leftovers.push(`${path.relative(packageDir, file)} still mentions ${workspace}`);
      }
    }
  });
  if (leftovers.length > 0) {
    fail(`Package rewrite left workspace specifiers in the tarball.\n${leftovers.join("\n")}`);
  }
  return manifest;
}

function assertRewritten(workspaceName, packedManifest, rewritten) {
  const npmName = publishedNames.get(workspaceName);
  if (rewritten.name !== npmName) {
    fail(`rewrite named ${workspaceName} as ${rewritten.name}`);
  }
  if (rewritten.version !== packedManifest.version) {
    fail(`rewrite changed ${npmName} version from ${packedManifest.version} to ${rewritten.version}`);
  }
  for (const field of dependencyFields) {
    for (const dependency of Object.keys(packedManifest[field] ?? {})) {
      const npmDependency = publishedNames.get(dependency);
      if (npmDependency != null && rewritten[field]?.[npmDependency] == null) {
        fail(`${npmName} is missing rewritten dependency ${npmDependency}`);
      }
      if (typeof packedManifest[field][dependency] === "string" && packedManifest[field][dependency].startsWith("workspace:")) {
        fail(`${npmName} still has ${dependency} at ${packedManifest[field][dependency]}`);
      }
    }
  }
}

function rewriteSpecifiers(text) {
  let next = text;
  for (const [from, to] of replacements) {
    next = next.replaceAll(from, to);
  }
  return next;
}

function isSpecifierFile(file) {
  return file.endsWith(".js") || file.endsWith(".mjs") || file.endsWith(".cjs") || file.endsWith(".d.ts") || file.endsWith(".md");
}

function specifierText(file) {
  if (file.endsWith(".map")) {
    const sourceMap = JSON.parse(readFileSync(file, "utf8"));
    return (sourceMap.sourcesContent ?? []).filter((source) => typeof source === "string").join("\n");
  }
  if (path.basename(file) === "package.json" || isSpecifierFile(file)) {
    return readFileSync(file, "utf8");
  }
  return null;
}

function walk(directory, visit) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full, visit);
    else if (entry.isFile()) visit(full);
  }
}

function alreadyPublished(name, version) {
  const result = spawnSync(
    "npm",
    ["view", `${name}@${version}`, "version", "--registry", registry],
    { cwd: root, env: publishEnv, encoding: "utf8" },
  );
  if (result.status === 0) {
    return result.stdout.trim() === version;
  }
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (output.includes("E404") || output.includes("404")) return false;
  fail(`Could not check ${name}@${version} on npm.\n${output}`);
}

function npmPublish(directory) {
  const result = spawnSync(
    "npm",
    ["publish", directory, "--access", "public", "--no-git-checks", "--registry", registry],
    { cwd: root, env: publishEnv, stdio: "inherit" },
  );
  if (result.status !== 0) process.exit(result.status ?? 1);
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
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
