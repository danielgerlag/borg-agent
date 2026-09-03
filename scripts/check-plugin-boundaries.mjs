import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginsDirectory = path.join(projectRoot, "plugins");
const failures = [];

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
