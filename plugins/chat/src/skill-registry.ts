import {
  discoveredSkillSchema,
  githubSkillSourceIdSchema,
  skillSchema,
  skillSourceSchema,
  type DiscoveredSkill,
  type Skill,
  type SkillSource,
} from "@borg-agent/contracts";
import {
  z,
  type JsonValue,
  type PluginHttp,
  type PluginSkills,
  type PluginStore,
} from "@borg-agent/plugin-sdk";
import {
  githubSourceId,
  isBlockedSkillPath,
  isSkillMdFilePath,
  parseGithubSourceId,
  parseSkillMd,
  skillCatalogId,
  skillMdFilePath,
  skillNameFromPath,
  sourcePathFromSkillFile,
} from "./skill-md";

const SKILL_SOURCES_KEY = "skill-sources";
const FETCH_BATCH_SIZE = 8;
const GITHUB_API_ACCEPT = "application/vnd.github+json";
const GITHUB_USER_AGENT = "borg-agent";
const RATE_LIMIT_WARNING = "GitHub rate-limited or blocked";

export const DEFAULT_SKILL_SOURCES: readonly SkillSource[] = [
  { type: "github", owner: "anthropics", repo: "skills", enabled: true },
  { type: "github", owner: "openai", repo: "skills", enabled: true },
  { type: "github", owner: "huggingface", repo: "skills", enabled: true },
];

const skillSourcesStateSchema = z
  .object({
    version: z.literal(1),
    sources: z.array(skillSourceSchema),
  })
  .strict();

