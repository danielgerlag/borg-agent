import {
  type ConfigStoreProvider,
  type JsonValue,
  type StoreEntry,
  type StoreTransactionOperation,
} from "@borg-agent/plugin-sdk";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PERSONA_ID,
  PersistenceRegistry,
  PersonaService,
  PromptAssembler,
  SkillService,
  StoreFacade,
} from "../src";

class MemoryConfigStore implements ConfigStoreProvider {
  readonly values = new Map<string, Map<string, JsonValue>>();

  async readConfig(): Promise<undefined> {
    return undefined;
  }

  async writeConfig(): Promise<void> {}

  async getStore(
    namespace: string,
    key: string,
  ): Promise<JsonValue | undefined> {
    return this.values.get(namespace)?.get(key);
  }

  async listStore(
    namespace: string,
    prefix: string,
  ): Promise<readonly StoreEntry[]> {
    return [...(this.values.get(namespace) ?? new Map()).entries()]
      .filter(([storeKey]) => storeKey.startsWith(prefix))
      .map(([storeKey, value]) => ({ key: storeKey, value }));
  }

  async applyStoreTransaction(
    namespace: string,
    operations: readonly StoreTransactionOperation[],
  ): Promise<void> {
    const next = new Map(this.values.get(namespace));
    for (const operation of operations) {
      if (operation.type === "set") {
        next.set(operation.key, operation.value);
      } else {
        next.delete(operation.key);
      }
    }
    this.values.set(namespace, next);
  }
}

describe("SkillService", () => {
  it("persists skills and injects attached skill instructions into the prompt", async () => {
    const registry = new PersistenceRegistry();
    registry.registerConfigStore("test.config", new MemoryConfigStore());
    const store = new StoreFacade(registry);
    const personas = new PersonaService(store);
    const skills = new SkillService(store);
    await personas.initialize();
    await skills.initialize();

    const skill = await skills.create({
      id: "user/review",
      name: "Review",
      instructions: "Always cite the exact file path.",
    });
    await personas.update(DEFAULT_PERSONA_ID, { skillIds: [skill.id] });

    const assembled = await new PromptAssembler(
      personas,
      undefined,
      skills,
    ).assemble({
      personaId: DEFAULT_PERSONA_ID,
    });
    expect(assembled.system).toContain("Always cite the exact file path.");
    expect(assembled.slots.map((slot) => slot.id)).toEqual([
      "kernel.protocol",
      "kernel.persona",
      "kernel.skills",
    ]);
    expect(assembled.slots[2]).toEqual({
      id: "kernel.skills",
      omitted: false,
    });

    const restored = new SkillService(store);
    await restored.initialize();
    expect(restored.get("user/review")?.name).toBe("Review");
  });

  it("omits archived and unknown skill ids from the prompt", async () => {
    const registry = new PersistenceRegistry();
    registry.registerConfigStore("test.config", new MemoryConfigStore());
    const store = new StoreFacade(registry);
    const personas = new PersonaService(store);
    const skills = new SkillService(store);
    await personas.initialize();
    await skills.initialize();
    const skill = await skills.create({
      id: "user/gone",
      name: "Gone",
      instructions: "This should not appear.",
    });
    await skills.archive(skill.id);
    await personas.update(DEFAULT_PERSONA_ID, {
      skillIds: [skill.id, "user/missing"],
    });
    const assembled = await new PromptAssembler(
      personas,
      undefined,
      skills,
    ).assemble({
      personaId: DEFAULT_PERSONA_ID,
    });
    expect(assembled.system).not.toContain("This should not appear.");
    expect(assembled.slots).toContainEqual({
      id: "kernel.skills",
      omitted: true,
    });
  });
});
