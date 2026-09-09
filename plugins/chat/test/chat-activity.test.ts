import { describe, expect, it } from "vitest";
import {
  activityCopy,
  describeTurnFailure,
  isFailureEntry,
  isToolEntry,
} from "../src/chat-activity";

describe("chat activity copy", () => {
  it("names working, tool, and waiting states", () => {
    expect(activityCopy({ kind: "thinking" })).toBe("Working…");
    expect(activityCopy({ kind: "tool", toolId: "filesystem.write" })).toBe(
      "Using filesystem.write…",
    );
    expect(
      activityCopy({
        kind: "waiting",
        wait: "tool_approval",
        toolId: "filesystem.write",
      }),
    ).toBe("Waiting for you to approve filesystem.write");
    expect(
      activityCopy({ kind: "waiting", wait: "human_input" }),
    ).toBe("Waiting for your answer");
  });

  it("keeps denied tool failures readable without dropping the raw reason", () => {
    const described = describeTurnFailure(
      "Tool filesystem.write was denied",
    );
    expect(described.title).toBe("The tool was not approved");
    expect(described.detail).toContain("denied");
  });

  it("recognizes tool and failure entries", () => {
    expect(
      isToolEntry({
        id: "1",
        role: "tool",
        content: "{}",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toBe(true);
    expect(
      isFailureEntry({
        id: "2",
        role: "event",
        content: "The turn failed.",
        createdAt: "2026-01-01T00:00:00.000Z",
        metadata: { status: "failed" },
      }),
    ).toBe(true);
  });
});
