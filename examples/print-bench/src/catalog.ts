import {
  pluginManifestSchema,
  type BorgPluginManifest,
} from "@borg-agent/plugin-sdk";
import configSqliteManifest from "@borg/plugin-config-sqlite/borg.plugin.json" with { type: "json" };
import secretsDevManifest from "@borg/plugin-secrets-dev/borg.plugin.json" with { type: "json" };
import promptInjectionManifest from "@borg/plugin-security-prompt-injection/borg.plugin.json" with { type: "json" };
import feedbackManifest from "@borg/plugin-feedback/borg.plugin.json" with { type: "json" };
import anthropicManifest from "@borg/plugin-anthropic/borg.plugin.json" with { type: "json" };
import azureManifest from "@borg/plugin-azure/borg.plugin.json" with { type: "json" };
import copilotManifest from "@borg/plugin-copilot/borg.plugin.json" with { type: "json" };
import mockLlmManifest from "@borg/plugin-mock-llm/borg.plugin.json" with { type: "json" };
import ollamaManifest from "@borg/plugin-ollama/borg.plugin.json" with { type: "json" };
import openaiManifest from "@borg/plugin-openai/borg.plugin.json" with { type: "json" };
import openrouterManifest from "@borg/plugin-openrouter/borg.plugin.json" with { type: "json" };

function hosted<const TName extends string, TManifest extends BorgPluginManifest>(
  packageName: TName,
  manifest: TManifest,
) {
  pluginManifestSchema.parse(manifest);
  return { packageName, manifest };
}

// Config and secrets activate before the rest. The remaining plugins run in this order.
export const benchPlugins = [
  hosted("@borg/plugin-config-sqlite", configSqliteManifest),
  hosted("@borg/plugin-secrets-dev", secretsDevManifest),
  hosted("@borg/plugin-security-prompt-injection", promptInjectionManifest),
  hosted("@borg/plugin-feedback", feedbackManifest),
  hosted("@borg/plugin-anthropic", anthropicManifest),
  hosted("@borg/plugin-azure", azureManifest),
  hosted("@borg/plugin-copilot", copilotManifest),
  hosted("@borg/plugin-mock-llm", mockLlmManifest),
  hosted("@borg/plugin-ollama", ollamaManifest),
  hosted("@borg/plugin-openai", openaiManifest),
  hosted("@borg/plugin-openrouter", openrouterManifest),
] as const;

export type BenchPackageName = (typeof benchPlugins)[number]["packageName"];
