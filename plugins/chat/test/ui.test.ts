import { describe, expect, it } from "vitest";
import {
  displayModelName,
  matchesModelPreference,
} from "../src/model-preference";

describe("chat model preferences", () => {
  it("labels models with their provider", () => {
    expect(
      displayModelName({
        providerId: "borg.azure",
        modelId: "gpt-4o",
        preferenceId: "borg.azure:gpt-4o",
      }),
    ).toBe("Azure · gpt-4o");
    expect(
      displayModelName({
        providerId: "borg.openai",
        modelId: "gpt-5-mini",
        preferenceId: "borg.openai:gpt-5-mini",
      }),
    ).toBe("OpenAI · GPT-5 Mini");
    expect(
      displayModelName({
        providerId: "borg.mock-llm",
        modelId: "mock:scripted",
        preferenceId: "borg.mock-llm:mock:scripted",
      }),
    ).toBe("Demo · Built-in demo model");
  });

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
