const FRONTMATTER_OPEN = "---";
const FRONTMATTER_CLOSE = "\n---";

export interface ParsedSkillMd {
  readonly name: string;
  readonly description: string;
  readonly body: string;
}

function stripQuotes(value: string): string {
  if (value.length < 2) {
    return value;
  }
  const start = value[0];
  const end = value[value.length - 1];
  if ((start === '"' && end === '"') || (start === "'" && end === "'")) {
    return value.slice(1, -1);
  }
  return value;
}

export function parseSkillMd(
  markdown: string,
  fallbackName?: string,
): ParsedSkillMd {
  const text = markdown.replace(/\r\n/g, "\n");
  if (!text.startsWith(FRONTMATTER_OPEN)) {
    throw new Error("SKILL.md must start with YAML frontmatter");
  }
  const afterOpen = text.slice(FRONTMATTER_OPEN.length);
  const closeAt = afterOpen.indexOf(FRONTMATTER_CLOSE);
  if (closeAt < 0) {
    throw new Error("SKILL.md frontmatter is not closed");
  }
  const frontmatter = afterOpen.slice(0, closeAt);
  const body = afterOpen.slice(closeAt + FRONTMATTER_CLOSE.length).trim();
  let name = "";
  let description = "";
  for (const line of frontmatter.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const colon = trimmed.indexOf(":");
    if (colon < 0) {
      continue;
    }
    const key = trimmed.slice(0, colon).trim();
    const value = stripQuotes(trimmed.slice(colon + 1).trim());
    if (key === "name") {
      name = value;
    } else if (key === "description") {
      description = value;
    }
  }
  const resolvedName = name.length > 0 ? name : fallbackName?.trim() ?? "";
  if (resolvedName.length === 0) {
    throw new Error("SKILL.md name is required");
  }
  if (description.length === 0) {
    throw new Error("SKILL.md description is required");
  }
  return { name: resolvedName, description, body };
}

export function skillNameFromPath(sourcePath: string): string {
  const normalized = sourcePath.replaceAll("\\", "/").replace(/\/+$/g, "");
  if (normalized.length === 0) {
    return "skill";
  }
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  return segments[segments.length - 1] ?? "skill";
}

export function sanitizeSkillIdSegment(value: string): string {
  return value
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function skillCatalogId(parts: {
  readonly owner: string;
  readonly repo: string;
  readonly name: string;
}): string | undefined {
  const owner = sanitizeSkillIdSegment(parts.owner);
  const repo = sanitizeSkillIdSegment(parts.repo);
  const name = sanitizeSkillIdSegment(parts.name);
  if (owner.length === 0 || repo.length === 0 || name.length === 0) {
    return undefined;
  }
  return `github/${owner}/${repo}/${name}`;
}

export function isSkillMdFilePath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  return normalized === "SKILL.md" || normalized.endsWith("/SKILL.md");
}

export function isBlockedSkillPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  if (
    normalized.includes("\0") ||
    normalized.startsWith("/") ||
    normalized.includes("//")
  ) {
    return true;
  }
  return normalized.split("/").some(
    (segment) =>
      segment === ".." ||
      segment === ".git" ||
      segment === "node_modules" ||
      segment.startsWith("."),
  );
}

export function sourcePathFromSkillFile(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  const index = normalized.lastIndexOf("/");
  return index < 0 ? "" : normalized.slice(0, index);
}

export function skillMdFilePath(sourcePath: string): string {
  const normalized = sourcePath.replaceAll("\\", "/").replace(/\/+$/g, "");
  return normalized.length === 0 ? "SKILL.md" : `${normalized}/SKILL.md`;
}

export function githubSourceId(owner: string, repo: string): string {
  return `github:${owner}/${repo}`;
}

export function parseGithubSourceId(sourceId: string): {
  readonly owner: string;
  readonly repo: string;
} {
  const match = /^github:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(sourceId);
  const owner = match?.[1];
  const repo = match?.[2];
  if (!owner || !repo) {
    throw new Error(`Unknown skill source ${sourceId}`);
  }
  return { owner, repo };
}
