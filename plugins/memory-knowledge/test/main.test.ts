import {
  createTestHarness,
  type JsonValue,
  type MemoryProviderContribution,
  type MemoryRecord,
  type PluginContext,
  type StoreEntry,
} from "@borg/plugin-sdk";
import { describe, expect, it } from "vitest";
import { MemoryFacade } from "../../../packages/kernel/src/memory-facade";
import manifest from "../borg.plugin.json";
import plugin from "../src/main";

function createStore() {
  const values = new Map<string, JsonValue>();
  return {
    values,
    get: async (key: string) => values.get(key),
    set: async (key: string, value: JsonValue) => {
      values.set(key, value);
    },
    delete: async (key: string) => {
      values.delete(key);
    },
    list: async (prefix = ""): Promise<readonly StoreEntry[]> =>
      [...values.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => ({ key, value })),
    transaction: async () => undefined,
  };
}

describe("borg.memory.knowledge", () => {
  it("matches its manifest and persists semantic records through the facade", async () => {
    expect(plugin.id).toBe(manifest.id);
    expect(plugin.permissions).toEqual(manifest.permissions);
    expect(plugin.contributes.kinds).toEqual(manifest.contributes.kinds);

    const facade = new MemoryFacade();
    const store = createStore();
    let registered: MemoryProviderContribution | undefined;
    const harness = await createTestHarness(plugin, {
      pluginId: plugin.id,
      store,
      memory: {
        registerProvider: (provider: MemoryProviderContribution) => {
          registered = provider;
          return facade.registerProvider(plugin.id, provider);
        },
        write: async () => {
          throw new Error("unused");
        },
        retrieve: async () => [],
      },
    } as unknown as PluginContext);

    expect(registered?.id).toBe("borg.memory.knowledge");
    const written = await facade.write("borg.chat", {
      text: "The user's favorite color is cerulean.",
      personaId: "system/general",
    });
    expect(store.values.get(`records/${written.id}`)).toMatchObject({
      text: "The user's favorite color is cerulean.",
      kind: "semantic",
    });
    const hits = await facade.retrieve({
      personaId: "system/general",
      text: "cerulean",
    });
    expect(hits.map((record: MemoryRecord) => record.text)).toEqual([
      "The user's favorite color is cerulean.",
    ]);
    await harness.deactivate();
    await expect(
      facade.retrieve({ personaId: "system/general" }),
    ).rejects.toThrow(/provider/i);
  });
});
