import { z } from "@borg/plugin-sdk";
import { isSemanticVersion, isValidBorgEngineRange } from "./engine-range";
import { pluginIdPattern } from "./plugin-enablement";

const pluginIdSchema = z.string().regex(pluginIdPattern);

export interface DistributionPluginEntry {
  readonly id: string;
  /** Defaults to true. */
  readonly enabled?: boolean;
}

export interface DistributionDefinition {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  /** Range checked against KERNEL_API_VERSION. Same syntax as plugin `engines.borg`. */
  readonly kernel: string;
  readonly plugins: readonly (string | DistributionPluginEntry)[];
  readonly defaults?: {
    /** Model preferences ("providerId:modelId") for model requests that name no provider or model. Persona preferences are unaffected. */
    readonly models?: readonly string[];
  };
  readonly policy?: {
    /** Execution subjects whose results are detached from the parent execution instead of merged into it. */
    readonly detachedResults?: readonly {
      readonly pluginId: string;
      readonly subjectKinds: readonly string[];
    }[];
  };
}

export interface Distribution {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly kernel: string;
  readonly plugins: readonly {
    readonly id: string;
    readonly enabled: boolean;
  }[];
  readonly defaults: {
    readonly models?: readonly string[];
  };
  readonly policy: {
    readonly detachedResults?: readonly {
      readonly pluginId: string;
      readonly subjectKinds: readonly string[];
    }[];
  };
}

const modelPreferenceSchema = z.string().refine((value) => {
  const separator = value.indexOf(":");
  return (
    separator > 0 &&
    value.slice(separator + 1).length > 0 &&
    !/\s/.test(value)
  );
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) {
      deepFreeze(entry);
    }
    Object.freeze(value);
  }
  return value;
}

function rejectUnknownFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
  problems: string[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      problems.push(`${label} has unknown field ${key}`);
    }
  }
}

function readPluginEntry(
  value: unknown,
  index: number,
  problems: string[],
): { readonly id: string; readonly enabled: boolean } | undefined {
  if (typeof value === "string") {
    const parsed = pluginIdSchema.safeParse(value);
    if (!parsed.success) {
      problems.push(`plugin id ${JSON.stringify(value)} is invalid`);
      return undefined;
    }
    return { id: parsed.data, enabled: true };
  }

  if (!isRecord(value)) {
    problems.push(
      `plugins[${index}] must be a plugin id or { id, enabled }`,
    );
    return undefined;
  }

  rejectUnknownFields(value, ["id", "enabled"], `plugins[${index}]`, problems);
  const parsed = pluginIdSchema.safeParse(value.id);
  if (!parsed.success) {
    problems.push(`plugin id ${JSON.stringify(value.id)} is invalid`);
  }
  if ("enabled" in value && typeof value.enabled !== "boolean") {
    problems.push(`plugins[${index}].enabled must be a boolean`);
  }
  if (!parsed.success || ("enabled" in value && typeof value.enabled !== "boolean")) {
    return undefined;
  }
  return {
    id: parsed.data,
    enabled: value.enabled !== false,
  };
}

function readPlugins(
  value: unknown,
  problems: string[],
): Distribution["plugins"] | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    problems.push("plugins must include at least one plugin");
    return undefined;
  }

  const plugins: { id: string; enabled: boolean }[] = [];
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const [index, entry] of value.entries()) {
    const plugin = readPluginEntry(entry, index, problems);
    if (!plugin) {
      continue;
    }
    if (seen.has(plugin.id)) {
      duplicates.add(plugin.id);
    }
    seen.add(plugin.id);
    plugins.push(plugin);
  }
  for (const id of duplicates) {
    problems.push(`duplicate plugin id ${id}`);
  }
  return plugins.length === value.length ? plugins : undefined;
}

function readModels(
  value: unknown,
  problems: string[],
): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    problems.push("defaults.models must be an array of provider:model preferences");
    return undefined;
  }
  const models: string[] = [];
  for (const preference of value) {
    const parsed = modelPreferenceSchema.safeParse(preference);
    if (!parsed.success) {
      problems.push(
        `model preference ${JSON.stringify(preference)} must be provider:model`,
      );
      continue;
    }
    models.push(parsed.data);
  }
  return models.length === value.length ? models : undefined;
}

function readDefaults(
  value: unknown,
  problems: string[],
): Distribution["defaults"] | undefined {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    problems.push("defaults must be an object");
    return undefined;
  }
  rejectUnknownFields(value, ["models"], "defaults", problems);
  if (value.models === undefined) {
    return Object.keys(value).every((key) => key === "models") ? {} : undefined;
  }
  const models = readModels(value.models, problems);
  if (!models || Object.keys(value).some((key) => key !== "models")) {
    return undefined;
  }
  return { models };
}

