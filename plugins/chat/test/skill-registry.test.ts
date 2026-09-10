import { skillSchema, type Skill } from "@borg/contracts";
import type {
  JsonValue,
  PluginHttp,
  PluginSkills,
  PluginStore,
  StoreEntry,
  StoreTransactionOperation,
} from "@borg/plugin-sdk";
import { describe, expect, it } from "vitest";
import { createSkillRegistry } from "../src/skill-registry";

const PDF_SKILL_MD = `---
name: pdf
description: Handle PDF files
---

Use pdftotext, then summarize.
`;

const EMPTY_BODY_SKILL_MD = `---
name: empty
description: Empty instructions
---
`;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, { status });
}

function treeUrl(owner: string, repo: string): string {
  return `https://api.github.com/repos/${owner}/${repo}/git/trees/HEAD?recursive=1`;
}

function rawUrl(owner: string, repo: string, path: string): string {
  return `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${path}`;
}

function createMemorySkills(seed: readonly Skill[] = []): PluginSkills {
  const catalog = new Map<string, Skill>(
    seed.map((skill) => [skill.id, skill]),
  );
  return {
    get: (skillId) => catalog.get(skillId),
    list: (includeArchived = false) =>
      [...catalog.values()].filter(
        (skill) => includeArchived || !skill.archived,
      ),
    create: async (candidate) => {
      const skill = skillSchema.parse({
        ...(candidate as Record<string, unknown>),
        bundled: false,
      });
      if (catalog.has(skill.id)) {
        throw new Error(`Skill ${skill.id} already exists`);
      }
      catalog.set(skill.id, skill);
      return skill;
    },
    update: async (skillId, patch) => {
      const current = catalog.get(skillId);
      if (!current) {
        throw new Error(`Skill ${skillId} is unavailable`);
      }
      if ("id" in patch || "bundled" in patch) {
        throw new Error("Skill identity and bundled status are immutable");
      }
      const updated = skillSchema.parse({ ...current, ...patch });
      catalog.set(skillId, updated);
      return updated;
    },
    archive: async (skillId) => {
      const current = catalog.get(skillId);
      if (!current) {
        throw new Error(`Skill ${skillId} is unavailable`);
      }
      catalog.set(skillId, { ...current, archived: true });
    },
  };
}

function createMemoryStore(
  seed: Readonly<Record<string, JsonValue>> = {},
): PluginStore {
  const values = new Map<string, JsonValue>(Object.entries(seed));
  return {
    get: async (key) => values.get(key),
    set: async (key, value) => {
      values.set(key, value);
    },
    delete: async (key) => {
      values.delete(key);
    },
    list: async (prefix = ""): Promise<readonly StoreEntry[]> =>
      [...values.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => ({ key, value })),
    transaction: async (operations: readonly StoreTransactionOperation[]) => {
      for (const operation of operations) {
        if (operation.type === "set") {
          values.set(operation.key, operation.value);
        } else {
          values.delete(operation.key);
        }
      }
    },
  };
}

function createRegistry(options: {
  readonly fetch: PluginHttp["fetch"];
  readonly skills?: PluginSkills;
  readonly store?: PluginStore;
}) {
  return createSkillRegistry({
    http: { fetch: options.fetch },
    skills: options.skills ?? createMemorySkills(),
    store: options.store ?? createMemoryStore(),
  });
}