const githubTreeSchema = z
  .object({
    truncated: z.boolean().optional(),
    tree: z.array(
      z
        .object({
          path: z.string().optional(),
          type: z.string().optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export interface SkillRegistry {
  listSources(): Promise<{ sources: SkillSource[] }>;
  setSources(input: { sources: SkillSource[] }): Promise<{
    sources: SkillSource[];
  }>;
  discover(
    sourceId?: string,
    signal?: AbortSignal,
  ): Promise<{
    skills: DiscoveredSkill[];
    warnings: string[];
  }>;
  preview(
    input: { sourceId: string; sourcePath: string },
    signal?: AbortSignal,
  ): Promise<{
    id: string;
    name: string;
    description: string;
    instructions: string;
    sourceId: string;
    sourcePath: string;
  }>;
  install(
    input: { sourceId: string; sourcePath: string },
    signal?: AbortSignal,
  ): Promise<{ skill: Skill }>;
}

export function createSkillRegistry(options: {
  readonly http: PluginHttp;
  readonly skills: PluginSkills;
  readonly store: PluginStore;
}): SkillRegistry {
  const { http, skills, store } = options;

  const listSources = async (): Promise<{ sources: SkillSource[] }> => ({
    sources: await loadSources(),
  });

  const setSources = async (input: {
    sources: SkillSource[];
  }): Promise<{ sources: SkillSource[] }> => {
    const sources = dedupeSources(
      input.sources.map((source) => skillSourceSchema.parse(source)),
    );
    await store.set(
      SKILL_SOURCES_KEY,
      asJsonValue({ version: 1 as const, sources }),
    );
    return { sources };
  };

  const discover = async (
    sourceId?: string,
    signal?: AbortSignal,
  ): Promise<{ skills: DiscoveredSkill[]; warnings: string[] }> => {
    const listed = await loadSources();
    const sources =
      sourceId === undefined
        ? listed.filter((source) => source.enabled)
        : selectSource(listed, sourceId);
    const skillsFound: DiscoveredSkill[] = [];
    const warnings: string[] = [];
    let failedSources = 0;

    for (const source of sources) {
      const result = await discoverSource(source, signal);
      skillsFound.push(...result.skills);
      warnings.push(...result.warnings);
      if (result.failed) {
        failedSources += 1;
      }
    }

    if (sources.length > 0 && failedSources === sources.length) {
      throw new Error(
        warnings.join(" ") || "All skill sources failed",
      );
    }

    return { skills: skillsFound, warnings };
  };

  const preview = async (
    input: { sourceId: string; sourcePath: string },
    signal?: AbortSignal,
  ): Promise<{
    id: string;
    name: string;
    description: string;
    instructions: string;
    sourceId: string;
    sourcePath: string;
  }> => {
    const fetched = await fetchParsedSkill(input, signal);
    return {
      id: fetched.id,
      name: fetched.name,
      description: fetched.description,
      instructions: fetched.body,
      sourceId: fetched.sourceId,
      sourcePath: fetched.sourcePath,
    };
  };

  const install = async (
    input: { sourceId: string; sourcePath: string },
    signal?: AbortSignal,
  ): Promise<{ skill: Skill }> => {
    const fetched = await fetchParsedSkill(input, signal);
    if (fetched.body.length === 0) {
      throw new Error("Skill instructions are empty");
    }
    const existing = skills.get(fetched.id);
    const skill = existing
      ? await skills.update(fetched.id, {
          name: fetched.name,
          description: fetched.description,
          instructions: fetched.body,
          archived: false,
        })
      : await skills.create({
          id: fetched.id,
          name: fetched.name,
          description: fetched.description,
          instructions: fetched.body,
          archived: false,
        });
    return { skill: skillSchema.parse(skill) };
  };

  async function loadSources(): Promise<SkillSource[]> {
    const stored = await store.get(SKILL_SOURCES_KEY);
    const parsed = skillSourcesStateSchema.safeParse(stored);
    if (!parsed.success) {
      return defaultSources();
    }
    return parsed.data.sources.map((source) => ({ ...source }));
  }

  async function discoverSource(
    source: SkillSource,
    signal?: AbortSignal,
  ): Promise<{
    skills: DiscoveredSkill[];
    warnings: string[];
    failed: boolean;
  }> {
    const sourceId = githubSourceId(source.owner, source.repo);
    const warnings: string[] = [];
    const treeUrl = githubTreeUrl(source.owner, source.repo);
    let payload: z.infer<typeof githubTreeSchema>;
    try {
      const response = await fetchText(
        treeUrl,
        {
          Accept: GITHUB_API_ACCEPT,
          "User-Agent": GITHUB_USER_AGENT,
        },
        signal,
      );
      if (isRateLimited(response.status)) {
        return {
          skills: [],
          warnings: [`${sourceId}: ${RATE_LIMIT_WARNING}`],
          failed: true,
        };
      }
      if (!response.ok) {
        return {
          skills: [],
          warnings: [`${sourceId}: GitHub returned ${response.status}`],
          failed: true,
        };
      }
      payload = githubTreeSchema.parse(JSON.parse(response.text));
    } catch (error) {
      return {
        skills: [],
        warnings: [`${sourceId}: ${describeError(error)}`],
        failed: true,
      };
    }

    if (payload.truncated === true) {
      warnings.push(`${sourceId}: repository tree listing was truncated`);
    }

    const candidates: { path: string; sourcePath: string }[] = [];
    for (const entry of payload.tree) {
      if (entry.type !== "blob" || typeof entry.path !== "string") {
        continue;
      }
      if (!isSkillMdFilePath(entry.path) || isBlockedSkillPath(entry.path)) {
        continue;
      }
      candidates.push({
        path: entry.path,
        sourcePath: sourcePathFromSkillFile(entry.path),
      });
    }

    const fetched = await mapInBatches(
      candidates,
      FETCH_BATCH_SIZE,
      async (candidate) => {
        try {
          const parsed = await fetchSkillMarkdown(
            source.owner,
            source.repo,
            candidate.path,
            candidate.sourcePath,
            signal,
          );
          const installed = isInstalled(parsed.id);
          return {
            kind: "skill" as const,
            skill: discoveredSkillSchema.parse({
              id: parsed.id,
              name: parsed.name,
              description: parsed.description,
              sourceId,
              sourcePath: candidate.sourcePath,
              installed,
            }),
          };
        } catch (error) {
          return {
            kind: "warning" as const,
            message: `${sourceId}: skipped ${candidate.path}: ${describeError(error)}`,
          };
        }
      },
    );

    const skillsFound: DiscoveredSkill[] = [];
    for (const item of fetched) {
      if (item.kind === "skill") {
        skillsFound.push(item.skill);
      } else {
        warnings.push(item.message);
      }
    }
    return { skills: skillsFound, warnings, failed: false };
  }

  async function fetchParsedSkill(
    input: { sourceId: string; sourcePath: string },
    signal?: AbortSignal,
  ): Promise<{
    id: string;
    name: string;
    description: string;
    body: string;
    sourceId: string;
    sourcePath: string;
  }> {
    const sourceId = githubSkillSourceIdSchema.parse(input.sourceId);
    const { owner, repo } = parseGithubSourceId(sourceId);
    const sourcePath = assertSafeSourcePath(input.sourcePath);
    const path = skillMdFilePath(sourcePath);
    const parsed = await fetchSkillMarkdown(
      owner,
      repo,
      path,
      sourcePath,
      signal,
    );
    return {
      ...parsed,
      sourceId,
      sourcePath,
    };
  }

  async function fetchSkillMarkdown(
    owner: string,
    repo: string,
    path: string,
    sourcePath: string,
    signal?: AbortSignal,
  ): Promise<{
    id: string;
    name: string;
    description: string;
    body: string;
  }> {
    const url = githubRawUrl(owner, repo, path);
    let response: { status: number; ok: boolean; text: string };
    try {
      response = await fetchText(
        url,
        { "User-Agent": GITHUB_USER_AGENT },
        signal,
      );
    } catch (error) {
      throw new Error(describeError(error));
    }
    if (isRateLimited(response.status)) {
      throw new Error(RATE_LIMIT_WARNING);
    }
    if (!response.ok) {
      throw new Error(`GitHub returned ${response.status}`);
    }
    const parsed = parseSkillMd(response.text, skillNameFromPath(sourcePath));
    const id = skillCatalogId({ owner, repo, name: parsed.name });
    if (!id) {
      throw new Error("Skill id is invalid");
    }
    return {
      id,
      name: parsed.name,
      description: parsed.description,
      body: parsed.body,
    };
  }

  async function fetchText(
    url: string,
    headers: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<{ status: number; ok: boolean; text: string }> {
    const response = await http.fetch(url, requestInit(headers, signal));
    return {
      status: response.status,
      ok: response.ok,
      text: await response.text(),
    };
  }

  function isInstalled(skillId: string): boolean {
    const current = skills.get(skillId);
    return current !== undefined && !current.archived;
  }

  return {
    listSources,
    setSources,
    discover,
    preview,
    install,
  };
}

function defaultSources(): SkillSource[] {
  return DEFAULT_SKILL_SOURCES.map((source) => ({ ...source }));
}

function selectSource(
  listed: readonly SkillSource[],
  sourceId: string,
): SkillSource[] {
  const parsed = githubSkillSourceIdSchema.parse(sourceId);
  const match = listed.find(
    (source) => githubSourceId(source.owner, source.repo) === parsed,
  );
  if (!match) {
    throw new Error(`Unknown skill source ${parsed}`);
  }
  return [match];
}

function dedupeSources(sources: readonly SkillSource[]): SkillSource[] {
  const seen = new Set<string>();
  const result: SkillSource[] = [];
  for (const source of sources) {
    const id = githubSourceId(source.owner, source.repo);
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    result.push({ ...source });
  }
  return result;
}

function githubTreeUrl(owner: string, repo: string): string {
  return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/HEAD?recursive=1`;
}

function githubRawUrl(owner: string, repo: string, path: string): string {
  const encodedPath = path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/HEAD/${encodedPath}`;
}

function requestInit(
  headers: Record<string, string>,
  signal?: AbortSignal,
): RequestInit {
  return signal ? { headers, signal } : { headers };
}

function isRateLimited(status: number): boolean {
  return status === 403 || status === 429;
}

function assertSafeSourcePath(sourcePath: string): string {
  const normalized = sourcePath.replaceAll("\\", "/").replace(/\/+$/g, "");
  if (normalized.length === 0) {
    return "";
  }
  if (isBlockedSkillPath(normalized) || isSkillMdFilePath(normalized)) {
    throw new Error(`Invalid skill path ${sourcePath}`);
  }
  return normalized;
}

function asJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function mapInBatches<T, R>(
  items: readonly T[],
  batchSize: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  for (let index = 0; index < items.length; index += batchSize) {
    const batch = items.slice(index, index + batchSize);
    results.push(...(await Promise.all(batch.map((item) => mapper(item)))));
  }
  return results;
}
