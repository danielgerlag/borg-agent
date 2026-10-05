import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { benchPlugins } from "../src/catalog.js";
import { printBenchPluginIds } from "../src/boot.js";

const require = createRequire(import.meta.url);

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { dependencies?: Record<string, string>; scripts?: { start?: string } };

describe("print bench plugin catalog", () => {
  it("opens Design from npm start in this folder", () => {
    expect(packageJson.scripts?.start).toBe("node start.cjs");
  });

  it("boots the catalog ids and then the bench itself", () => {
    expect(printBenchPluginIds()).toEqual([
      "borg.config.sqlite",
      "borg.secrets.dev",
      "borg.security.prompt-injection",
      "borg.feedback",
      "borg.anthropic",
      "borg.azure",
      "borg.copilot",
      "borg.mock-llm",
      "borg.ollama",
      "borg.openai",
      "borg.openrouter",
      "example.print-bench",
    ]);
  });

  it("depends on each hosted plugin and no other plugin package", () => {
    const dependencies = packageJson.dependencies ?? {};
    const catalogPackages = benchPlugins.map((plugin) => plugin.packageName);
    const pluginDependencies = Object.keys(dependencies).filter((name) =>
      name.startsWith("@borg/plugin-"),
    );
    expect(pluginDependencies.sort()).toEqual([...catalogPackages].sort());
    for (const packageName of catalogPackages) {
      expect(dependencies[packageName]).toBe("workspace:*");
    }
  });

  it("reads each manifest from the package export", () => {
    for (const plugin of benchPlugins) {
      const mainPath = require.resolve(`${plugin.packageName}/main`);
      const declared = JSON.parse(
        readFileSync(join(dirname(mainPath), "..", "package.json"), "utf8"),
      ) as { borg?: { id?: string }; exports?: Record<string, string> };
      expect(declared.borg?.id).toBe(plugin.manifest.id);
      expect(declared.exports?.["./borg.plugin.json"]).toBe("./borg.plugin.json");
      const exported = require.resolve(`${plugin.packageName}/borg.plugin.json`);
      expect(JSON.parse(readFileSync(exported, "utf8"))).toMatchObject({
        id: plugin.manifest.id,
      });
    }
  });
});
