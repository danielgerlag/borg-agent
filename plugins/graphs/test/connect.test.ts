import { describe, expect, it } from "vitest";
import type { GraphDefinition } from "@borg/contracts";
import { connectNodes } from "../src/connect";
import { outputPortId, portPosition } from "../src/draw-edges";

function graph(
  nodes: GraphDefinition["nodes"],
  edges: GraphDefinition["edges"] = [],
): GraphDefinition {
  return {
    id: "demo",
    name: "Demo",
    version: "1.0.0",
    engineId: "borg.graphs.hivemind-v1",
    mode: "background",
    inputSchema: {},
    variablesSchema: {},
    nodes,
    edges,
  };
}

const start = {
  id: "start",
  type: "trigger" as const,
  kind: "manual",
  config: {},
  onError: { action: "fail" as const },
};
const gate = {
  id: "gate",
  type: "control" as const,
  kind: "branch",
  config: {},
  onError: { action: "fail" as const },
};
const finish = {
  id: "finish",
  type: "control" as const,
  kind: "end",
  config: {},
  onError: { action: "fail" as const },
};

describe("connectNodes", () => {
  it("connects two steps and unique-suffixes a colliding id", () => {
    const first = connectNodes(graph([start, finish]), {
      source: "start",
      target: "finish",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    expect(first.edge).toEqual({
      id: "start-to-finish",
      source: "start",
      target: "finish",
    });
    const second = connectNodes(first.definition, {
      source: "start",
      target: "finish",
    });
    expect(second.ok).toBe(false);
    if (second.ok) {
      return;
    }
    expect(second.reason).toBe("That edge already exists.");
  });

  it("rejects a self-loop and missing ends", () => {
    expect(
      connectNodes(graph([start, finish]), {
        source: "start",
        target: "start",
      }),
    ).toEqual({
      ok: false,
      reason: "An edge must connect two different steps.",
    });
    expect(
      connectNodes(graph([start, finish]), { source: "", target: "finish" }),
    ).toEqual({ ok: false, reason: "Choose a source and target step." });
    expect(
      connectNodes(graph([start, finish]), {
        source: "missing",
        target: "finish",
      }),
    ).toEqual({ ok: false, reason: "Choose a source and target step." });
  });

  it("stores branch outcomes as sourceHandle and allows both true and false", () => {
    const trueEdge = connectNodes(graph([start, gate, finish]), {
      source: "gate",
      target: "finish",
      sourceHandle: "true",
    });
    expect(trueEdge.ok).toBe(true);
    if (!trueEdge.ok) {
      return;
    }
    expect(trueEdge.edge.sourceHandle).toBe("true");
    const falseEdge = connectNodes(trueEdge.definition, {
      source: "gate",
      target: "finish",
      sourceHandle: "false",
    });
    expect(falseEdge.ok).toBe(true);
    if (!falseEdge.ok) {
      return;
    }
    expect(falseEdge.edge.id).toBe("gate-to-finish-2");
    expect(falseEdge.edge.sourceHandle).toBe("false");
    const nonBranch = connectNodes(graph([start, finish]), {
      source: "start",
      target: "finish",
      sourceHandle: "true",
    });
    expect(nonBranch.ok).toBe(true);
    if (!nonBranch.ok) {
      return;
    }
    expect(nonBranch.edge.sourceHandle).toBeUndefined();
  });
});

describe("output ports", () => {
  it("places default and branch handles to the right of a step", () => {
    expect(outputPortId("start")).toBe("start::out");
    expect(outputPortId("gate", "true")).toBe("gate::out::true");
    expect(portPosition({ x: 100, y: 40 })).toEqual({ x: 174, y: 40 });
    expect(portPosition({ x: 100, y: 40 }, "true")).toEqual({ x: 174, y: 24 });
    expect(portPosition({ x: 100, y: 40 }, "false")).toEqual({ x: 174, y: 56 });
  });
});
