import type {
  ConfigStoreProvider,
  JsonValue,
  MemoryProviderContribution,
  MemoryRecord,
  StoreEntry,
  StoreTransactionOperation,
} from "@borg/plugin-sdk";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PERSONA_ID,
  MemoryFacade,
  PersonaService,
  PersistenceRegistry,
  PromptAssembler,
  StoreFacade,
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

describe("PromptAssembler", () => {
  it("injects recalled memory after the persona section", async () => {
    const registry = new PersistenceRegistry();
    registry.registerConfigStore("test.config", new MemoryConfigStore());
    const personas = new PersonaService(new StoreFacade(registry));
    await personas.initialize();
    const memory = new MemoryFacade();
    const stored: MemoryRecord[] = [];
    const provider: MemoryProviderContribution = {
      id: "test.memory",
      write: async (record) => {
        stored.push(record);
      },
      retrieve: async () => stored,
    };
    memory.registerProvider("test.memory", provider);
    await memory.write("borg.chat", {
      text: "The user's favorite color is cerulean.",
      personaId: DEFAULT_PERSONA_ID,
    });
    const assembled = await new PromptAssembler(personas, memory).assemble({
      personaId: DEFAULT_PERSONA_ID,
      prompt: "What is my favorite color?",
    });
    expect(assembled.system).toContain("The user's favorite color is cerulean.");
    expect(assembled.slots.map((slot) => slot.id)).toEqual([
      "kernel.protocol",
      "kernel.persona",
      "kernel.memory",
    ]);
    expect(assembled.slots[2]).toEqual({
      id: "kernel.memory",
      omitted: false,
    });
    const protocolIndex = assembled.system.indexOf("Follow the active persona");
    const personaIndex = assembled.system.indexOf(
      "You are Borg, a careful local assistant.",
    );
    const memoryIndex = assembled.system.indexOf("cerulean");
    expect(protocolIndex).toBeGreaterThanOrEqual(0);
    expect(personaIndex).toBeGreaterThan(protocolIndex);
    expect(memoryIndex).toBeGreaterThan(personaIndex);
  });
});
