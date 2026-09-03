import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const graphRoot = fileURLToPath(new URL("..", import.meta.url));

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

function isLangGraph(specifier: string): boolean {
  return (
    specifier === "langgraph" ||
    specifier.startsWith("@langchain/langgraph")
  );
}

function isPluginPackage(specifier: string): boolean {
  return (
    specifier.startsWith("@borg/plugin-") && specifier !== "@borg/plugin-sdk"
  );
}

describe("graphs package boundaries", () => {
  it("has no LangGraph or plugin-package coupling and keeps both rejection rules", async () => {
    const packageJson = JSON.parse(
      await readFile(path.join(graphRoot, "package.json"), "utf8"),
    ) as Record<string, unknown>;
    const dependencyFields = [
      "dependencies",
      "devDependencies",
      "peerDependencies",
      "optionalDependencies",
    ] as const;
    const dependencies = dependencyFields.flatMap((field) =>
      Object.keys((packageJson[field] as Record<string, string> | undefined) ?? {}),
    );

    const imports: { file: string; specifier: string }[] = [];
    for (const filename of await sourceFiles(path.join(graphRoot, "src"))) {
      const source = await readFile(filename, "utf8");
      for (const match of source.matchAll(
        /\b(?:from\s+|import\s*\(\s*|import\s+|require\s*\(\s*)["']([^"']+)["']/g,
      )) {
        if (match[1]) {
          imports.push({
            file: path.relative(graphRoot, filename),
            specifier: match[1],
          });
        }
      }
    }

    expect(
      dependencies.filter(isLangGraph),
      "graphs package must not depend on LangGraph",
    ).toEqual([]);
    expect(
      dependencies.filter(isPluginPackage),
      "plugins may depend on the SDK but not other plugin packages",
    ).toEqual([]);
    expect(
      imports.filter(({ specifier }) => isLangGraph(specifier)),
      "graphs source must not import LangGraph",
    ).toEqual([]);
    expect(
      imports.filter(({ specifier }) => isPluginPackage(specifier)),
      "graphs source must not import another plugin package",
    ).toEqual([]);

    const boundaryCheck = await readFile(
      path.resolve(graphRoot, "../../scripts/check-plugin-boundaries.mjs"),
      "utf8",
    );
    expect(boundaryCheck).toContain('dependency === "langgraph"');
    expect(boundaryCheck).toContain(
      'dependency.startsWith("@langchain/langgraph")',
    );
    expect(boundaryCheck).toContain('specifier === "langgraph"');
    expect(boundaryCheck).toContain(
      'specifier.startsWith("@langchain/langgraph")',
    );
    expect(boundaryCheck).toContain(
      'dependency.startsWith("@borg/plugin-")',
    );
    expect(boundaryCheck).toContain('specifier.startsWith("@borg/plugin-")');
  });
});
