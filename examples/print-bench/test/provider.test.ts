import { describe, expect, it } from "vitest";
import { addToolId, feedbackAskToolId } from "../src/contract.js";
import { nextDesignerStep } from "../src/provider.js";

const scene = "Selection: none\nScene: []";

describe("print bench designer", () => {
  it("adds a solid when the sentence already names the size", () => {
    const step = nextDesignerStep([{ role: "user", content: `add a sphere radius 15\n${scene}` }]);
    expect(step).toMatchObject({ name: addToolId, input: { kind: "sphere", radiusMm: 15 } });
  });

  it("asks for a radius, then adds the sphere from the answer", () => {
    const first = nextDesignerStep([{ role: "user", content: `a sphere\n${scene}` }]);
    expect(first).toMatchObject({
      name: feedbackAskToolId,
      input: { form: "text", prompt: expect.stringMatching(/radius/i) },
    });
    const second = nextDesignerStep([
      { role: "user", content: `a sphere\n${scene}` },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ name: feedbackAskToolId, input: { prompt: "radius", form: "text" } }],
      },
      {
        role: "tool",
        content: JSON.stringify({
          interactionId: "00000000-0000-4000-8000-000000000099",
          answer: { kind: "text", text: "15" },
        }),
      },
    ]);
    expect(second).toMatchObject({ name: addToolId, input: { kind: "sphere", radiusMm: 15 } });
  });

  it("asks which solid when the sentence does not name one", () => {
    const step = nextDesignerStep([{ role: "user", content: `make me something\n${scene}` }]);
    expect(step).toMatchObject({ name: feedbackAskToolId, input: { form: "choice" } });
  });

  it("stops after the solid tool returns", () => {
    const step = nextDesignerStep([
      { role: "user", content: `add a sphere radius 15\n${scene}` },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ name: addToolId, input: { kind: "sphere", radiusMm: 15 } }],
      },
      { role: "tool", content: JSON.stringify({ type: "revised" }) },
    ]);
    expect(step).toEqual({ content: "Added a sphere." });
  });
});
