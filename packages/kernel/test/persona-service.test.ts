import {
  type ConfigStoreProvider,
  type JsonValue,
  type StoreEntry,
  type StoreTransactionOperation,
} from "@borg/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PERSONA_ID,
  CostLedger,
  InteractionService,
  LoopManager,
  ModelRouter,
  PersonaService,
  PersistenceRegistry,
  PromptAssembler,
  StoreFacade,
  ToolService,
} from "../src";

class MemoryConfigStore implements ConfigStoreProvider {
  readonly values = new Map<string, Map<string, JsonValue>>();

  async readConfig(): Promise<undefined> {
    return undefined;
  }

  async writeConfig(): Promise<void> {}

  async getStore(namespace: string, key: string): Promise<JsonValue | undefined> {
    return this.values.get(namespace)?.get(key);
  }

  async listStore(namespace: string, prefix: string): Promise<readonly StoreEntry[]> {
    return [...(this.values.get(namespace) ?? new Map()).entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({ key, value }));
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

function createService(provider = new MemoryConfigStore()): PersonaService {
  const registry = new PersistenceRegistry();
  registry.registerConfigStore("test.config", provider);
  return new PersonaService(new StoreFacade(registry));
}

describe("PersonaService", () => {
  it("seeds and restores the bundled general persona", async () => {
    const provider = new MemoryConfigStore();
    const personas = createService(provider);
    await personas.initialize();

    expect(personas.getDefault()).toMatchObject({
      id: DEFAULT_PERSONA_ID,
      bundled: true,
      archived: false,
      preferredModels: ["borg.mock-llm:mock:scripted"],
    });
    expect(Object.isFrozen(personas.getDefault())).toBe(true);
    expect(
      new PromptAssembler(personas).assemble({
        personaId: DEFAULT_PERSONA_ID,
      }),
    ).toMatchObject({
      slots: [
        { id: "kernel.protocol", omitted: false },
        { id: "kernel.persona", omitted: false },
      ],
    });

    const restored = createService(provider);
    await restored.initialize();
    expect(restored.list()).toHaveLength(1);
    expect(restored.getDefault().id).toBe(DEFAULT_PERSONA_ID);
  });

  it("persists custom personas and protects their identity", async () => {
    const personas = createService();
    await personas.initialize();
    const created = await personas.create({
      id: "user/coder",
      name: "Coder",
      instructions: "Write careful code.",
      preferredModels: ["borg.mock-llm:mock:scripted"],
    });

    await personas.setDefault(created.id);
    expect(personas.getDefault().id).toBe("user/coder");
    await expect(
      personas.update(created.id, { id: "user/other" }),
    ).rejects.toThrow(/immutable/);

    await personas.archive(created.id);
    expect(personas.getDefault().id).toBe(DEFAULT_PERSONA_ID);
    expect(personas.list()).toHaveLength(1);
    expect(personas.list(true)).toHaveLength(2);
  });

  it("resolves the default persona, model, and system prompt for loops", async () => {
    const personas = createService();
    await personas.initialize();
    const prompts = new PromptAssembler(personas);
    const costs = new CostLedger();
    const models = new ModelRouter(costs);
    const complete = vi.fn(async () => ({
      content: "done",
      usage: { inputTokens: 1, outputTokens: 1 },
    }));
    models.registerProvider("borg.mock-llm", {
      id: "borg.mock-llm",
      models: ["mock:scripted"],
      complete,
    });
    const loops = new LoopManager(
      models,
      new ToolService(new InteractionService()),
      costs,
      () => false,
      personas,
      prompts,
    );

    const run = loops.start({ prompt: "hello" }, "borg.chat");
    await vi.waitFor(() => expect(loops.get(run.id)?.status).toBe("completed"));
    expect(loops.get(run.id)).toMatchObject({
      personaId: DEFAULT_PERSONA_ID,
      providerId: "borg.mock-llm",
      modelId: "mock:scripted",
    });
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "system",
            content: expect.stringContaining(
              "You are Borg, a careful local assistant.",
            ),
          }),
          expect.objectContaining({ role: "user", content: "hello" }),
        ]),
      }),
      expect.any(AbortSignal),
      expect.any(Function),
    );
    const reviewer = await personas.create({
      id: "user/reviewer",
      name: "Reviewer",
      instructions: "Custom reviewer instruction marker.",
      preferredModels: ["borg.mock-llm:mock:scripted"],
    });
    const personaRun = loops.start(
      { prompt: "review", personaId: reviewer.id },
      "borg.chat",
    );
    await vi.waitFor(() =>
      expect(loops.get(personaRun.id)?.status).toBe("completed"),
    );
    expect(complete).toHaveBeenLastCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: "system",
            content: expect.stringContaining(
              "Custom reviewer instruction marker.",
            ),
          }),
        ]),
      }),
      expect.any(AbortSignal),
      expect.any(Function),
    );

    const alternateComplete = vi.fn(async () => ({
      content: "alternate",
      usage: { inputTokens: 1, outputTokens: 1 },
    }));
    models.registerProvider("borg.alternate", {
      id: "borg.alternate",
      models: ["alternate"],
      complete: alternateComplete,
    });
    const override = loops.start(
      { prompt: "use the override", modelId: "alternate" },
      "borg.chat",
    );
    await vi.waitFor(() =>
      expect(loops.get(override.id)?.status).toBe("completed"),
    );
    expect(loops.get(override.id)).toMatchObject({
      providerId: "borg.alternate",
      modelId: "alternate",
      output: "alternate",
    });
  });
});
