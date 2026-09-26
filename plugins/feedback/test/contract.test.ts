import { describe, expect, it } from "vitest";
import { feedbackAskInputSchema } from "../src/contract";

describe("feedback contract", () => {
  it("rejects duplicate choice IDs at the public feedback contract", () => {
    expect(
      feedbackAskInputSchema.safeParse({
        prompt: "Pick one",
        form: "choice",
        choices: [
          { id: "same", label: "First" },
          { id: "same", label: "Second" },
        ],
        source: {},
      }).success,
    ).toBe(false);
  });
});
