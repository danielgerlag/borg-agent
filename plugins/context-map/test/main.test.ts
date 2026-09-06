import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createTestHarness,
  type ConfigStoreProvider,
  type JsonValue,
  type PluginContext,
  type PromptSlotContribution,
  type StoreEntry,
  type StoreTransactionOperation,
} from "@borg/plugin-sdk";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PERSONA_ID,
  PersonaService,
  PersistenceRegistry,
  PromptAssembler,
  StoreFacade,
  WorkspaceService,
} from "../../../packages/kernel/src";
import manifest from "../borg.plugin.json";
import plugin, { CONTEXT_MAP_SLOT_ID } from "../src/main";

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

describe("borg.context-map", () => {
  it("lists allocated workspace files in the assembled prompt", async () => {
    expect(plugin.id).toBe(manifest.id);
    expect(plugin.permissions).toEqual(manifest.permissions);
    expect(plugin.contributes.kinds).toEqual(manifest.contributes.kinds);

    const registry = new PersistenceRegistry();
    registry.registerConfigStore("test.config", new MemoryConfigStore());
    const personas = new PersonaService(new StoreFacade(registry));
    await personas.initialize();
    const assembler = new PromptAssembler(personas);
    const root = await mkdtemp(path.join(os.tmpdir(), "borg-context-map-"));
    const workspaces = new WorkspaceService(root);
    const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let slot: PromptSlotContribution | undefined;
    const context = {
      pluginId: plugin.id,
      prompts: {
        registerSlot: (contribution: PromptSlotContribution) => {
          slot = contribution;
          return assembler.registerSlot(contribution);
        },
      },
      memory: {
        registerProvider: () => ({ dispose: () => undefined }),
        write: async () => {
          throw new Error("unused");
        },
        retrieve: async () => [],
      },
    } as unknown as PluginContext;
    const harness = await createTestHarness(plugin, context);
    const handle = workspaces.allocate("borg.chat", sessionId);
    await writeFile(path.join(handle.rootPath, "note.txt"), "hello", "utf8");

    expect(slot?.id).toBe(CONTEXT_MAP_SLOT_ID);
    const assembled = await assembler.assemble({
      personaId: DEFAULT_PERSONA_ID,
      sessionId,
      workspace: {
        listFiles: () => workspaces.listFiles("borg.chat", sessionId),
      },
    });
    expect(assembled.system).toContain("note.txt");
    expect(
      await slot?.render({
        personaId: DEFAULT_PERSONA_ID,
      }),
    ).toBeUndefined();
    await harness.deactivate();
  });
});
