import type cytoscape from "cytoscape";
import type { BranchHandle } from "./connect";

const GHOST_NODE_ID = "__borg-edge-cursor";
const GHOST_EDGE_ID = "__borg-edge-preview";
const PORT_OFFSET_X = 74;
const BRANCH_PORT_OFFSET_Y = 16;

export function isGhostElementId(id: string): boolean {
  return id === GHOST_NODE_ID || id === GHOST_EDGE_ID;
}

export function isPortNodeId(id: string): boolean {
  return id.includes("::out");
}

export function outputPortId(
  nodeId: string,
  handle?: BranchHandle,
): string {
  return handle ? `${nodeId}::out::${handle}` : `${nodeId}::out`;
}

export function portPosition(
  origin: { readonly x: number; readonly y: number },
  handle?: BranchHandle,
): { readonly x: number; readonly y: number } {
  if (handle === "true") {
    return { x: origin.x + PORT_OFFSET_X, y: origin.y - BRANCH_PORT_OFFSET_Y };
  }
  if (handle === "false") {
    return { x: origin.x + PORT_OFFSET_X, y: origin.y + BRANCH_PORT_OFFSET_Y };
  }
  return { x: origin.x + PORT_OFFSET_X, y: origin.y };
}

function clientToModel(
  graph: cytoscape.Core,
  event: PointerEvent,
): { x: number; y: number } | undefined {
  const container = graph.container();
  if (!container) {
    return undefined;
  }
  const rect = container.getBoundingClientRect();
  const pan = graph.pan();
  const zoom = graph.zoom();
  return {
    x: (event.clientX - rect.left - pan.x) / zoom,
    y: (event.clientY - rect.top - pan.y) / zoom,
  };
}

function hitPort(
  graph: cytoscape.Core,
  position: { x: number; y: number },
): cytoscape.NodeSingular | undefined {
  const ports = graph.nodes(".port");
  for (let index = ports.length - 1; index >= 0; index -= 1) {
    const port = ports[index];
    if (!port) {
      continue;
    }
    const box = port.boundingBox({ includeOverlays: true });
    const pad = 6;
    if (
      position.x >= box.x1 - pad &&
      position.x <= box.x2 + pad &&
      position.y >= box.y1 - pad &&
      position.y <= box.y2 + pad
    ) {
      return port;
    }
  }
  return undefined;
}

function hitStep(
  graph: cytoscape.Core,
  position: { x: number; y: number },
): cytoscape.NodeSingular | undefined {
  const nodes = graph.nodes("node.step");
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const node = nodes[index];
    if (!node) {
      continue;
    }
    const box = node.boundingBox({ includeOverlays: false });
    if (
      position.x >= box.x1 &&
      position.x <= box.x2 &&
      position.y >= box.y1 &&
      position.y <= box.y2
    ) {
      return node;
    }
  }
  return undefined;
}

function clearGhost(graph: cytoscape.Core): void {
  graph.$id(GHOST_EDGE_ID).remove();
  graph.$id(GHOST_NODE_ID).remove();
}

export function syncOutputPorts(graph: cytoscape.Core): void {
  graph.nodes("node.step").forEach((node) => {
    const origin = node.position();
    const kind = node.data("kind") as string;
    if (kind === "end") {
      return;
    }
    if (kind === "branch") {
      graph.$id(outputPortId(node.id(), "true")).position(
        portPosition(origin, "true"),
      );
      graph.$id(outputPortId(node.id(), "false")).position(
        portPosition(origin, "false"),
      );
      return;
    }
    graph.$id(outputPortId(node.id())).position(portPosition(origin));
  });
}

export function attachEdgeDrawing(
  graph: cytoscape.Core,
  onConnect: (
    source: string,
    target: string,
    sourceHandle?: BranchHandle,
  ) => void,
): () => void {
  const container = graph.container();
  if (!container) {
    return () => undefined;
  }

  let drawing:
    | {
        readonly source: string;
        readonly sourceHandle?: BranchHandle;
        readonly pointerId: number;
      }
    | undefined;

  const onPointerMove = (event: PointerEvent): void => {
    if (!drawing) {
      return;
    }
    const position = clientToModel(graph, event);
    if (!position) {
      return;
    }
    graph.$id(GHOST_NODE_ID).position(position);
  };

  const stopDrawing = (event: PointerEvent): void => {
    if (!drawing || drawing.pointerId !== event.pointerId) {
      return;
    }
    const position = clientToModel(graph, event);
    const source = drawing.source;
    const sourceHandle = drawing.sourceHandle;
    drawing = undefined;
    graph.userPanningEnabled(true);
    graph.boxSelectionEnabled(true);
    try {
      container.releasePointerCapture(event.pointerId);
    } catch {
    }
    clearGhost(graph);
    if (!position) {
      return;
    }
    const target = hitStep(graph, position);
    if (!target || target.id() === source) {
      return;
    }
    onConnect(source, target.id(), sourceHandle);
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0 || drawing) {
      return;
    }
    const position = clientToModel(graph, event);
    if (!position) {
      return;
    }
    const port = hitPort(graph, position);
    if (!port) {
      return;
    }
    const source = port.data("sourceNode") as string | undefined;
    if (!source) {
      return;
    }
    const rawHandle = port.data("sourceHandle") as string | undefined;
    const sourceHandle =
      rawHandle === "true" || rawHandle === "false" ? rawHandle : undefined;
    event.preventDefault();
    event.stopPropagation();
    container.setPointerCapture(event.pointerId);
    drawing = {
      source,
      pointerId: event.pointerId,
      ...(sourceHandle ? { sourceHandle } : {}),
    };
    graph.userPanningEnabled(false);
    graph.boxSelectionEnabled(false);
    clearGhost(graph);
    graph.add([
      {
        group: "nodes",
        data: { id: GHOST_NODE_ID, label: "" },
        classes: "edge-ghost",
        position,
        selectable: false,
        grabbable: false,
      },
      {
        group: "edges",
        data: {
          id: GHOST_EDGE_ID,
          source,
          target: GHOST_NODE_ID,
        },
        classes: "edge-ghost",
        selectable: false,
      },
    ]);
  };

  const onPointerUp = (event: PointerEvent): void => {
    stopDrawing(event);
  };

  container.addEventListener("pointerdown", onPointerDown, true);
  container.addEventListener("pointermove", onPointerMove);
  container.addEventListener("pointerup", onPointerUp);
  container.addEventListener("pointercancel", onPointerUp);

  const onPosition = (event: cytoscape.EventObjectNode): void => {
    if (event.target.hasClass("port") || event.target.hasClass("edge-ghost")) {
      return;
    }
    syncOutputPorts(graph);
  };
  graph.on("position", "node", onPosition);

  return () => {
    drawing = undefined;
    clearGhost(graph);
    container.removeEventListener("pointerdown", onPointerDown, true);
    container.removeEventListener("pointermove", onPointerMove);
    container.removeEventListener("pointerup", onPointerUp);
    container.removeEventListener("pointercancel", onPointerUp);
    graph.off("position", "node", onPosition);
  };
}
