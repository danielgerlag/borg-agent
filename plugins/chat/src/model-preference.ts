import type { ModelDescriptor } from "@borg/contracts";

const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  "borg.anthropic": "Anthropic",
  "borg.azure": "Azure",
  "borg.copilot": "Copilot",
  "borg.mock-llm": "Demo",
  "borg.ollama": "Ollama",
  "borg.openai": "OpenAI",
  "borg.openrouter": "OpenRouter",
};

const MODEL_LABELS: Readonly<Record<string, string>> = {
  "mock:scripted": "Built-in demo model",
  "claude-sonnet-5": "Claude Sonnet 5",
  "claude-haiku-4-5": "Claude Haiku 4.5",
  "claude-opus-5": "Claude Opus 5",
  "gpt-5-mini": "GPT-5 Mini",
  "gpt-5-nano": "GPT-5 Nano",
  "gpt-5": "GPT-5",
};

export function displayProviderName(providerId: string): string {
  return (
    PROVIDER_LABELS[providerId] ??
    providerId.replace(/^borg\./, "").replace(/[-_.]+/g, " ")
  );
}

export function displayModelId(modelId: string): string {
  return MODEL_LABELS[modelId] ?? modelId.replace(/^[^:]+:/, "");
}

export function displayModelName(model: ModelDescriptor): string {
  return `${displayProviderName(model.providerId)} · ${displayModelId(model.modelId)}`;
}

export function matchesModelPreference(
  model: ModelDescriptor,
  preference: string,
): boolean {
  const separator = preference.indexOf(":");
  const providerPattern =
    separator > 0 ? preference.slice(0, separator) : "*";
  const modelPattern =
    separator > 0 ? preference.slice(separator + 1) : preference;
  const matches = (candidate: string, pattern: string): boolean =>
    pattern === "*" ||
    (pattern.endsWith("*")
      ? candidate.startsWith(pattern.slice(0, -1))
      : candidate === pattern);
  return (
    matches(model.providerId, providerPattern) &&
    matches(model.modelId, modelPattern)
  );
}
