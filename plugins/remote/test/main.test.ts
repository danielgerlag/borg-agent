import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import remotePlugin from "../src/main";
import { RemoteOrchestrator, type RemoteProvider } from "../src/orchestrator";
import { createRemoteHarness, sampleRunSpec } from "./harness";

describe("borg.remote plugin", () => {
  it("agrees with its static manifest", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../borg.plugin.json", import.meta.url), "utf8"),
    ) as Record<string, unknown>;
    expect(remotePlugin).toMatchObject({
      id: manifest.id,
      version: manifest.version,
      permissions: manifest.permissions,
      contributes: manifest.contributes,
    });
  });

  it("rejects unattended tools before the provider runs", async () => {
    let submitted = false;
    const fake: RemoteProvider = {
      runtime: "local",
      list: async () => [],
      provision: async () => {
        throw new Error("provision unused");
      },
      destroy: async () => false,
      submitRun: async () => {
        submitted = true;
        return "00000000-0000-4000-8000-000000000099";
      },
      getRun: async () => {
        throw new Error("get unused");
      },
    };
    const orchestrator = new RemoteOrchestrator(
      new Map([["local", fake]]),
    );
    const legal = sampleRunSpec();
    await expect(
      orchestrator.submitRun("local/dev", {
        ...legal,
        persona: { ...legal.persona, allowedTools: ["tools.ask"] },
      }),
    ).rejects.toThrow(/cannot use/);
    await expect(
      orchestrator.submitRun("local/dev", {
        ...legal,
        persona: { ...legal.persona, allowedTools: ["filesystem.write"] },
      }),
    ).rejects.toThrow(/cannot use/);
    expect(submitted).toBe(false);
  });

  it("lists and provisions a local worker", async () => {
    const harness = createRemoteHarness();
    const active = await harness.activate();
    await expect(harness.invokeList()).resolves.toEqual({ workers: [] });
    const provisioned = (await harness.invokeProvision({
      runtime: "local",
      displayName: "dev",
    })) as { worker: { id: string; runtime: string; status: string } };
    expect(provisioned.worker).toMatchObject({
      id: "local/dev",
      runtime: "local",
      status: "ready",
    });
    const listed = (await harness.invokeList()) as {
      workers: readonly { id: string }[];
    };
    expect(listed.workers.map((worker) => worker.id)).toEqual(["local/dev"]);
    const legal = sampleRunSpec();
    await expect(
      harness.invokeSubmit("local/dev", {
        ...legal,
        persona: { ...legal.persona, allowedTools: ["tools.ask"] },
      }),
    ).rejects.toThrow(/cannot use/);
    await active.deactivate();
  });
});
