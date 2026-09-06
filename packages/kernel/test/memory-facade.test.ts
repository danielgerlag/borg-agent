import { describe, expect, it } from "vitest";
import type {
  MemoryProviderContribution,
  MemoryRecord,
} from "@borg/plugin-sdk";
import { MemoryFacade } from "../src";

function createProvider(): MemoryProviderContribution & {
  readonly records: MemoryRecord[];
} {
  const records: MemoryRecord[] = [];
  return {
    id: "test.memory",
    records,
    write: async (record) => {
      records.push(record);
    },
    retrieve: async () => records,
  };
}

describe("MemoryFacade", () => {
  it("writes a record and retrieves its text", async () => {
    const facade = new MemoryFacade();
    facade.registerProvider("test.memory", createProvider());
    const written = await facade.write("borg.chat", {
      text: "The user's favorite color is cerulean.",
      personaId: "system/general",
    });
    expect(written.kind).toBe("semantic");
    expect(written.classification).toBe("internal");
    const hits = await facade.retrieve({
      personaId: "system/general",
      text: "favorite color",
    });
    expect(hits.map((record) => record.text)).toEqual([
      "The user's favorite color is cerulean.",
    ]);
  });

  it("throws when no memory provider is registered", async () => {
    const facade = new MemoryFacade();
    await expect(
      facade.write("borg.chat", {
        text: "orphan fact",
        personaId: "system/general",
      }),
    ).rejects.toThrow(/provider/i);
    await expect(
      facade.retrieve({ personaId: "system/general" }),
    ).rejects.toThrow(/provider/i);
  });

  it("scopes retrieve by persona and session", async () => {
    const facade = new MemoryFacade();
    facade.registerProvider("test.memory", createProvider());
    const sessionA = "11111111-1111-4111-8111-111111111111";
    const sessionB = "22222222-2222-4222-8222-222222222222";
    await facade.write("borg.chat", {
      text: "alpha session fact",
      personaId: "system/general",
      sessionId: sessionA,
    });
    await facade.write("borg.chat", {
      text: "beta session fact",
      personaId: "system/general",
      sessionId: sessionB,
    });
    await facade.write("borg.chat", {
      text: "other persona fact",
      personaId: "user/reviewer",
      sessionId: sessionA,
    });

    const sessionHits = await facade.retrieve({
      personaId: "system/general",
      sessionId: sessionA,
    });
    expect(sessionHits.map((record) => record.text)).toEqual([
      "alpha session fact",
    ]);
    const personaHits = await facade.retrieve({
      personaId: "user/reviewer",
      sessionId: sessionA,
    });
    expect(personaHits.map((record) => record.text)).toEqual([
      "other persona fact",
    ]);
  });
});
