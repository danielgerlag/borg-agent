import { mcpServerConfigSchema, type McpServerConfig } from "@borg/contracts";

export type McpTransportKind = "stdio" | "sse" | "streamable-http";

export interface McpServerDraft {
  id: string;
  enabled: boolean;
  reconnect: boolean;
  channelClass?: McpServerConfig["channelClass"];
  reactive?: boolean;
  sandbox?: McpServerConfig["sandbox"];
  transport: McpTransportKind;
  command?: string;
  arguments?: string[];
  environmentSecretRefs?: Record<string, string>;
  environmentSecretRefsText?: string;
  url?: string;
  headerSecretRefs?: Record<string, string>;
  headerSecretRefsText?: string;
}

export function draftFromConfig(config: McpServerConfig): McpServerDraft {
  if (config.transport === "stdio") {
    return {
      id: config.id,
      enabled: config.enabled,
      reconnect: config.reconnect,
      channelClass: config.channelClass,
      reactive: config.reactive,
      ...(config.sandbox ? { sandbox: config.sandbox } : {}),
      transport: "stdio",
      command: config.command,
      arguments: [...config.arguments],
      environmentSecretRefs: { ...config.environmentSecretRefs },
    };
  }
  return {
    id: config.id,
    enabled: config.enabled,
    reconnect: config.reconnect,
    channelClass: config.channelClass,
    reactive: config.reactive,
    ...(config.sandbox ? { sandbox: config.sandbox } : {}),
    transport: config.transport,
    url: config.url,
    headerSecretRefs: { ...config.headerSecretRefs },
  };
}

export function emptyStdioDraft(id = "mock"): McpServerDraft {
  return {
    id,
    enabled: true,
    reconnect: true,
    transport: "stdio",
    command: "node",
    arguments: [],
    environmentSecretRefs: {},
  };
}

export function changeDraftTransport(
  draft: McpServerDraft,
  transport: McpTransportKind,
): McpServerDraft {
  const common = {
    id: draft.id,
    enabled: draft.enabled,
    reconnect: draft.reconnect,
    ...(draft.channelClass !== undefined
      ? { channelClass: draft.channelClass }
      : {}),
    ...(draft.reactive !== undefined ? { reactive: draft.reactive } : {}),
    ...(draft.sandbox !== undefined ? { sandbox: draft.sandbox } : {}),
  };
  if (transport === "stdio") {
    return {
      ...common,
      transport,
      command: draft.command ?? "node",
      arguments: draft.arguments ?? [],
      environmentSecretRefs: draft.environmentSecretRefs ?? {},
    };
  }
  return {
    ...common,
    transport,
    url: draft.url ?? "http://127.0.0.1:0/mcp",
    headerSecretRefs: draft.headerSecretRefs ?? {},
  };
}

export function replaceDraft(
  drafts: readonly McpServerDraft[],
  index: number,
  next: McpServerDraft,
): McpServerDraft[] {
  return drafts.map((server, entryIndex) =>
    entryIndex === index ? next : server,
  );
}

export function argumentsToText(args: readonly string[] | undefined): string {
  return (args ?? []).join("\n");
}

export function textToArguments(value: string): string[] {
  return value.split(/\r?\n/).filter((line) => line.length > 0);
}

export function refsToText(refs: Readonly<Record<string, string>> | undefined): string {
  return Object.entries(refs ?? {})
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

export function textToRefs(value: string): Record<string, string> {
  const refs: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  for (const line of value.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const index = trimmed.indexOf("=");
    if (index <= 0) {
      continue;
    }
    refs[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
  }
  return refs;
}

export function parseDraftsForSave(
  drafts: readonly McpServerDraft[],
): McpServerConfig[] {
  return drafts.map((draft) => {
    const common = {
      id: draft.id,
      enabled: draft.enabled,
      reconnect: draft.reconnect,
      ...(draft.channelClass !== undefined
        ? { channelClass: draft.channelClass }
        : {}),
      ...(draft.reactive !== undefined ? { reactive: draft.reactive } : {}),
      ...(draft.sandbox !== undefined ? { sandbox: draft.sandbox } : {}),
    };
    if (draft.transport === "stdio") {
      return mcpServerConfigSchema.parse({
        ...common,
        transport: draft.transport,
        command: draft.command,
        arguments: draft.arguments,
        environmentSecretRefs: parseRefsForSave(
          draft.environmentSecretRefsText ??
            refsToText(draft.environmentSecretRefs),
        ),
      });
    }
    return mcpServerConfigSchema.parse({
      ...common,
      transport: draft.transport,
      url: draft.url,
      headerSecretRefs: parseRefsForSave(
        draft.headerSecretRefsText ?? refsToText(draft.headerSecretRefs),
      ),
    });
  });
}

function parseRefsForSave(value: string): Record<string, string> {
  const refs: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  for (const line of value.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, Math.max(0, index)).trim();
    const reference = index >= 0 ? trimmed.slice(index + 1).trim() : "";
    if (
      index <= 0 ||
      key.length === 0 ||
      reference.length === 0 ||
      Object.prototype.hasOwnProperty.call(refs, key)
    ) {
      throw new Error("Secret references must use unique NAME=reference lines");
    }
    refs[key] = reference;
  }
  return refs;
}

export function describeDraftError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function catalogLabel(toolIds: readonly string[] | undefined): string {
  return (toolIds ?? []).join(", ");
}
