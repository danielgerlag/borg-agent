import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginsDirectory = path.join(projectRoot, "plugins");
const failures = [];
const kernelSourceDirectory = path.join(projectRoot, "packages/kernel/src");
const contractsSourceDirectory = path.join(projectRoot, "packages/contracts/src");
const appSourceDirectory = path.join(projectRoot, "apps/desktop/src");
const distributionsDirectory = path.join(projectRoot, "distributions");
const dependencyFields = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(entryPath)));
    } else if (/\.[cm]?[jt]sx?$/.test(entry.name)) {
      files.push(entryPath);
    }
  }
  return files;
}

function importSpecifiers(source) {
  return [...source.matchAll(
    /\b(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)["']([^"']+)["']/g,
  )]
    .map((match) => match[1])
    .filter((specifier) => Boolean(specifier));
}

function dependencyName(specifier) {
  if (!specifier.startsWith("@")) {
    return specifier.split("/")[0];
  }
  const slash = specifier.indexOf("/");
  if (slash === -1) {
    return specifier;
  }
  const second = specifier.indexOf("/", slash + 1);
  return second === -1 ? specifier : specifier.slice(0, second);
}

function isPluginContractSpecifier(specifier) {
  const name = dependencyName(specifier);
  return (
    name.startsWith("@borg/plugin-") &&
    name !== "@borg/plugin-sdk" &&
    specifier === `${name}/contract`
  );
}

function isAllowedContractFileImport(specifier) {
  if (specifier === "zod" || specifier === "@borg/contracts") {
    return true;
  }
  return (
    /^@borg\/contracts\/[a-z0-9-]+$/.test(specifier) ||
    isPluginContractSpecifier(specifier)
  );
}

