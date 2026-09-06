import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import tavilyPlugin from "../src/main";
import { createTavilyHarness } from "./harness";

describe("borg.search.tavily plugin", () => {
  it("agrees with its static manifest", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../borg.plugin.json", import.meta.url), "utf8"),
    ) as Record<string, unknown>;
    expect(tavilyPlugin).toMatchObject({
      id: manifest.id,
      version: manifest.version,
      permissions: manifest.permissions,
      contributes: manifest.contributes,
    });
  });

  it("does not register the tool until enabled and a key is present", async () => {
    const harness = createTavilyHarness();
    const active = await harness.activate();
    expect(harness.tools).toHaveLength(0);
    await expect(harness.invokeStatus()).resolves.toEqual({
      hasKey: false,
      enabled: false,
      connected: false,
    });
    harness.secrets.set("apiKey", "tvly-test");
    expect(harness.tools).toHaveLength(0);
    await harness.invokeConnect();
    expect(harness.tools.map((tool) => tool.id)).toEqual(["tavily.search"]);
    await expect(harness.invokeStatus()).resolves.toEqual({
      hasKey: true,
      enabled: true,
      connected: true,
    });
    await active.deactivate();
  });

  it("executes the registered tool into parsed hits", async () => {
    const harness = createTavilyHarness({
      hasKey: true,
      enabled: true,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            results: [
              {
                title: "Parsed Hit",
                url: "https://example.com/parsed",
                content: "from tavily",
              },
            ],
          }),
          { status: 200 },
        ),
    });
    const active = await harness.activate();
    const tool = harness.tools[0];
    expect(tool?.id).toBe("tavily.search");
    await expect(
      tool?.execute(
        { query: "borg" },
        { toolCallId: "call-1", signal: new AbortController().signal },
      ),
    ).resolves.toEqual({
      query: "borg",
      hits: [
        {
          title: "Parsed Hit",
          url: "https://example.com/parsed",
          snippet: "from tavily",
        },
      ],
    });
    await active.deactivate();
  });
});
