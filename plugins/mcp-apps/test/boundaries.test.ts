import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const pluginRoot = fileURLToPath(new URL("..", import.meta.url));

async function sourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(entryPath)));
    } else if (/\.[cm]?[jt]sx?$/.test(entry.name)) {
      files.push(entryPath);
    }
  }
  return files;
}

function isHostRuntime(specifier: string): boolean {
  return (
    specifier === "@borg/kernel" ||
    specifier === "electron" ||
    specifier.startsWith("node:")
  );
}

function isPluginContract(specifier: string): boolean {
  return /^@borg\/plugin-[^/]+\/contract$/.test(specifier);
}

describe("MCP Apps package boundaries", () => {
  it("uses contracts and reaches other plugins only through /contract", async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(pluginRoot, "package.json"), "utf8"),
    ) as Record<string, unknown>;
    const dependencyFields = [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ] as const;
    const dependencies = dependencyFields.flatMap((field) =>
      Object.keys(
        (packageJson[field] as Record<string, string> | undefined) ?? {},
      ),
    );
    const imports: string[] = [];
    for (const filename of await sourceFiles(path.join(pluginRoot, "src"))) {
      const source = await readFile(filename, "utf8");
      for (const match of source.matchAll(
        /\b(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)["']([^"']+)["']/g,
      )) {
        if (match[1]) {
          imports.push(match[1]);
        }
      }
    }

    const contractPackages = new Set(
      imports
        .filter(isPluginContract)
        .map((specifier) => specifier.slice(0, -"/contract".length)),
    );
    expect(
      dependencies.filter(
        (dependency) =>
          isHostRuntime(dependency) ||
          (dependency.startsWith("@borg/plugin-") &&
            dependency !== "@borg/plugin-sdk" &&
            !contractPackages.has(dependency)),
      ),
    ).toEqual([]);
    expect(
      imports.filter(
        (specifier) =>
          isHostRuntime(specifier) ||
          (specifier.startsWith("@borg/plugin-") &&
            specifier !== "@borg/plugin-sdk" &&
            !isPluginContract(specifier)),
      ),
    ).toEqual([]);
  });
});
