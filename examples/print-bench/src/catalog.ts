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

function hosted<
  const TName extends string,
  const TSettings extends boolean,
  TManifest extends BorgPluginManifest,
>(packageName: TName, manifest: TManifest, settings: TSettings) {
  pluginManifestSchema.parse(manifest);
  return { packageName, manifest, settings };
}

// Config and secrets activate before the rest. The remaining plugins run in this order.
export const benchPlugins = [
  hosted("@borg/plugin-config-sqlite", configSqliteManifest, false),
  hosted("@borg/plugin-secrets-dev", secretsDevManifest, false),
  hosted("@borg/plugin-security-prompt-injection", promptInjectionManifest, false),
  hosted("@borg/plugin-feedback", feedbackManifest, false),
  hosted("@borg/plugin-anthropic", anthropicManifest, true),
  hosted("@borg/plugin-azure", azureManifest, true),
  hosted("@borg/plugin-copilot", copilotManifest, true),
  hosted("@borg/plugin-mock-llm", mockLlmManifest, false),
  hosted("@borg/plugin-ollama", ollamaManifest, true),
  hosted("@borg/plugin-openai", openaiManifest, true),
  hosted("@borg/plugin-openrouter", openrouterManifest, true),
] as const;

type BenchPlugin = (typeof benchPlugins)[number];
type SettingsPlugin = Extract<BenchPlugin, { settings: true }>;

export type BenchPackageName = BenchPlugin["packageName"];
export type SettingsPackageName = SettingsPlugin["packageName"];
export type SettingsPluginId = SettingsPlugin["manifest"]["id"];
export type DemoPluginId = Extract<
  BenchPlugin,
  { packageName: "@borg/plugin-mock-llm" }
>["manifest"]["id"];

export function settingsPackageFor(pluginId: string): SettingsPackageName | undefined {
  const match = benchPlugins.find(
    (plugin): plugin is SettingsPlugin => plugin.settings && plugin.manifest.id === pluginId,
  );
  return match?.packageName;
}
