import { describe, expect, it } from "vitest";
import { canvasEdgeToDelete } from "../src/canvas-keys";

describe("canvasEdgeToDelete", () => {
  const selected = {
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    typing: false,
    selectedEdgeId: "start-work",
  };

  it("removes the selected edge on Delete or Backspace", () => {
    expect(canvasEdgeToDelete({ ...selected, key: "Delete" })).toBe(
      "start-work",
    );
    expect(canvasEdgeToDelete({ ...selected, key: "Backspace" })).toBe(
      "start-work",
    );
  });

  it("ignores typing, modifiers, other keys, and empty selection", () => {
    expect(
      canvasEdgeToDelete({ ...selected, key: "Delete", typing: true }),
    ).toBeUndefined();
    expect(
      canvasEdgeToDelete({ ...selected, key: "Delete", metaKey: true }),
    ).toBeUndefined();
    expect(canvasEdgeToDelete({ ...selected, key: "Enter" })).toBeUndefined();
    expect(
      canvasEdgeToDelete({ ...selected, key: "Delete", selectedEdgeId: undefined }),
    ).toBeUndefined();
  });
});
