export const SETTINGS_GROUPS = [
  { id: "general", label: "General" },
  { id: "agents", label: "Agents" },
  { id: "models", label: "Models" },
  { id: "channels", label: "Channels" },
  { id: "tools", label: "Tools" },
  { id: "security", label: "Security" },
  { id: "other", label: "Other" },
] as const;

export type SettingsGroupId = (typeof SETTINGS_GROUPS)[number]["id"];

const SETTINGS_GROUP_IDS = new Set<string>(
  SETTINGS_GROUPS.map(({ id }) => id),
);

export interface SettingsPageRef {
  readonly id: string;
  readonly group?: string | undefined;
  readonly order?: number | undefined;
}

export function settingsGroupId(page: SettingsPageRef): SettingsGroupId {
  const declared = page.group?.trim();
  if (declared && SETTINGS_GROUP_IDS.has(declared)) {
    return declared as SettingsGroupId;
  }
  return inferSettingsGroup(page.id);
}

function inferSettingsGroup(id: string): SettingsGroupId {
  if (id.includes(".channel.")) {
    return "channels";
  }
  if (id.includes(".search.") || id.includes(".mcp.") || id.includes("borg.coinbase.")) {
    return "tools";
  }
  if (id.includes(".secrets.")) {
    return "security";
  }
  if (id === "system.plugins" || id.includes("borg.themes.")) {
    return "general";
  }
  if (
    id.includes("borg.chat.") ||
    id.includes("borg.graphs.") ||
    id.includes("borg.a2a.") ||
    id.includes("borg.feedback.")
  ) {
    return "agents";
  }
  if (
    id.includes("borg.anthropic.") ||
    id.includes("borg.openai.") ||
    id.includes("borg.azure.") ||
    id.includes("borg.copilot.") ||
    id.includes("borg.ollama.") ||
    id.includes("borg.openrouter.")
  ) {
    return "models";
  }
  return "other";
}

export function groupSettingsPages<T extends SettingsPageRef>(
  pages: readonly T[],
): readonly {
  readonly id: SettingsGroupId;
  readonly label: string;
  readonly pages: readonly T[];
}[] {
  const buckets = new Map<SettingsGroupId, T[]>();
  for (const page of pages) {
    const id = settingsGroupId(page);
    const list = buckets.get(id) ?? [];
    list.push(page);
    buckets.set(id, list);
  }
  return SETTINGS_GROUPS.flatMap((group) => {
    const grouped = buckets.get(group.id);
    if (!grouped || grouped.length === 0) {
      return [];
    }
    return [
      {
        id: group.id,
        label: group.label,
        pages: [...grouped].sort(
          (left, right) => (left.order ?? 0) - (right.order ?? 0),
        ),
      },
    ];
  });
}
