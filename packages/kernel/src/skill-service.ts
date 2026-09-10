import {
  skillIdSchema,
  skillSchema,
  type Skill,
} from "@borg/contracts";
import { z, type JsonValue } from "@borg/plugin-sdk";
import type { StoreFacade } from "./persistence";

const SKILL_NAMESPACE = "system.skills";
const SKILL_STATE_KEY = "state";

const skillStateSchema = z
  .object({
    version: z.literal(1),
    skills: z.array(skillSchema),
  })
  .strict();

type SkillState = z.infer<typeof skillStateSchema>;

function freezeSkill(skill: Skill): Skill {
  return deepFreeze(structuredClone(skill));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const entry of Object.values(value)) {
      deepFreeze(entry);
    }
    Object.freeze(value);
  }
  return value;
}

function asJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function normalizeState(candidate: unknown): SkillState {
  const parsed = skillStateSchema.parse(
    candidate &&
      typeof candidate === "object" &&
      !Array.isArray(candidate) &&
      !("version" in candidate)
      ? { ...candidate, version: 1 }
      : candidate,
  );
  return {
    version: 1,
    skills: parsed.skills.map(freezeSkill),
  };
}

export class SkillService {
  #state: SkillState | undefined;
  #writeQueue = Promise.resolve();

  constructor(readonly store: StoreFacade) {}

  async initialize(): Promise<void> {
    const stored = await this.store.get(SKILL_NAMESPACE, SKILL_STATE_KEY);
    if (stored === undefined) {
      this.#state = { version: 1, skills: [] };
      await this.#persistState(this.#state);
      return;
    }
    this.#state = normalizeState(stored);
    await this.#persistState(this.#state);
  }

  get(skillId: string): Skill | undefined {
    return this.#requireState().skills.find(({ id }) => id === skillId);
  }

  list(includeArchived = false): readonly Skill[] {
    return this.#requireState()
      .skills.filter(({ archived }) => includeArchived || !archived)
      .sort((left, right) => left.name.localeCompare(right.name));
  }

  resolve(skillIds: readonly string[]): readonly Skill[] {
    const resolved: Skill[] = [];
    for (const skillId of skillIds) {
      const skill = this.get(skillId);
      if (skill && !skill.archived) {
        resolved.push(skill);
      }
    }
    return resolved;
  }

  async create(candidate: unknown): Promise<Skill> {
    return this.#mutate((state) => {
      const skill = freezeSkill(
        skillSchema.parse({
          ...(candidate as Record<string, unknown>),
          bundled: false,
        }),
      );
      if (state.skills.some(({ id }) => id === skill.id)) {
        throw new Error(`Skill ${skill.id} already exists`);
      }
      if (skill.id.startsWith("system/")) {
        throw new Error("Custom skills cannot use the system namespace");
      }
      state.skills.push(skill);
      return skill;
    });
  }

  async update(
    skillId: string,
    patch: Readonly<Record<string, unknown>>,
  ): Promise<Skill> {
    skillIdSchema.parse(skillId);
    return this.#mutate((state) => {
      const index = state.skills.findIndex(({ id }) => id === skillId);
      const current = state.skills[index];
      if (!current) {
        throw new Error(`Skill ${skillId} is unavailable`);
      }
      if ("id" in patch || "bundled" in patch) {
        throw new Error("Skill identity and bundled status are immutable");
      }
      const updated = freezeSkill(skillSchema.parse({ ...current, ...patch }));
      state.skills[index] = updated;
      return updated;
    });
  }

  async archive(skillId: string): Promise<void> {
    await this.update(skillId, { archived: true });
  }

  async #mutate<T>(mutation: (state: {
    version: 1;
    skills: Skill[];
  }) => T): Promise<T> {
    let result: T | undefined;
    const operation = this.#writeQueue.then(async () => {
      const current = this.#requireState();
      const draft = {
        version: 1 as const,
        skills: [...current.skills],
      };
      result = mutation(draft);
      const next = normalizeState(draft);
      await this.#persistState(next);
      this.#state = next;
    });
    this.#writeQueue = operation.catch(() => undefined);
    await operation;
    return result as T;
  }

  async #persistState(state: SkillState): Promise<void> {
    await this.store.set(
      SKILL_NAMESPACE,
      SKILL_STATE_KEY,
      asJsonValue(state),
    );
  }

  #requireState(): SkillState {
    if (!this.#state) {
      throw new Error("Skill service is not initialized");
    }
    return this.#state;
  }
}
