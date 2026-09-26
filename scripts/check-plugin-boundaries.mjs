import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginsDirectory = path.join(projectRoot, "plugins");
const failures = [];
const kernelSourceDirectory = path.join(projectRoot, "packages/kernel/src");
const contractsSourceDirectory = path.join(projectRoot, "packages/contracts/src");
const appSourceDirectory = path.join(projectRoot, "apps/desktop/src");
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
for (const packageName of ["kernel", "plugin-sdk", "contracts"]) {
  const packageDirectory = path.join(projectRoot, "packages", packageName);
  const manifest = JSON.parse(
    await readFile(path.join(packageDirectory, "package.json"), "utf8"),
  );
  for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
    if (manifest[field]?.electron !== undefined) {
      failures.push(
        `packages/${packageName}/package.json depends on electron; the kernel must stay host-agnostic`,
      );
    }
  }
  for (const filename of await sourceFiles(path.join(packageDirectory, "src"))) {
    if (electronImport.test(await readFile(filename, "utf8"))) {
      failures.push(
        `${path.relative(projectRoot, filename)} imports electron; the kernel must stay host-agnostic`,
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

for (const filename of await sourceFiles(kernelSourceDirectory)) {
  const source = await readFile(filename, "utf8");
  const relative = path.relative(projectRoot, filename);
  for (const specifier of importSpecifiers(source)) {
    const name = dependencyName(specifier);
    if (name === "@borg/contracts" && specifier !== "@borg/contracts") {
      failures.push(
        `${relative} imports ${specifier}; kernel may import @borg/contracts only as @borg/contracts`,
      );
    }
    if (name.startsWith("@borg/plugin-") && name !== "@borg/plugin-sdk") {
      failures.push(
        `${relative} imports ${specifier}; kernel may import no @borg/plugin-* package other than @borg/plugin-sdk`,
      );
    }
  }
}

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

  const contractExport = packageJson.exports?.["./contract"];
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
    const tsconfig = JSON.parse(
      await readFile(path.join(pluginDirectory, "tsconfig.main.json"), "utf8"),
    );
    if (!tsconfig.include?.includes("src/contract.ts")) {
      failures.push(
        `${packageJson.name} exports ./contract but tsconfig.main.json include does not contain "src/contract.ts"`,
      );
    }
  }
}

if (failures.length > 0) {
  throw new Error(`Plugin boundary check failed:\n${failures.join("\n")}`);
}

console.log("Plugin import boundaries are valid.");
