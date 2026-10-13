import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  defineDistribution,
  type Distribution,
  type PluginSource,
} from "@borg-agent/kernel";
import { pluginManifestSchema } from "@borg-agent/plugin-sdk";

const spineRequire = createRequire(__filename);

/**
 * Platform plugins every workplace distribution gets.
 * Domain plugins are appended by defineHarness, in the order the caller lists them.
 */
const PLATFORM_PLUGIN_IDS = [
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
  "borg.secrets.os",
  "borg.security.prompt-injection",
  "borg.themes",
] as const;

export const HARNESS_PLUGIN_PACKAGES: Readonly<Record<string, string>> = {
  "borg.anthropic": "@borg/plugin-anthropic",
  "borg.azure": "@borg/plugin-azure",
  "borg.config.sqlite": "@borg/plugin-config-sqlite",
  "borg.copilot": "@borg/plugin-copilot",
  "borg.feedback": "@borg/plugin-feedback",
  "borg.mock-llm": "@borg/plugin-mock-llm",
  "borg.ollama": "@borg/plugin-ollama",
  "borg.openai": "@borg/plugin-openai",
  "borg.openrouter": "@borg/plugin-openrouter",
  "borg.personas": "@borg/plugin-personas",
  "borg.secrets.dev": "@borg/plugin-secrets-dev",
  "borg.secrets.os": "@borg/plugin-secrets-os",
  "borg.security.prompt-injection": "@borg/plugin-security-prompt-injection",
  "borg.themes": "@borg/plugin-themes",
};

export interface HarnessDefinition {
  readonly id: string;
  readonly name: string;
  readonly plugins: readonly string[];
  /** Which secret-store plugins to declare. The host activates one of them. */
  readonly secrets?: "dev" | "os" | "both";
  readonly version?: string;
}

export function defineHarness(definition: HarnessDefinition): Distribution {
  const secrets = definition.secrets ?? "both";
  const platform = PLATFORM_PLUGIN_IDS.filter((id) => {
    if (id === "borg.secrets.dev") {
      return secrets !== "os";
    }
    if (id === "borg.secrets.os") {
      return secrets !== "dev";
    }
    return true;
  });
  return defineDistribution({
    id: definition.id,
    name: definition.name,
    version: definition.version ?? "0.1.0",
    kernel: "^0.1.0",
    plugins: [...platform, ...definition.plugins],
    defaults: {
      models: ["borg.mock-llm:mock:scripted"],
    },
  });
}

type PluginMain = Awaited<ReturnType<PluginSource["loadMain"]>>;

function readManifest(packageName: string): PluginSource["manifest"] {
  const mainPath = spineRequire.resolve(`${packageName}/main`);
  const manifestPath = join(dirname(mainPath), "..", "borg.plugin.json");
  return pluginManifestSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8")));
}

function loadSpineMain(id: string): Promise<PluginMain> {
  switch (id) {
    case "borg.anthropic":
      return import("@borg/plugin-anthropic/main").then((loaded) => loaded.default);
    case "borg.azure":
      return import("@borg/plugin-azure/main").then((loaded) => loaded.default);
    case "borg.config.sqlite":
      return import("@borg/plugin-config-sqlite/main").then((loaded) => loaded.default);
    case "borg.copilot":
      return import("@borg/plugin-copilot/main").then((loaded) => loaded.default);
    case "borg.feedback":
      return import("@borg/plugin-feedback/main").then((loaded) => loaded.default);
    case "borg.mock-llm":
      return import("@borg/plugin-mock-llm/main").then((loaded) => loaded.default);
    case "borg.ollama":
      return import("@borg/plugin-ollama/main").then((loaded) => loaded.default);
    case "borg.openai":
      return import("@borg/plugin-openai/main").then((loaded) => loaded.default);
    case "borg.openrouter":
      return import("@borg/plugin-openrouter/main").then((loaded) => loaded.default);
    case "borg.personas":
      return import("@borg/plugin-personas/main").then((loaded) => loaded.default);
    case "borg.secrets.dev":
      return import("@borg/plugin-secrets-dev/main").then((loaded) => loaded.default);
    case "borg.secrets.os":
      return import("@borg/plugin-secrets-os/main").then((loaded) => loaded.default);
    case "borg.security.prompt-injection":
      return import("@borg/plugin-security-prompt-injection/main").then(
        (loaded) => loaded.default,
      );
    case "borg.themes":
      return import("@borg/plugin-themes/main").then((loaded) => loaded.default);
    default:
      return Promise.reject(new Error(`Harness spine has no main for ${id}`));
  }
}

/** Plugin sources for a harness distribution. `extras` supplies the domain plugins. */
export function harnessSources(
  distribution: Distribution,
  extras: Readonly<Record<string, PluginSource>> = {},
): readonly PluginSource[] {
  return distribution.plugins.map((entry) => {
    const extra = extras[entry.id];
    if (extra) {
      return extra;
    }
    const packageName = HARNESS_PLUGIN_PACKAGES[entry.id];
    if (!packageName) {
      throw new Error(`Harness spine has no package for ${entry.id}`);
    }
    return {
      manifest: readManifest(packageName),
      loadMain: () => loadSpineMain(entry.id),
    };
  });
}
