import { createHash } from "node:crypto";
import type { ToolApproval } from "@borg/contracts";

const SLUG_SEGMENT = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DYNAMIC_TOOL_ID = /^[a-z0-9]+(?:[.-][a-z0-9-]+)+$/;
const STABLE_DIGEST_CHARS = 16;

export type McpToolVisibility = "model" | "app";

export interface McpToolAnnotations {
  readonly readOnlyHint?: boolean | undefined;
  readonly destructiveHint?: boolean | undefined;
}

export interface McpToolDescriptor {
  readonly name: string;
  readonly description?: string | undefined;
  readonly inputSchema?: unknown;
  readonly annotations?: McpToolAnnotations | undefined;
  readonly _meta?: {
    readonly ui?: {
      readonly resourceUri?: string | undefined;
      readonly visibility?: readonly McpToolVisibility[] | undefined;
    };
  };
}

export interface CanonicalMcpTool {
  readonly id: string;
  readonly serverId: string;
  readonly serverSlug: string;
  readonly mcpName: string;
  readonly description: string;
  readonly inputSchema: unknown;
  readonly approval: ToolApproval;
  readonly sideEffect: boolean;
  readonly modelVisible: boolean;
  readonly appVisible: boolean;
  readonly resourceUri?: string | undefined;
}

export function slugifySegment(value: string, fallback: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (slug.length > 0 && SLUG_SEGMENT.test(slug)) {
    return slug;
  }
  return fallback;
}

export function stableSegment(raw: string, fallback: string): string {
  if (SLUG_SEGMENT.test(raw)) {
    return raw;
  }
  const digest = createHash("sha256")
    .update(raw)
    .digest("hex")
    .slice(0, STABLE_DIGEST_CHARS);
  return `${slugifySegment(raw, fallback)}-${digest}`;
}

export function allocatePersonaServerSlugs(
  serverIds: readonly string[],
): ReadonlyMap<string, string> {
  return new Map(
    serverIds.map((serverId) => [serverId, stableSegment(serverId, "server")]),
  );
}

export function isModelVisible(tool: McpToolDescriptor): boolean {
  const visibility = tool._meta?.ui?.visibility;
  if (visibility === undefined) {
    return true;
  }
  return visibility.includes("model");
}

export function isAppVisible(tool: McpToolDescriptor): boolean {
  const visibility = tool._meta?.ui?.visibility;
  if (visibility === undefined) {
    return true;
  }
  return visibility.includes("app");
}

export function canonicalizeTools(
  serverId: string,
  tools: readonly McpToolDescriptor[],
  serverSlug = stableSegment(serverId, "server"),
): readonly CanonicalMcpTool[] {
  const usedToolNames = new Set<string>();
  return tools.map((tool) => {
    if (usedToolNames.has(tool.name)) {
      throw new Error(`MCP tool name ${tool.name} is duplicated`);
    }
    usedToolNames.add(tool.name);
    const toolSlug = stableSegment(tool.name, "tool");
    const id = `mcp.${serverSlug}.${toolSlug}`;
    if (!DYNAMIC_TOOL_ID.test(id)) {
      throw new Error(`MCP tool id ${id} is invalid`);
    }
    const resourceUri = tool._meta?.ui?.resourceUri;
    return {
      id,
      serverId,
      serverSlug,
      mcpName: tool.name,
      description:
        typeof tool.description === "string" && tool.description.trim().length > 0
          ? tool.description
          : tool.name,
      inputSchema: tool.inputSchema ?? { type: "object" },
      approval: "ask",
      sideEffect: true,
      modelVisible: isModelVisible(tool),
      appVisible: isAppVisible(tool),
      ...(typeof resourceUri === "string" && resourceUri.length > 0
        ? { resourceUri }
        : {}),
    };
  });
}

export function modelVisibleToolIds(
  tools: readonly CanonicalMcpTool[],
): readonly string[] {
  return tools.filter((tool) => tool.modelVisible).map((tool) => tool.id);
}
