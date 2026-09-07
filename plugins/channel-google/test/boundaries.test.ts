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

function isPluginPackage(specifier: string): boolean {
  return (
    specifier.startsWith("@borg/plugin-") && specifier !== "@borg/plugin-sdk"
  );
}

describe("channel-google package boundaries", () => {
  it("does not import another plugin package", async () => {
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
      Object.keys((packageJson[field] as Record<string, string> | undefined) ?? {}),
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

    expect(dependencies.filter(isPluginPackage)).toEqual([]);
    expect(imports.filter(isPluginPackage)).toEqual([]);
  });

  it("does not open sockets or use node:tls", async () => {
    for (const filename of await sourceFiles(path.join(pluginRoot, "src"))) {
      const source = await readFile(filename, "utf8");
      expect(source).not.toMatch(/\bnode:net\b/);
      expect(source).not.toMatch(/\bnode:tls\b/);
      expect(source).not.toMatch(/\bTlsService\b/);
      expect(source).not.toMatch(/\bglobalThis\.fetch\b/);
    }
  });

  it("pins Gmail to the Google origin in protocol constants", async () => {
    for (const filename of await sourceFiles(path.join(pluginRoot, "src"))) {
      const source = await readFile(filename, "utf8");
      const base = path.basename(filename);
      if (base !== "protocol.ts") {
        expect(source).not.toContain("https://gmail.googleapis.com");
        expect(source).not.toContain("https://accounts.google.com");
        expect(source).not.toContain("https://oauth2.googleapis.com");
      }
    }
  });
});
