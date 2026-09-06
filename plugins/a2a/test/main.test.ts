import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import a2aPlugin from "../src/main";
import { createA2AHarness } from "./harness";

describe("borg.a2a plugin", () => {
  it("agrees with its static manifest", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../borg.plugin.json", import.meta.url), "utf8"),
    ) as Record<string, unknown>;
    expect(a2aPlugin).toMatchObject({
      id: manifest.id,
      version: manifest.version,
      permissions: manifest.permissions,
      contributes: manifest.contributes,
    });
  });

  it("reports disabled loopback status by default", async () => {
    const harness = createA2AHarness();
    const active = await harness.activate();
    await expect(harness.invokeStatus()).resolves.toEqual({
      enabled: false,
      listening: false,
      port: 8_733,
    });
    await active.deactivate();
  });
});
