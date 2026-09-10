import { feedbackAsk } from "@borg/contracts";
import { afterEach, describe, expect, it } from "vitest";
import {
  HiveMindGraphEngine,
  validateGraphDefinition,
} from "../src/executor";
import {
  battleCoverage,
  generateBattleScenarios,
  type BattleScenario,
} from "./battle-scenarios";
import { createGraphHarness } from "./harness";

const GRAPH_LAUNCH_SECURITY = {
  kind: "root" as const,
  classification: "internal" as const,
  provenance: {
    kind: "plugin" as const,
    id: "graph-battle-test",
  },
};

const engines: HiveMindGraphEngine[] = [];
const scenarios = generateBattleScenarios();

async function initializedEngine(
  fixture: ReturnType<typeof createGraphHarness>,
): Promise<HiveMindGraphEngine> {
  const engine = new HiveMindGraphEngine(fixture.context);
  engines.push(engine);
  await engine.initialize();
  return engine;
}

afterEach(async () => {
  const disposals = engines.splice(0).map(async (engine) => engine.dispose());
  await Promise.all(disposals);
});

async function runScenario(scenario: BattleScenario): Promise<void> {
  if (scenario.mode === "validate") {
    const act = () => validateGraphDefinition(scenario.definition);
    expect(act, scenario.id).toThrow(
      new RegExp(scenario.expect.rejectPattern, "i"),
    );
    return;
  }

  const fixture = createGraphHarness();
  fixture.registerToolHandler("tools.echo", (input) => {
    const text =
      input &&
      typeof input === "object" &&
      "text" in input &&
      typeof input.text === "string"
        ? input.text
        : "";
    return { echoed: text };
  });
  fixture.registerToolHandler("tools.fail", () => {
    throw new Error("tool boom");
  });
  let remainingFlakes = scenario.flakyFails ?? 0;
  fixture.registerToolHandler("tools.flaky", () => {
    if (remainingFlakes > 0) {
      remainingFlakes -= 1;
      throw new Error("flaky");
    }
    return { ok: true };
  });
  fixture.registerToolHandler("tools.hang", (_input, options) => {
    return new Promise((_, reject) => {
      const signal = options.signal;
      if (!signal) {
        return;
      }
      if (signal.aborted) {
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new Error("hang aborted"),
        );
        return;
      }
      signal.addEventListener(
        "abort",
        () => {
          reject(
            signal.reason instanceof Error
              ? signal.reason
              : new Error("hang aborted"),
          );
        },
        { once: true },
      );
    });
  });
  if (scenario.hook === "feedback-confirm") {
    fixture.handleCommand(feedbackAsk.id, async () => ({
      interactionId: "battle-feedback",
      answer: { kind: "confirm", confirmed: true },
    }));
  }
  const engine = await initializedEngine(fixture);
  try {
    if (scenario.expect.reject) {
      await engine.saveDefinition(scenario.definition as never);
      await expect(
        engine.launch({
          graphId: (scenario.definition as { id: string }).id,
          input: scenario.input as never,
          security: GRAPH_LAUNCH_SECURITY,
        }),
        scenario.id,
      ).rejects.toThrow(
        scenario.expect.rejectPattern
          ? new RegExp(scenario.expect.rejectPattern, "i")
          : undefined,
      );
      return;
    }

    await engine.saveDefinition(scenario.definition as never);
    const instanceId = await engine.launch({
      graphId: (scenario.definition as { id: string }).id,
      input: scenario.input as never,
      security: GRAPH_LAUNCH_SECURITY,
    });

    if (scenario.hook === "agent") {
      await expect
        .poll(() => fixture.startLoop.mock.calls.length)
        .toBeGreaterThan(0);
      const snapshot = (await fixture.startLoop.mock.results.at(-1)?.value) as
        | { id: string }
        | undefined;
      expect(snapshot?.id, `${scenario.id} agent run`).toBeDefined();
      await fixture.finishLoop(snapshot!.id, "agent-output");
      await fixture.flush();
    } else if (scenario.hook === "delay") {
      await fixture.flush();
      const scheduleId = [...fixture.scheduledTasks.keys()].find((id) =>
        id.startsWith(`delay:${instanceId}:`),
      );
      expect(scheduleId, `${scenario.id} delay schedule`).toBeDefined();
      await fixture.runScheduled(scheduleId!);
    } else {
      await fixture.flush();
    }

    const instance = engine.getInstance(instanceId);
    expect(instance, scenario.id).toBeDefined();
    if (scenario.expect.status) {
      expect(instance?.status, scenario.id).toBe(scenario.expect.status);
    }
    if (scenario.expect.errorIncludes) {
      expect(instance?.error ?? "", scenario.id).toMatch(
        new RegExp(scenario.expect.errorIncludes, "i"),
      );
    }
    if (scenario.expect.variables) {
      expect(instance?.variables, scenario.id).toMatchObject(
        scenario.expect.variables,
      );
    }
    if (scenario.expect.output !== undefined) {
      expect(instance?.output, scenario.id).toEqual(scenario.expect.output);
    }
  } finally {
    await engine.dispose();
    const index = engines.indexOf(engine);
    if (index >= 0) {
      engines.splice(index, 1);
    }
  }
}

describe("graph engine battle", () => {
  it("contains 500 unique scenarios across families", () => {
    expect(scenarios).toHaveLength(500);
    expect(new Set(scenarios.map((scenario) => scenario.id)).size).toBe(500);
    const coverage = battleCoverage(scenarios);
    expect(Object.keys(coverage.families).length).toBeGreaterThanOrEqual(15);
    expect(coverage.complexity.simple).toBeGreaterThan(0);
    expect(coverage.complexity.medium).toBeGreaterThan(0);
    expect(coverage.complexity.complex).toBeGreaterThan(0);
    expect(coverage.modes.validate).toBeGreaterThan(0);
    expect(coverage.modes.run).toBeGreaterThan(0);
  });

  const families = [...new Set(scenarios.map((scenario) => scenario.family))];
  for (const family of families) {
    const members = scenarios.filter((scenario) => scenario.family === family);
    it(`family ${family} (${members.length})`, async () => {
      const failures: string[] = [];
      for (const scenario of members) {
        try {
          await runScenario(scenario);
        } catch (failure) {
          failures.push(
            `${scenario.id}: ${
              failure instanceof Error ? failure.message : String(failure)
            }`,
          );
        }
      }
      expect(failures, failures.join("\n")).toEqual([]);
    }, 120_000);
  }
});
