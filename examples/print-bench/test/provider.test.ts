import { describe, expect, it } from "vitest";
import { addToolId, feedbackAskToolId, placeToolId } from "../src/contract.js";
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

  it("draws a gear with the named tooth count and diameter", () => {
    const step = nextDesignerStep([
      { role: "user", content: `draw a gear with 12 teeth, 50 mm across\n${scene}` },
    ]);
    expect(step.name).toBe(placeToolId);
    if (step.name !== placeToolId) {
      return;
    }
    expect(step.input.parts.filter((part) => part.kind === "box")).toHaveLength(12);
    expect(step.input.parts.find((part) => part.kind === "cylinder")).toMatchObject({ radiusMm: 25 });
  });

  it("draws a default gear when the sentence gives no numbers", () => {
    const step = nextDesignerStep([{ role: "user", content: `draw a gear\n${scene}` }]);
    expect(step.name).toBe(placeToolId);
    if (step.name !== placeToolId) {
      return;
    }
    const boxes = step.input.parts.filter((part) => part.kind === "box");
    const disc = step.input.parts.find((part) => part.kind === "cylinder");
    expect(boxes).toHaveLength(8);
    expect(disc).toMatchObject({ radiusMm: 20, heightMm: 8 });
    const done = nextDesignerStep([
      { role: "user", content: `draw a gear\n${scene}` },
      { role: "assistant", content: "", toolCalls: [{ name: placeToolId, input: step.input }] },
      { role: "tool", content: JSON.stringify({ type: "revised" }) },
    ]);
    expect(done).toEqual({ content: "Drew a gear with 8 teeth, 40 mm across." });
  });

  it("asks what to build when the sentence names nothing", () => {
    const step = nextDesignerStep([{ role: "user", content: `make me something\n${scene}` }]);
    expect(step).toMatchObject({ name: feedbackAskToolId, input: { form: "text" } });
    if (step.name !== feedbackAskToolId || step.input.form !== "text") {
      return;
    }
    expect(step.input.prompt).not.toMatch(/which solid/i);
    const second = nextDesignerStep([
      { role: "user", content: `make me something\n${scene}` },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ name: feedbackAskToolId, input: step.input }],
      },
      {
        role: "tool",
        content: JSON.stringify({
          interactionId: "00000000-0000-4000-8000-000000000099",
          answer: { kind: "text", text: "a gear" },
        }),
      },
    ]);
    expect(second.name).toBe(placeToolId);
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
