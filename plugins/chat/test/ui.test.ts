import { describe, expect, it } from "vitest";
import { matchesModelPreference } from "../src/model-preference";

describe("chat model preferences", () => {
  it("recognizes provider and model wildcard preferences", () => {
    const model = {
      providerId: "borg.openai",
      modelId: "gpt-5-mini",
      preferenceId: "borg.openai:gpt-5-mini",
    };

    expect(matchesModelPreference(model, "borg.openai:gpt-*")).toBe(true);
    expect(matchesModelPreference(model, "gpt-*")).toBe(true);
    expect(matchesModelPreference(model, "borg.anthropic:*")).toBe(false);
  });
});
