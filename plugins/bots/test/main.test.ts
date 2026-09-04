import {
  botsCreate,
  botsList,
  botsListLogs,
  botsStart,
  botsStop,
  type Bot,
} from "@borg/contracts";
import { createTestHarness } from "@borg/plugin-sdk";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import botsPlugin from "../src/main";
import { createBotHarness } from "./harness";

describe("borg.bots plugin", () => {
  it("matches its manifest and runs a loop-backed bot to completion", async () => {
    const fixture = createBotHarness();
    const manifest = JSON.parse(
      await readFile(new URL("../borg.plugin.json", import.meta.url), "utf8"),
    ) as {
      id: string;
      version: string;
      permissions: string[];
      contributes: {
        commands: string[];
        events: string[];
        kinds: string[];
      };
    };
    expect(botsPlugin).toMatchObject({
      id: manifest.id,
      version: manifest.version,
      permissions: manifest.permissions,
      contributes: manifest.contributes,
    });

    const harness = await createTestHarness(botsPlugin, fixture.context);
    const created = await fixture.invoke<{ bot: Bot }>(botsCreate, {
      name: "Night watch",
      launchPrompt: "scenario:background",
    });
    expect(created.bot.status).toBe("stopped");
    expect(created.bot.personaId).toBe("system/general");

    const started = await fixture.invoke<{ bot: Bot }>(botsStart, {
      botId: created.bot.id,
    });
    expect(started.bot.status).toBe("running");
    expect(fixture.start).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "scenario:background",
        personaId: "system/general",
        sessionId: created.bot.id,
      }),
    );

    const again = await fixture.invoke<{ bot: Bot }>(botsStart, {
      botId: created.bot.id,
    });
    expect(again.bot.runId).toBe(started.bot.runId);
    expect(fixture.start).toHaveBeenCalledOnce();

    await fixture.emitLoop(started.bot.runId!, {
      type: "state",
      runId: started.bot.runId!,
      status: "completed",
      timestamp: new Date().toISOString(),
    });

    const listed = await fixture.invoke<{ bots: Bot[] }>(botsList, {});
    expect(listed.bots[0]).toMatchObject({
      id: created.bot.id,
      status: "completed",
    });
    const logs = await fixture.invoke<{ logs: { message: string }[] }>(
      botsListLogs,
      { botId: created.bot.id },
    );
    expect(logs.logs.map(({ message }) => message)).toContain("Bot started.");
    expect(logs.logs.map(({ message }) => message)).toContain("Status: completed");
    expect(fixture.emittedEvents).toEqual(
      expect.arrayContaining([
        "borg.bots.updated",
        "borg.bots.started",
        "borg.bots.completed",
      ]),
    );

    await harness.deactivate();
  });

  it("stops a live bot and restores a persisted running bot on activate", async () => {
    const store = new Map<string, import("@borg/plugin-sdk").JsonValue>();
    const first = createBotHarness(store);
    const firstHarness = await createTestHarness(botsPlugin, first.context);
    const created = await first.invoke<{ bot: Bot }>(botsCreate, {
      launchPrompt: "scenario:feedback",
    });
    const started = await first.invoke<{ bot: Bot }>(botsStart, {
      botId: created.bot.id,
    });
    expect(started.bot.status).toBe("running");
    await firstHarness.deactivate();

    const second = createBotHarness(store);
    const secondHarness = await createTestHarness(botsPlugin, second.context);
    expect(second.start).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: "scenario:feedback",
        sessionId: created.bot.id,
      }),
    );
    const listed = await second.invoke<{ bots: Bot[] }>(botsList, {});
    expect(listed.bots[0]?.status).toBe("running");

    const stopped = await second.invoke<{ bot: Bot }>(botsStop, {
      botId: created.bot.id,
    });
    expect(stopped.bot.status).toBe("stopped");
    expect(second.cancel).toHaveBeenCalled();
    await secondHarness.deactivate();
  });
});