function isInside(directory, candidate) {
  const relative = path.relative(directory, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

async function fileExists(filename) {
  try {
    await access(filename);
    return true;
  } catch {
    return false;
  }
}

const pluginSourceFiles = (
  await Promise.all(
    (await readdir(pluginsDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) =>
        sourceFiles(path.join(pluginsDirectory, entry.name, "src")),
      ),
  )
).flat();
const productionFiles = [
  ...(await sourceFiles(kernelSourceDirectory)),
  ...(await sourceFiles(appSourceDirectory)),
  ...pluginSourceFiles,
];
for (const filename of productionFiles) {
  const source = await readFile(filename, "utf8");
  const relative = path.relative(projectRoot, filename);
  if (/\bModelRouter\b|model-router/.test(source)) {
    failures.push(`${relative} references the removed ModelRouter path`);
  }
  if (
    /\bprovider\.complete\s*\(/.test(source) &&
    relative !== "packages/kernel/src/model-gateway.ts"
  ) {
    failures.push(`${relative} invokes a provider completion outside ModelGateway`);
  }
  if (/\bcost\.record\s*\(|["']cost\.record["']/.test(source)) {
    failures.push(`${relative} exposes the removed plugin cost writer`);
  }
}

// The kernel and the workspace packages it depends on must load in plain Node.
const electronImport =
  /(?:\bfrom\s+|\brequire\s*\(\s*|\bimport\s*\(\s*|\bimport\s+)["']electron(?:\/[^"']*)?["']/;
// Distributions run on that kernel and must load in plain Node as well.
const distributionDirectories = (
  await readdir(distributionsDirectory, { withFileTypes: true })
)
  .filter((entry) => entry.isDirectory())
  .map((entry) => path.join(distributionsDirectory, entry.name));
for (const packageDirectory of [
  ...["kernel", "plugin-sdk", "contracts"].map((name) =>
    path.join(projectRoot, "packages", name),
  ),
  ...distributionDirectories,
]) {
  const packageLabel = path.relative(projectRoot, packageDirectory).split(path.sep).join("/");
  const hostAgnostic = packageLabel.startsWith("distributions/")
    ? "distributions must stay host-agnostic"
    : "the kernel must stay host-agnostic";
  const manifest = JSON.parse(
    await readFile(path.join(packageDirectory, "package.json"), "utf8"),
  );
  for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
    if (manifest[field]?.electron !== undefined) {
      failures.push(
        `${packageLabel}/package.json depends on electron; ${hostAgnostic}`,
      );
    }
  }
  for (const filename of await sourceFiles(path.join(packageDirectory, "src"))) {
    if (electronImport.test(await readFile(filename, "utf8"))) {
      failures.push(
        `${path.relative(projectRoot, filename)} imports electron; ${hostAgnostic}`,
      );
    }
  }
}

const contractsSource = await readFile(
  path.join(projectRoot, "packages/contracts/src/index.ts"),
  "utf8",
);
if (
  !/modelGatewayRequestSchema[\s\S]*executionId:\s*executionIdSchema[\s\S]*operationKey:\s*modelOperationKeySchema/.test(
    contractsSource,
  )
) {
  failures.push(
    "Model gateway requests must require executionId and operationKey",
  );
}

const pluginSdkSource = await readFile(
  path.join(projectRoot, "packages/plugin-sdk/src/index.ts"),
  "utf8",
);
if (!/request:\s*Omit<ModelGatewayRequest,\s*"tools">/.test(pluginSdkSource)) {
  failures.push("PluginModels.complete must use the secured gateway request");
}
if (/record\(record:\s*UsageRecord\)/.test(pluginSdkSource)) {
  failures.push("PluginCost must not expose a usage writer");
}

for (const filename of await sourceFiles(contractsSourceDirectory)) {
  const source = await readFile(filename, "utf8");
  const relative = path.relative(projectRoot, filename);
  for (const specifier of importSpecifiers(source)) {
    if (specifier === "zod") {
      continue;
    }
    if (specifier.startsWith(".")) {
      const resolved = path.resolve(path.dirname(filename), specifier);
      if (!isInside(contractsSourceDirectory, resolved)) {
        failures.push(
          `${relative} imports ${specifier}, which leaves packages/contracts/src`,
        );
      }
      continue;
    }
    failures.push(
      `${relative} imports ${specifier}; packages/contracts/src may import only zod and relative files inside that directory`,
    );
  }
}

// The kernel surface (kernel and plugin-sdk) sees only the @borg/contracts
// root: no capability subpaths, no plugins, and no relative path out of its src.
for (const packageName of ["kernel", "plugin-sdk"]) {
  const sourceDirectory = path.join(projectRoot, "packages", packageName, "src");
  for (const filename of await sourceFiles(sourceDirectory)) {
    const source = await readFile(filename, "utf8");
    const relative = path.relative(projectRoot, filename);
    for (const specifier of importSpecifiers(source)) {
      if (specifier.startsWith(".")) {
        if (!isInside(sourceDirectory, path.resolve(path.dirname(filename), specifier))) {
          failures.push(
            `${relative} imports ${specifier}, which leaves packages/${packageName}/src`,
          );
        }
        continue;
      }
      const name = dependencyName(specifier);
      if (name === "@borg/contracts" && specifier !== "@borg/contracts") {
        failures.push(
          `${relative} imports ${specifier}; packages/${packageName} may import @borg/contracts only as @borg/contracts`,
        );
      }
      if (name.startsWith("@borg/plugin-") && name !== "@borg/plugin-sdk") {
        failures.push(
          `${relative} imports ${specifier}; packages/${packageName} may import no @borg/plugin-* package other than @borg/plugin-sdk`,
        );
      }
    }
  }
}

// The kernel surface never depends on a distribution: distributions sit on top.
for (const packageName of ["kernel", "plugin-sdk", "contracts"]) {
  const packageDirectory = path.join(projectRoot, "packages", packageName);
  const manifest = JSON.parse(
    await readFile(path.join(packageDirectory, "package.json"), "utf8"),
  );
  for (const field of dependencyFields) {
    for (const dependency of Object.keys(manifest[field] ?? {})) {
      if (dependency.startsWith("@borg/distribution-")) {
        failures.push(
          `packages/${packageName}/package.json lists ${dependency} in ${field}; packages/${packageName} must not depend on a distribution`,
        );
      }
    }
  }
  for (const filename of await sourceFiles(path.join(packageDirectory, "src"))) {
    for (const specifier of importSpecifiers(await readFile(filename, "utf8"))) {
      if (dependencyName(specifier).startsWith("@borg/distribution-")) {
        failures.push(
          `${path.relative(projectRoot, filename)} imports ${specifier}; packages/${packageName} must not import a distribution`,
        );
      }
    }
  }
}

// A distribution declares plugins by id and runs on the kernel. Its sources
// may import only @borg/kernel and zod, and relative files inside its own src.
for (const distributionDirectory of distributionDirectories) {
  const sourceDirectory = path.join(distributionDirectory, "src");
  const label = path.relative(projectRoot, sourceDirectory).split(path.sep).join("/");
  for (const filename of await sourceFiles(sourceDirectory)) {
    const relative = path.relative(projectRoot, filename);
    for (const specifier of importSpecifiers(await readFile(filename, "utf8"))) {
      if (specifier.startsWith(".")) {
        if (!isInside(sourceDirectory, path.resolve(path.dirname(filename), specifier))) {
          failures.push(`${relative} imports ${specifier}, which leaves ${label}`);
        }
        continue;
      }
      if (specifier !== "@borg/kernel" && specifier !== "zod") {
        failures.push(
          `${relative} imports ${specifier}; ${label} may import only @borg/kernel, zod, and relative files inside that directory`,
        );
      }
    }
  }
}

// The @borg/contracts root export is the kernel surface. It must not reach any
// file that backs a capability subpath export (e.g. ./web-search).
const contractsPackage = JSON.parse(
  await readFile(path.join(projectRoot, "packages/contracts/package.json"), "utf8"),
);
const capabilitySourceFiles = new Map();
for (const [subpath, target] of Object.entries(contractsPackage.exports ?? {})) {
  if (subpath === ".") {
    continue;
  }
  const match = /^\.\/dist\/(.+)\.js$/.exec(target);
  if (!match) {
    failures.push(
      `packages/contracts exports ${subpath} as ${JSON.stringify(target)}; expected ./dist/<name>.js`,
    );
    continue;
  }
  capabilitySourceFiles.set(
    path.join(contractsSourceDirectory, `${match[1]}.ts`),
    subpath,
  );
}
const reachableFromRoot = new Set();
const rootQueue = [path.join(contractsSourceDirectory, "index.ts")];
while (rootQueue.length > 0) {
  const filename = rootQueue.pop();
  if (reachableFromRoot.has(filename)) {
    continue;
  }
  reachableFromRoot.add(filename);
  const capability = capabilitySourceFiles.get(filename);
  if (capability !== undefined) {
    failures.push(
      `packages/contracts/src/index.ts reaches ${path.relative(projectRoot, filename)}, which backs the ${capability} subpath; the root export must not include capability schemas`,
    );
    continue;
  }
  for (const specifier of importSpecifiers(await readFile(filename, "utf8"))) {
    if (specifier.startsWith(".")) {
      const resolved = path.resolve(path.dirname(filename), specifier);
      rootQueue.push(resolved.endsWith(".ts") ? resolved : `${resolved}.ts`);
    }
  }
}

// Only contract modules declare bus commands and events. The kernel tests
// allowlisted here define throwaway commands and events to exercise the bus.
const definitionCallAllowlist = new Map([
  ["packages/kernel/test/command-event-bus.test.ts", "exercises CommandEventBus with ad-hoc definitions"],
  ["packages/kernel/test/execution-handoff.test.ts", "exercises execution grant handoff with ad-hoc definitions"],
  ["packages/kernel/test/plugin-manager.test.ts", "exercises PluginManager command and event declaration checks"],
]);
async function workspaceSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist") {
      continue;
    }
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await workspaceSourceFiles(entryPath)));
    } else if (/\.[cm]?tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
      files.push(entryPath);
    }
  }
  return files;
}
for (const root of ["apps", "distributions", "packages", "plugins", "tests"]) {
  for (const filename of await workspaceSourceFiles(path.join(projectRoot, root))) {
    const relative = path.relative(projectRoot, filename).split(path.sep).join("/");
    if (
      relative.startsWith("packages/contracts/src/") ||
      /^plugins\/[^/]+\/src\/contract\.ts$/.test(relative) ||
      definitionCallAllowlist.has(relative)
    ) {
      continue;
    }
    if (/\bdefine(?:Command|Event)\s*\(/.test(await readFile(filename, "utf8"))) {
      failures.push(
        `${relative} calls defineCommand/defineEvent; only packages/contracts/src and plugins/*/src/contract.ts declare bus contracts`,
      );
    }
  }
}

const pluginDependencies = new Map();
for (const entry of await readdir(pluginsDirectory, { withFileTypes: true })) {
  if (!entry.isDirectory()) {
    continue;
  }
  const pluginDirectory = path.join(pluginsDirectory, entry.name);
  const packageJson = JSON.parse(
    await readFile(path.join(pluginDirectory, "package.json"), "utf8"),
  );
  const contractImports = new Set();
  for (const filename of await sourceFiles(path.join(pluginDirectory, "src"))) {
    const source = await readFile(filename, "utf8");
    const relative = path.relative(projectRoot, filename);
    const relativeToPlugin = path.relative(pluginDirectory, filename);
    for (const specifier of importSpecifiers(source)) {
      if (
        entry.name === "graphs" &&
        (specifier === "langgraph" || specifier.startsWith("@langchain/langgraph"))
      ) {
        failures.push(
          `${relative} imports forbidden graph engine ${specifier}`,
        );
      }
      if (specifier.startsWith("@borg/plugin-") && specifier !== "@borg/plugin-sdk") {
        const name = dependencyName(specifier);
        if (isPluginContractSpecifier(specifier)) {
          contractImports.add(name);
          if (!Object.hasOwn(packageJson.dependencies ?? {}, name)) {
            failures.push(
              `${relative} imports ${specifier} but ${packageJson.name} does not list ${name} in dependencies`,
            );
          }
        } else {
          failures.push(
            `${relative} imports ${specifier}; plugin sources may import ${name} only as ${name}/contract`,
          );
        }
      }
      if (specifier.startsWith(".")) {
        const resolved = path.resolve(path.dirname(filename), specifier);
        if (
          resolved.startsWith(`${pluginsDirectory}${path.sep}`) &&
          !resolved.startsWith(`${pluginDirectory}${path.sep}`)
        ) {
          failures.push(
            `${relative} crosses into another plugin via ${specifier}`,
          );
        }
      }
    }
    if (relativeToPlugin === path.join("src", "contract.ts")) {
      for (const specifier of importSpecifiers(source)) {
        if (!isAllowedContractFileImport(specifier)) {
          failures.push(
            `${relative} imports ${specifier}; src/contract.ts may import only zod, @borg/contracts, @borg/contracts/<subpath>, or @borg/plugin-<name>/contract`,
          );
        }
      }
    }
  }

  for (const field of dependencyFields) {
    for (const dependency of Object.keys(packageJson[field] ?? {})) {
      if (
        entry.name === "graphs" &&
        (dependency === "langgraph" || dependency.startsWith("@langchain/langgraph"))
      ) {
        failures.push(
          `${packageJson.name} declares forbidden graph engine dependency ${dependency}`,
        );
      }
      if (dependency.startsWith("@borg/plugin-") && dependency !== "@borg/plugin-sdk") {
        if (!contractImports.has(dependency)) {
          failures.push(
            `${packageJson.name} lists ${dependency} in ${field}, but no source file imports ${dependency}/contract`,
          );
        }
      }
    }
  }

  pluginDependencies.set(
    packageJson.name,
    dependencyFields.flatMap((field) =>
      Object.keys(packageJson[field] ?? {}).filter(
        (dependency) =>
          dependency.startsWith("@borg/plugin-") && dependency !== "@borg/plugin-sdk",
      ),
    ),
  );

  const contractExport = packageJson.exports?.["./contract"];
  if (
    contractExport === undefined &&
    (await fileExists(path.join(pluginDirectory, "src", "contract.ts")))
  ) {
    failures.push(
      `${packageJson.name} has src/contract.ts but does not export ./contract`,
    );
  }
  if (contractExport !== undefined) {
    if (contractExport !== "./dist/contract.js") {
      failures.push(
        `${packageJson.name} exports ./contract as ${JSON.stringify(contractExport)}; expected "./dist/contract.js"`,
      );
    }
    if (!(await fileExists(path.join(pluginDirectory, "src", "contract.ts")))) {
      failures.push(
        `${packageJson.name} exports ./contract but src/contract.ts does not exist`,
      );
    }
    // The build script names the tsconfig that emits dist/ (most plugins use
    // tsconfig.main.json; main-only plugins such as channel-mock use tsconfig.json).
    const buildTsconfig =
      /\btsc\s+-p\s+(\S+)/.exec(packageJson.scripts?.build ?? "")?.[1] ??
      "tsconfig.main.json";
    const buildTsconfigPath = path.join(pluginDirectory, buildTsconfig);
    if (!(await fileExists(buildTsconfigPath))) {
      failures.push(
        `${packageJson.name} exports ./contract but its build tsconfig ${buildTsconfig} does not exist`,
      );
    } else {
      const tsconfig = JSON.parse(await readFile(buildTsconfigPath, "utf8"));
      const include = tsconfig.include ?? [];
      if (
        !["src/contract.ts", "src/*.ts", "src/**/*.ts"].some((entry) =>
          include.includes(entry),
        )
      ) {
        failures.push(
          `${packageJson.name} exports ./contract but ${buildTsconfig} include does not contain "src/contract.ts"`,
        );
      }
    }
  }
}

// Plugin-to-plugin contract dependencies must form a DAG, or `pnpm -r build`
// can't order them and a clean build fails with unresolved /contract imports.
const visitState = new Map();
const reportedCycles = new Set();
function visitPlugin(name, trail) {
  if (visitState.get(name) === "done") {
    return;
  }
  if (visitState.get(name) === "active") {
    const cycle = [...trail.slice(trail.indexOf(name)), name];
    const key = cycle.slice(0, -1).sort().join(" ");
    if (!reportedCycles.has(key)) {
      reportedCycles.add(key);
      failures.push(`plugin dependency cycle: ${cycle.join(" -> ")}`);
    }
    return;
  }
  visitState.set(name, "active");
  for (const dependency of pluginDependencies.get(name) ?? []) {
    visitPlugin(dependency, [...trail, name]);
  }
  visitState.set(name, "done");
}
for (const name of [...pluginDependencies.keys()].sort()) {
  visitPlugin(name, []);
}

if (failures.length > 0) {
  throw new Error(`Plugin boundary check failed:\n${failures.join("\n")}`);
}

console.log("Plugin import boundaries are valid.");
