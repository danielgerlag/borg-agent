import type { ModelDescriptor } from "@borg/contracts";

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
