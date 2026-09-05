import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginsDirectory = path.join(projectRoot, "plugins");
const failures = [];
const kernelSourceDirectory = path.join(projectRoot, "packages/kernel/src");
const appSourceDirectory = path.join(projectRoot, "apps/desktop/src");

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

for (const entry of await readdir(pluginsDirectory, { withFileTypes: true })) {
  if (!entry.isDirectory()) {
    continue;
  }
  const pluginDirectory = path.join(pluginsDirectory, entry.name);
  const packageJson = JSON.parse(
    await readFile(path.join(pluginDirectory, "package.json"), "utf8"),
  );
  for (const field of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
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
        failures.push(
          `${packageJson.name} declares forbidden plugin dependency ${dependency}`,
        );
      }
    }
  }

  for (const filename of await sourceFiles(path.join(pluginDirectory, "src"))) {
    const source = await readFile(filename, "utf8");
    const imports =
      source.matchAll(
        /\b(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)["']([^"']+)["']/g,
      );
    for (const match of imports) {
      const specifier = match[1];
      if (!specifier) {
        continue;
      }
      if (
        entry.name === "graphs" &&
        (specifier === "langgraph" || specifier.startsWith("@langchain/langgraph"))
      ) {
        failures.push(
          `${path.relative(projectRoot, filename)} imports forbidden graph engine ${specifier}`,
        );
      }
      if (specifier.startsWith("@borg/plugin-") && specifier !== "@borg/plugin-sdk") {
        failures.push(
          `${path.relative(projectRoot, filename)} imports forbidden plugin package ${specifier}`,
        );
      }
      if (specifier.startsWith(".")) {
        const resolved = path.resolve(path.dirname(filename), specifier);
        if (
          resolved.startsWith(`${pluginsDirectory}${path.sep}`) &&
          !resolved.startsWith(`${pluginDirectory}${path.sep}`)
        ) {
          failures.push(
            `${path.relative(projectRoot, filename)} crosses into another plugin via ${specifier}`,
          );
        }
      }
    }
  }
}

if (failures.length > 0) {
  throw new Error(`Plugin boundary check failed:\n${failures.join("\n")}`);
}

console.log("Plugin import boundaries are valid.");
