/**
 * Checks npm start and the plugin ids the test kernel boots.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { HARNESS_PLUGIN_PACKAGES } from "@borg/harness";
import { printBenchPluginIds } from "../src/boot.js";

const require = createRequire(import.meta.url);
const harnessRequire = createRequire(require.resolve("@borg/harness/package.json"));

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as {
  dependencies?: Record<string, string>;
  scripts?: { start?: string };
  borg?: { distribution?: string; workspace?: string };
};

const harnessPackage = JSON.parse(
  readFileSync(
    require.resolve("@borg/harness/package.json"),
    "utf8",
  ),
) as { dependencies?: Record<string, string> };

describe("print bench plugin catalog", () => {
  it("opens Design from npm start in this folder", () => {
    expect(packageJson.scripts?.start).toBe("node ../../scripts/dev-harness.mjs");
    expect(packageJson.borg?.distribution).toBe("borg.print-bench");
    expect(packageJson.borg?.workspace).toBe("example.print-bench.design");
  });

  it("boots the harness spine with the dev secret store, then the bench", () => {
    expect(printBenchPluginIds()).toEqual([
      "borg.anthropic",
      "borg.azure",
      "borg.config.sqlite",
      "borg.copilot",
      "borg.feedback",
      "borg.mock-llm",
      "borg.ollama",
      "borg.openai",
      "borg.openrouter",
      "borg.personas",
      "borg.secrets.dev",
      "borg.security.prompt-injection",
      "borg.themes",
      "example.print-bench",
    ]);
  });

  it("leaves the platform packages on the harness and out of this example", () => {
    const dependencies = packageJson.dependencies ?? {};
    expect(
      Object.keys(dependencies).filter((name) => name.startsWith("@borg/plugin-")),
    ).toEqual([]);
    expect(dependencies["@borg/harness"]).toBe("workspace:*");
    const spineIds = printBenchPluginIds().filter((id) => id !== "example.print-bench");
    for (const id of spineIds) {
      const packageName = HARNESS_PLUGIN_PACKAGES[id];
      expect(packageName, id).toBeTruthy();
      expect(harnessPackage.dependencies?.[packageName ?? ""]).toBe("workspace:*");
    }
    expect(harnessPackage.dependencies?.["@borg/plugin-chat"]).toBeUndefined();
    expect(harnessPackage.dependencies?.["@borg/plugin-bots"]).toBeUndefined();
    expect(harnessPackage.dependencies?.["@borg/plugin-graphs"]).toBeUndefined();
  });

  it("reads each spine manifest from the package", () => {
    for (const id of printBenchPluginIds()) {
      if (id === "example.print-bench") {
        continue;
      }
      const packageName = HARNESS_PLUGIN_PACKAGES[id];
      expect(packageName).toBeTruthy();
      const mainPath = harnessRequire.resolve(`${packageName}/main`);
      const manifest = JSON.parse(
        readFileSync(join(dirname(mainPath), "..", "borg.plugin.json"), "utf8"),
      ) as { id?: string };
      expect(manifest.id).toBe(id);
    }
  });
});
