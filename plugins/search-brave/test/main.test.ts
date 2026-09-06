import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import bravePlugin from "../src/main";
import { createBraveHarness } from "./harness";

describe("borg.search.brave plugin", () => {
  it("agrees with its static manifest", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../borg.plugin.json", import.meta.url), "utf8"),
    ) as Record<string, unknown>;
    expect(bravePlugin).toMatchObject({
      id: manifest.id,
      version: manifest.version,
      permissions: manifest.permissions,
      contributes: manifest.contributes,
    });
  });

  it("does not register the tool until enabled and a key is present", async () => {
    const harness = createBraveHarness();
    const active = await harness.activate();
    expect(harness.tools).toHaveLength(0);
    await harness.context.secrets.set("apiKey", "brave-test");
    await harness.invokeConnect();
    expect(harness.tools.map((tool) => tool.id)).toEqual(["brave.search"]);
    await active.deactivate();
  });
});
