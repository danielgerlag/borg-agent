import {
  botSchema,
  botsCreate,
  botsList,
  botsListLogs,
  botsStart,
  botsStop,
  executionIdSchema,
  executionSecurityContextSchema,
  modelOperationPrefixSchema,
} from "@borg/contracts";
import {
  createTestHarness,
  pluginManifestSchema,
  z,
  type JsonValue,
} from "@borg/plugin-sdk";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import botsPlugin from "../src/main";
import { createBotHarness } from "./harness";

const persistedRunningBotV2Schema = z
  .object({
    version: z.literal(2),
    bot: botSchema,
    security: z
      .object({
        headExecutionId: executionIdSchema,
        active: z
          .object({
            attemptId: z.string().uuid(),
            executionId: executionIdSchema,
            operationPrefix: modelOperationPrefixSchema,
            runId: z.string().uuid().optional(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

describe("borg.bots plugin", () => {
  it("matches its manifest and runs a loop-backed bot to completion", async () => {
    const fixture = await createBotHarness();
    const manifest = pluginManifestSchema.parse(
      JSON.parse(
        await readFile(
          new URL("../borg.plugin.json", import.meta.url),
          "utf8",
        ),
      ),
    );
    expect(botsPlugin).toMatchObject({
      id: manifest.id,
      version: manifest.version,
      permissions: manifest.permissions,
      contributes: manifest.contributes,
    });

    const harness = await createTestHarness(botsPlugin, fixture.context);
    const created = await fixture.invoke(botsCreate, {
      name: "Night watch",
      launchPrompt: "scenario:background",
    });
    expect(created.bot.status).toBe("stopped");
    expect(created.bot.personaId).toBe("system/general");

    const started = await fixture.invoke(botsStart, {
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

    const again = await fixture.invoke(botsStart, {
      botId: created.bot.id,
    });
    expect(again.bot.runId).toBe(started.bot.runId);
    expect(fixture.start).toHaveBeenCalledOnce();

    const runId = z.string().uuid().parse(started.bot.runId);
    await fixture.emitLoop(runId, {
      type: "state",
      runId,
      status: "completed",
      timestamp: new Date().toISOString(),
    });

    const listed = await fixture.invoke(botsList, {});
    expect(listed.bots[0]).toMatchObject({
      id: created.bot.id,
      status: "completed",
    });
    const logs = await fixture.invoke(botsListLogs, {
      botId: created.bot.id,
    });
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

  it("stops a live bot and marks a persisted missing run interrupted on activate", async () => {
    const store = new Map<string, JsonValue>();
    const first = await createBotHarness(store);
    const firstHarness = await createTestHarness(botsPlugin, first.context);
    const created = await first.invoke(botsCreate, {
      launchPrompt: "scenario:feedback",
    });
    const started = await first.invoke(botsStart, {
      botId: created.bot.id,
    });
    expect(started.bot.status).toBe("running");

    const stoppedLive = await first.invoke(botsStop, {
      botId: created.bot.id,
    });
    expect(stoppedLive.bot.status).toBe("stopped");
    expect(first.cancel).toHaveBeenCalled();

    const restarted = await first.invoke(botsStart, {
      botId: created.bot.id,
    });
    expect(restarted.bot.status).toBe("running");
    await firstHarness.deactivate();

    const second = await createBotHarness(store);
    const secondHarness = await createTestHarness(botsPlugin, second.context);
    expect(second.start).not.toHaveBeenCalled();
    const listed = await second.invoke(botsList, {});
    expect(listed.bots[0]).toMatchObject({
      id: created.bot.id,
      status: "interrupted",
      error: "The previous attempt was interrupted when Borg stopped.",
    });

    const stopped = await second.invoke(botsStop, {
      botId: created.bot.id,
    });
    expect(stopped.bot.status).toBe("stopped");
    expect(second.cancel).not.toHaveBeenCalled();
    await secondHarness.deactivate();
  });

  it("forks a manual restart from the interrupted attempt head", async () => {
    const store = new Map<string, JsonValue>();
    const first = await createBotHarness(store);
    const firstHarness = await createTestHarness(botsPlugin, first.context);
    const created = await first.invoke(botsCreate, {
      launchPrompt: "scenario:feedback",
    });
    const started = await first.invoke(botsStart, {
      botId: created.bot.id,
    });
    await firstHarness.deactivate();

    const persistedRunning = persistedRunningBotV2Schema.parse(
      store.get(`bots/current/${created.bot.id}`),
    );
    const interruptedHeadExecutionId =
      persistedRunning.security.active.executionId;

    const second = await createBotHarness(store);
    const secondHarness = await createTestHarness(botsPlugin, second.context);
    const interruptedHead = executionSecurityContextSchema.parse(
      await second.executionSecurity.snapshot(
        "borg.bots",
        interruptedHeadExecutionId,
      ),
    );
    expect(interruptedHead.lifecycle).toMatchObject({
      state: "closed",
      outcome: "interrupted",
    });

    const restarted = await second.invoke(botsStart, {
      botId: created.bot.id,
    });
    expect(restarted.bot.status).toBe("running");
    expect(restarted.bot.runId).not.toBe(started.bot.runId);
    expect(second.start).toHaveBeenCalledOnce();

    const persistedRestart = persistedRunningBotV2Schema.parse(
      store.get(`bots/current/${created.bot.id}`),
    );
    expect(persistedRestart.security.headExecutionId).toBe(
      interruptedHeadExecutionId,
    );
    expect(persistedRestart.security.active.executionId).not.toBe(
      interruptedHeadExecutionId,
    );
    const freshAttempt = executionSecurityContextSchema.parse(
      await second.executionSecurity.snapshot(
        "borg.bots",
        persistedRestart.security.active.executionId,
      ),
    );
    expect(freshAttempt).toMatchObject({
      parentExecutionId: interruptedHeadExecutionId,
      lifecycle: { state: "open" },
    });
    expect(
      freshAttempt.provenance.recent.some(
        ({ source }) =>
          source.kind === "execution" &&
          source.id === interruptedHeadExecutionId &&
          source.relation === "parent",
      ),
    ).toBe(true);

    await secondHarness.deactivate();
  });
});