describe("skill registry", () => {
  it("returns default sources when the store is empty", async () => {
    const registry = createRegistry({
      fetch: async (input) => {
        throw new Error(`Unexpected fetch ${String(input)}`);
      },
    });
    await expect(registry.listSources()).resolves.toEqual({
      sources: [
        { type: "github", owner: "anthropics", repo: "skills", enabled: true },
        { type: "github", owner: "openai", repo: "skills", enabled: true },
        {
          type: "github",
          owner: "huggingface",
          repo: "skills",
          enabled: true,
        },
      ],
    });
  });

  it("round-trips setSources and drops duplicates", async () => {
    const registry = createRegistry({
      fetch: async (input) => {
        throw new Error(`Unexpected fetch ${String(input)}`);
      },
    });
    const result = await registry.setSources({
      sources: [
        { type: "github", owner: "acme", repo: "skills", enabled: true },
        { type: "github", owner: "acme", repo: "skills", enabled: false },
        { type: "github", owner: "other", repo: "box", enabled: true },
      ],
    });
    expect(result.sources).toEqual([
      { type: "github", owner: "acme", repo: "skills", enabled: true },
      { type: "github", owner: "other", repo: "box", enabled: true },
    ]);
    await expect(registry.listSources()).resolves.toEqual(result);
  });

  it("discovers SKILL.md entries from a mocked GitHub tree", async () => {
    const registry = createRegistry({
      fetch: async (input) => {
        const url = String(input);
        if (url === treeUrl("acme", "skills")) {
          return jsonResponse({
            truncated: false,
            tree: [
              { path: "skills/pdf/SKILL.md", type: "blob" },
              { path: "README.md", type: "blob" },
              { path: "skills/pdf", type: "tree" },
            ],
          });
        }
        if (url === rawUrl("acme", "skills", "skills/pdf/SKILL.md")) {
          return textResponse(PDF_SKILL_MD);
        }
        throw new Error(`Unexpected fetch ${url}`);
      },
    });
    await registry.setSources({
      sources: [
        { type: "github", owner: "acme", repo: "skills", enabled: true },
      ],
    });
    await expect(registry.discover()).resolves.toEqual({
      skills: [
        {
          id: "github/acme/skills/pdf",
          name: "pdf",
          description: "Handle PDF files",
          sourceId: "github:acme/skills",
          sourcePath: "skills/pdf",
          installed: false,
        },
      ],
      warnings: [],
    });
  });

  it("marks discovered skills installed when the catalog already has that id", async () => {
    const skills = createMemorySkills([
      skillSchema.parse({
        id: "github/acme/skills/pdf",
        name: "pdf",
        description: "Handle PDF files",
        instructions: "old",
        archived: false,
        bundled: false,
      }),
    ]);
    const registry = createRegistry({
      skills,
      fetch: async (input) => {
        const url = String(input);
        if (url === treeUrl("acme", "skills")) {
          return jsonResponse({
            tree: [{ path: "skills/pdf/SKILL.md", type: "blob" }],
          });
        }
        if (url === rawUrl("acme", "skills", "skills/pdf/SKILL.md")) {
          return textResponse(PDF_SKILL_MD);
        }
        throw new Error(`Unexpected fetch ${url}`);
      },
    });
    await registry.setSources({
      sources: [
        { type: "github", owner: "acme", repo: "skills", enabled: true },
      ],
    });
    const result = await registry.discover();
    expect(result.skills).toEqual([
      {
        id: "github/acme/skills/pdf",
        name: "pdf",
        description: "Handle PDF files",
        sourceId: "github:acme/skills",
        sourcePath: "skills/pdf",
        installed: true,
      },
    ]);
  });

  it("continues with a warning when one repo 404s and another succeeds", async () => {
    const registry = createRegistry({
      fetch: async (input) => {
        const url = String(input);
        if (url === treeUrl("missing", "skills")) {
          return textResponse("Not Found", 404);
        }
        if (url === treeUrl("acme", "skills")) {
          return jsonResponse({
            tree: [{ path: "skills/pdf/SKILL.md", type: "blob" }],
          });
        }
        if (url === rawUrl("acme", "skills", "skills/pdf/SKILL.md")) {
          return textResponse(PDF_SKILL_MD);
        }
        throw new Error(`Unexpected fetch ${url}`);
      },
    });
    await registry.setSources({
      sources: [
        { type: "github", owner: "missing", repo: "skills", enabled: true },
        { type: "github", owner: "acme", repo: "skills", enabled: true },
      ],
    });
    const result = await registry.discover();
    expect(result.skills).toEqual([
      {
        id: "github/acme/skills/pdf",
        name: "pdf",
        description: "Handle PDF files",
        sourceId: "github:acme/skills",
        sourcePath: "skills/pdf",
        installed: false,
      },
    ]);
    expect(result.warnings.some((warning) => /404/.test(warning))).toBe(true);
  });

  it("installs a catalog entry from a re-fetched SKILL.md", async () => {
    const skills = createMemorySkills();
    const registry = createRegistry({
      skills,
      fetch: async (input) => {
        const url = String(input);
        if (url === rawUrl("acme", "skills", "skills/pdf/SKILL.md")) {
          return textResponse(PDF_SKILL_MD);
        }
        throw new Error(`Unexpected fetch ${url}`);
      },
    });
    const result = await registry.install({
      sourceId: "github:acme/skills",
      sourcePath: "skills/pdf",
    });
    expect(result.skill).toMatchObject({
      id: "github/acme/skills/pdf",
      name: "pdf",
      description: "Handle PDF files",
      instructions: "Use pdftotext, then summarize.",
      archived: false,
      bundled: false,
    });
    expect(skills.get("github/acme/skills/pdf")).toEqual(result.skill);
  });

  it("updates an existing catalog id on install", async () => {
    const skills = createMemorySkills([
      skillSchema.parse({
        id: "github/acme/skills/pdf",
        name: "old",
        description: "old",
        instructions: "old",
        archived: true,
        bundled: false,
      }),
    ]);
    const registry = createRegistry({
      skills,
      fetch: async (input) => {
        const url = String(input);
        if (url === rawUrl("acme", "skills", "skills/pdf/SKILL.md")) {
          return textResponse(PDF_SKILL_MD);
        }
        throw new Error(`Unexpected fetch ${url}`);
      },
    });
    const result = await registry.install({
      sourceId: "github:acme/skills",
      sourcePath: "skills/pdf",
    });
    expect(result.skill).toMatchObject({
      id: "github/acme/skills/pdf",
      name: "pdf",
      description: "Handle PDF files",
      instructions: "Use pdftotext, then summarize.",
      archived: false,
    });
  });

  it("rejects install when the SKILL.md body is empty", async () => {
    const registry = createRegistry({
      fetch: async (input) => {
        const url = String(input);
        if (url === rawUrl("acme", "skills", "skills/empty/SKILL.md")) {
          return textResponse(EMPTY_BODY_SKILL_MD);
        }
        throw new Error(`Unexpected fetch ${url}`);
      },
    });
    await expect(
      registry.install({
        sourceId: "github:acme/skills",
        sourcePath: "skills/empty",
      }),
    ).rejects.toThrow(/empty/i);
  });

  it("does not write the catalog on preview", async () => {
    const skills = createMemorySkills();
    const registry = createRegistry({
      skills,
      fetch: async (input) => {
        const url = String(input);
        if (url === rawUrl("acme", "skills", "skills/pdf/SKILL.md")) {
          return textResponse(PDF_SKILL_MD);
        }
        throw new Error(`Unexpected fetch ${url}`);
      },
    });
    await expect(
      registry.preview({
        sourceId: "github:acme/skills",
        sourcePath: "skills/pdf",
      }),
    ).resolves.toEqual({
      id: "github/acme/skills/pdf",
      name: "pdf",
      description: "Handle PDF files",
      instructions: "Use pdftotext, then summarize.",
      sourceId: "github:acme/skills",
      sourcePath: "skills/pdf",
    });
    expect(skills.list(true)).toEqual([]);
  });

  it("ignores path traversal and .git SKILL.md paths", async () => {
    const registry = createRegistry({
      fetch: async (input) => {
        const url = String(input);
        if (url === treeUrl("acme", "skills")) {
          return jsonResponse({
            tree: [
              { path: "../escape/SKILL.md", type: "blob" },
              { path: ".git/SKILL.md", type: "blob" },
              { path: "node_modules/pkg/SKILL.md", type: "blob" },
              { path: "skills/.hidden/SKILL.md", type: "blob" },
              { path: "skills/pdf/SKILL.md", type: "blob" },
            ],
          });
        }
        if (url === rawUrl("acme", "skills", "skills/pdf/SKILL.md")) {
          return textResponse(PDF_SKILL_MD);
        }
        throw new Error(`Unexpected fetch ${url}`);
      },
    });
    await registry.setSources({
      sources: [
        { type: "github", owner: "acme", repo: "skills", enabled: true },
      ],
    });
    const result = await registry.discover();
    expect(result.skills.map((skill) => skill.id)).toEqual([
      "github/acme/skills/pdf",
    ]);
  });

  it("adds a warning when the GitHub tree is truncated", async () => {
    const registry = createRegistry({
      fetch: async (input) => {
        const url = String(input);
        if (url === treeUrl("acme", "skills")) {
          return jsonResponse({
            truncated: true,
            tree: [{ path: "skills/pdf/SKILL.md", type: "blob" }],
          });
        }
        if (url === rawUrl("acme", "skills", "skills/pdf/SKILL.md")) {
          return textResponse(PDF_SKILL_MD);
        }
        throw new Error(`Unexpected fetch ${url}`);
      },
    });
    await registry.setSources({
      sources: [
        { type: "github", owner: "acme", repo: "skills", enabled: true },
      ],
    });
    const result = await registry.discover();
    expect(result.skills).toHaveLength(1);
    expect(result.warnings.some((warning) => /truncated/i.test(warning))).toBe(
      true,
    );
  });
});
