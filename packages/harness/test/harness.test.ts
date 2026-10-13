import { describe, expect, it } from "vitest";
import { defineHarness } from "../src/index";

const domain = ["example.case-desk"] as const;

describe("defineHarness", () => {
  it("adds the platform spine and leaves reference workspaces out", () => {
    const distribution = defineHarness({
      id: "borg.case-desk",
      name: "Case desk",
      plugins: domain,
    });
    const ids = distribution.plugins.map((plugin) => plugin.id);
    expect(ids[0]).toBe("borg.anthropic");
    expect(ids.at(-1)).toBe("example.case-desk");
    expect(ids).toContain("borg.personas");
    expect(ids).toContain("borg.secrets.dev");
    expect(ids).toContain("borg.secrets.os");
    expect(ids).not.toContain("borg.chat");
    expect(ids).not.toContain("borg.bots");
    expect(ids).not.toContain("borg.graphs");
    expect(distribution.defaults).toEqual({
      models: ["borg.mock-llm:mock:scripted"],
    });
  });

  it("declares only the dev secret store when tests ask for it", () => {
    const ids = defineHarness({
      id: "example.case-desk",
      name: "Case desk",
      plugins: domain,
      secrets: "dev",
    }).plugins.map((plugin) => plugin.id);
    expect(ids).toContain("borg.secrets.dev");
    expect(ids).not.toContain("borg.secrets.os");
  });
});