function readDetachedEntry(
  value: unknown,
  index: number,
  problems: string[],
): { readonly pluginId: string; readonly subjectKinds: string[] } | undefined {
  if (!isRecord(value)) {
    problems.push(`policy.detachedResults[${index}] must be an object`);
    return undefined;
  }
  rejectUnknownFields(
    value,
    ["pluginId", "subjectKinds"],
    `policy.detachedResults[${index}]`,
    problems,
  );
  const pluginId = pluginIdSchema.safeParse(value.pluginId);
  if (!pluginId.success) {
    problems.push(
      `detached result plugin id ${JSON.stringify(value.pluginId)} is invalid`,
    );
  }
  const kinds = value.subjectKinds;
  const kindsValid =
    Array.isArray(kinds) &&
    kinds.length > 0 &&
    kinds.every((kind) => typeof kind === "string" && kind.length > 0);
  if (!kindsValid) {
    problems.push(
      `detached result ${JSON.stringify(value.pluginId)} must list non-empty subject kinds`,
    );
  }
  if (!pluginId.success || !kindsValid || !Array.isArray(kinds)) {
    return undefined;
  }
  return {
    pluginId: pluginId.data,
    subjectKinds: kinds.filter(
      (kind): kind is string => typeof kind === "string" && kind.length > 0,
    ),
  };
}

function readPolicy(
  value: unknown,
  problems: string[],
): Distribution["policy"] | undefined {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    problems.push("policy must be an object");
    return undefined;
  }
  rejectUnknownFields(value, ["detachedResults"], "policy", problems);
  if (value.detachedResults === undefined) {
    return Object.keys(value).every((key) => key === "detachedResults")
      ? {}
      : undefined;
  }
  if (!Array.isArray(value.detachedResults)) {
    problems.push("policy.detachedResults must be an array");
    return undefined;
  }
  const detachedResults: {
    pluginId: string;
    subjectKinds: string[];
  }[] = [];
  for (const [index, entry] of value.detachedResults.entries()) {
    const detached = readDetachedEntry(entry, index, problems);
    if (detached) {
      detachedResults.push(detached);
    }
  }
  if (
    detachedResults.length !== value.detachedResults.length ||
    Object.keys(value).some((key) => key !== "detachedResults")
  ) {
    return undefined;
  }
  return { detachedResults };
}

/**
 * Validates and normalizes a distribution. `defineDistribution` and `createKernel`
 * both use this, so a hand-built `Distribution` object gets the same checks.
 */
export function readDistribution(
  definition: unknown,
  problems: string[],
): Distribution | undefined {
  if (!isRecord(definition)) {
    problems.push("definition must be an object");
    return undefined;
  }
  const start = problems.length;
  rejectUnknownFields(
    definition,
    ["id", "name", "version", "kernel", "plugins", "defaults", "policy"],
    "distribution",
    problems,
  );

  const id = pluginIdSchema.safeParse(definition.id);
  if (!id.success) {
    problems.push(`id ${JSON.stringify(definition.id)} is not a valid plugin id`);
  }
  const name = definition.name;
  const nameValid = typeof name === "string" && name.trim() !== "";
  if (!nameValid) {
    problems.push("name must be a non-empty string");
  }
  const version = definition.version;
  const versionValid = typeof version === "string" && isSemanticVersion(version);
  if (!versionValid) {
    problems.push(`version ${JSON.stringify(version)} is not valid semver`);
  }
  const kernel = definition.kernel;
  const kernelValid = typeof kernel === "string" && isValidBorgEngineRange(kernel);
  if (!kernelValid) {
    problems.push(`kernel range ${JSON.stringify(kernel)} is invalid`);
  }
  const plugins = readPlugins(definition.plugins, problems);
  const defaults = readDefaults(definition.defaults, problems);
  const policy = readPolicy(definition.policy, problems);

  if (
    problems.length > start ||
    !id.success ||
    !nameValid ||
    !versionValid ||
    !kernelValid ||
    !plugins ||
    !defaults ||
    !policy
  ) {
    return undefined;
  }

  return deepFreeze({
    id: id.data,
    name,
    version,
    kernel,
    plugins,
    defaults,
    policy,
  });
}

/** A readable label for error messages, even when `definition` is invalid. */
export function distributionLabel(definition: unknown): string {
  if (
    isRecord(definition) &&
    typeof definition.id === "string" &&
    definition.id.length > 0
  ) {
    return definition.id;
  }
  return "(unknown)";
}

export function defineDistribution(definition: DistributionDefinition): Distribution {
  const problems: string[] = [];
  const distribution = readDistribution(definition, problems);
  if (!distribution) {
    throw new Error(
      `Invalid distribution ${distributionLabel(definition)}:\n${problems
        .map((problem) => `- ${problem}`)
        .join("\n")}`,
    );
  }
  return distribution;
}
