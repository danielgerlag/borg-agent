import {
  type ConfigStoreProvider,
  type JsonValue,
  type LlmProviderContribution,
  type ProviderEgress,
  type StoreEntry,
  type StoreTransactionOperation,
} from "@borg/plugin-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_PERSONA_ID,
  LoopManager,
  PersonaService,
  PersistenceRegistry,
  PromptAssembler,
  StoreFacade,
} from "../src";
import { createSecurityRuntime } from "./security-runtime";

const TEST_PROVIDER_EGRESS = {
  kind: "remote",
  capacity: "internal",
  destination: "https://models.test.invalid/v1/generate",
} satisfies ProviderEgress;

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
      await new PromptAssembler(personas).assemble({
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
    const { costs, executions, models, tools } = createSecurityRuntime();
    const complete: LlmProviderContribution["complete"] = vi.fn(
      async (_request, permit) => {
        await permit.commit();
        return {
          content: "done",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    );
    models.registerProvider("borg.mock-llm", {
      id: "borg.mock-llm",
      models: ["mock:scripted"],
      egress: TEST_PROVIDER_EGRESS,
      complete,
    });
    const loops = new LoopManager(
      models,
      executions,
      tools,
      costs,
      () => false,
      personas,
      prompts,
    );

    const run = await loops.start(
      {
        prompt: "hello",
        security: {
          kind: "root",
          subject: {
            kind: "persona-service-test",
            id: "default-persona",
          },
          classification: "internal",
          provenance: {
            kind: "plugin",
            id: "borg.chat",
          },
          operationPrefix: "persona-service/default-persona",
        },
      },
      "borg.chat",
    );
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
      expect.objectContaining({ commit: expect.any(Function) }),
      expect.any(AbortSignal),
      expect.any(Function),
      expect.any(Function),
    );
    const reviewer = await personas.create({
      id: "user/reviewer",
      name: "Reviewer",
      instructions: "Custom reviewer instruction marker.",
      preferredModels: ["borg.mock-llm:mock:scripted"],
    });
    const personaRun = await loops.start(
      {
        prompt: "review",
        personaId: reviewer.id,
        security: {
          kind: "root",
          subject: {
            kind: "persona-service-test",
            id: "reviewer-persona",
          },
          classification: "internal",
          provenance: {
            kind: "plugin",
            id: "borg.chat",
          },
          operationPrefix: "persona-service/reviewer-persona",
        },
      },
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
      expect.objectContaining({ commit: expect.any(Function) }),
      expect.any(AbortSignal),
      expect.any(Function),
      expect.any(Function),
    );

    const alternateComplete: LlmProviderContribution["complete"] = vi.fn(
      async (_request, permit) => {
        await permit.commit();
        return {
          content: "alternate",
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    );
    models.registerProvider("borg.alternate", {
      id: "borg.alternate",
      models: ["alternate"],
      egress: TEST_PROVIDER_EGRESS,
      complete: alternateComplete,
    });
    const override = await loops.start(
      {
        prompt: "use the override",
        modelId: "alternate",
        security: {
          kind: "root",
          subject: {
            kind: "persona-service-test",
            id: "model-override",
          },
          classification: "internal",
          provenance: {
            kind: "plugin",
            id: "borg.chat",
          },
          operationPrefix: "persona-service/model-override",
        },
      },
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
