import type { PluginUiDefinition } from "@borg-agent/plugin-sdk";
import type { Component } from "solid-js";
import type { SettingsPackageName } from "../catalog.js";

type SettingsModule = { readonly default: PluginUiDefinition<Component> };

export const settingsLoaders = {
  "@borg/plugin-anthropic": () => import("@borg/plugin-anthropic/ui"),
  "@borg/plugin-azure": () => import("@borg/plugin-azure/ui"),
  "@borg/plugin-copilot": () => import("@borg/plugin-copilot/ui"),
  "@borg/plugin-ollama": () => import("@borg/plugin-ollama/ui"),
  "@borg/plugin-openai": () => import("@borg/plugin-openai/ui"),
  "@borg/plugin-openrouter": () => import("@borg/plugin-openrouter/ui"),
} satisfies Record<SettingsPackageName, () => Promise<SettingsModule>>;
