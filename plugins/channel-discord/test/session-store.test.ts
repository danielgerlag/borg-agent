import type { JsonValue, PluginLogger, PluginStore } from "@borg/plugin-sdk";
import { describe, expect, it } from "vitest";
import {
  GATEWAY_SESSION_KEY,
  createGatewaySessionStore,
} from "../src/session-store";

function createStore(initial: JsonValue | undefined) {
  const values = new Map<string, JsonValue>();
  if (initial !== undefined) {
    values.set(GATEWAY_SESSION_KEY, initial);
  }
  const warnings: string[] = [];
  const store = {
    get: async (key: string) => values.get(key),
    set: async (key: string, value: JsonValue) => {
      values.set(key, value);
    },
    delete: async (key: string) => {
      values.delete(key);
    },
    list: async () => [],
    transaction: async () => undefined,
  } as unknown as PluginStore;
  const logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: (message: string) => warnings.push(message),
    error: () => undefined,
  } as unknown as PluginLogger;
  return {
    values,
    warnings,
    sessions: createGatewaySessionStore(store, logger),
  };
}

describe("discord gateway session store", () => {
  it("round trips resume coordinates without any credential", async () => {
    const { sessions, values } = createStore(undefined);
    await sessions.save({
      sessionId: "session-1",
      sequence: 12,
      resumeGatewayUrl: "wss://gateway-us-east1-b.discord.gg",
    });
    expect(values.get(GATEWAY_SESSION_KEY)).toEqual({
      version: 1,
      sessionId: "session-1",
      sequence: 12,
      resumeGatewayUrl: "wss://gateway-us-east1-b.discord.gg",
    });
    expect(JSON.stringify([...values])).not.toMatch(/token/i);
    await expect(sessions.load()).resolves.toEqual({
      sessionId: "session-1",
      sequence: 12,
      resumeGatewayUrl: "wss://gateway-us-east1-b.discord.gg",
    });
  });

  it("discards a stored session that no longer validates", async () => {
    for (const stored of [
      { version: 2, sessionId: "s", sequence: 1, resumeGatewayUrl: "wss://a.discord.gg" },
      { version: 1, sessionId: "", sequence: 1, resumeGatewayUrl: "wss://a.discord.gg" },
      { version: 1, sessionId: "s", sequence: -1, resumeGatewayUrl: "wss://a.discord.gg" },
      { version: 1, sessionId: "s", sequence: 1, resumeGatewayUrl: "http://a.discord.gg" },
      {
        version: 1,
        sessionId: "s",
        sequence: 1,
        resumeGatewayUrl: "wss://user:pass@a.discord.gg",
      },
      { version: 1, sessionId: "s", sequence: 1, resumeGatewayUrl: "wss://a.discord.gg", token: "leak" },
    ]) {
      const { sessions, values, warnings } = createStore(stored as JsonValue);
      await expect(sessions.load()).resolves.toBeUndefined();
      expect(values.has(GATEWAY_SESSION_KEY)).toBe(false);
      expect(warnings).toContain("Discord gateway session was discarded as invalid");
    }
  });

  it("clears the session on request", async () => {
    const { sessions, values } = createStore({
      version: 1,
      sessionId: "session-1",
      sequence: 1,
      resumeGatewayUrl: "wss://a.discord.gg",
    });
    await sessions.save(null);
    expect(values.has(GATEWAY_SESSION_KEY)).toBe(false);
  });
});
