import { describe, expect, it } from "vitest";
import { openaiDisconnect } from "../src/contract";

describe("openai commands", () => {
  it("exports the disconnect command", () => {
    expect(openaiDisconnect.id).toBe("borg.openai.disconnect");
  });
});
