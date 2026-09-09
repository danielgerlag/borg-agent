import { describe, expect, it } from "vitest";
import {
  groupSettingsPages,
  settingsGroupId,
} from "../src/renderer/settings-groups";

describe("settings groups", () => {
  it("places bundled pages in HiveMind-style groups", () => {
    expect(settingsGroupId({ id: "borg.themes.settings" })).toBe("general");
    expect(settingsGroupId({ id: "borg.chat.personas" })).toBe("agents");
    expect(settingsGroupId({ id: "borg.azure.settings" })).toBe("models");
    expect(settingsGroupId({ id: "borg.channel.slack.settings" })).toBe(
      "channels",
    );
    expect(settingsGroupId({ id: "borg.mcp.servers" })).toBe("tools");
    expect(settingsGroupId({ id: "borg.secrets.os.settings" })).toBe(
      "security",
    );
  });

  it("honours a declared group over inference", () => {
    expect(
      settingsGroupId({ id: "borg.azure.settings", group: "tools" }),
    ).toBe("tools");
  });

  it("keeps page order inside groups and drops empty groups", () => {
    const grouped = groupSettingsPages([
      { id: "borg.openai.settings", order: 26 },
      { id: "borg.chat.personas", order: 10 },
      { id: "borg.anthropic.settings", order: 25 },
    ]);
    expect(grouped.map(({ id }) => id)).toEqual(["agents", "models"]);
    expect(grouped[1]?.pages.map(({ id }) => id)).toEqual([
      "borg.anthropic.settings",
      "borg.openai.settings",
    ]);
  });
});
