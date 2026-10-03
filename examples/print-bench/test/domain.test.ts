import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  EMPTY_SCENE,
  SHOP,
  evaluate,
  inspectMesh,
  placeOnBed,
  rotateEulerXYZ,
  type Body,
} from "../src/domain.js";

const boxId = "00000000-0000-4000-8000-000000000001";

function span(positions: readonly number[]): {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
} {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (let index = 0; index < positions.length; index += 3) {
    const x = positions[index] ?? 0;
    const y = positions[index + 1] ?? 0;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  return { minX, maxX, minY, maxY };
}

function onBed(body: Body, index = 0): Body {
  return placeOnBed(body, index);
}

describe("print bench domain", () => {
  it("opens on an empty bed with no price", () => {
    const inspection = evaluate(EMPTY_SCENE);
    expect(inspection.kind).toBe("fail");
    expect(inspection.findings.map((finding) => finding.code)).toEqual(["empty"]);
    expect("quote" in inspection).toBe(false);
  });

  it("puts the centre of a solid in the middle of the plate", () => {
    const centred: Body = {
      id: boxId,
      kind: "box",
      widthMm: 40,
      depthMm: 20,
      heightMm: 10,
      position: { x: SHOP.bedMm.x / 2, y: SHOP.bedMm.y / 2, z: 5 },
      rotationDeg: { x: 0, y: 0, z: 0 },
    };
    const centredInspection = evaluate({ bodies: [centred], selectedId: centred.id });
    expect(centredInspection.kind).toBe("pass");
    const centredSpan = span(centredInspection.solid.mesh.positions);
    expect((centredSpan.minX + centredSpan.maxX) / 2).toBe(SHOP.bedMm.x / 2);
    expect((centredSpan.minY + centredSpan.maxY) / 2).toBe(SHOP.bedMm.y / 2);

    const corner: Body = { ...centred, position: { x: 0, y: 0, z: 5 } };
    const cornerInspection = evaluate({ bodies: [corner], selectedId: corner.id });
    expect(cornerInspection.kind).toBe("fail");
    expect(cornerInspection.findings.map((finding) => finding.code)).toContain("footprint");
  });

  it("prices a box that sits on the bed", () => {
    const body = onBed({
      id: boxId,
      kind: "box",
      widthMm: 10,
      depthMm: 10,
      heightMm: 10,
      position: { x: 0, y: 0, z: 0 },
      rotationDeg: { x: 0, y: 0, z: 0 },
    });
    const inspection = evaluate({ bodies: [body], selectedId: body.id });
    expect(inspection.kind).toBe("pass");
    if (inspection.kind !== "pass") {
      return;
    }
    expect(inspection.findings).toEqual([]);
    expect(inspection.solid.volumeCm3).toBeCloseTo(1, 5);
    expect(inspection.solid.overhangDeg).toBeCloseTo(0, 5);
    expect(inspection.quote.grams).toBeGreaterThan(0);
    expect(inspection.quote.hours).toBeGreaterThan(0);
    expect(inspection.quote.price.amount).toBeGreaterThan(0);
    expect(inspection.quote.price.currency).toBe("USD");
  });

  it("rejects a sphere for overhang and a box that leaves the bed", () => {
    const sphere = onBed({
      id: "00000000-0000-4000-8000-000000000002",
      kind: "sphere",
      radiusMm: 15,
      position: { x: 0, y: 0, z: 0 },
      rotationDeg: { x: 0, y: 0, z: 0 },
    });
    const overhang = evaluate({ bodies: [sphere], selectedId: sphere.id });
    expect(overhang.kind).toBe("fail");
    expect(overhang.findings.map((finding) => finding.code)).toContain("overhang");
    expect("quote" in overhang).toBe(false);

    const parked = onBed({
      id: boxId,
      kind: "box",
      widthMm: 10,
      depthMm: 10,
      heightMm: 10,
      position: { x: 0, y: 0, z: 0 },
      rotationDeg: { x: 0, y: 0, z: 0 },
    });
    const footprint = evaluate({
      bodies: [{ ...parked, position: { x: 300, y: parked.position.y, z: parked.position.z } }],
      selectedId: parked.id,
    });
    expect(footprint.kind).toBe("fail");
    expect(footprint.findings.map((finding) => finding.code)).toContain("footprint");
    expect("quote" in footprint).toBe(false);
  });

  it("measures a downward face that never had a body record", () => {
    const inspection = inspectMesh(
      {
        positions: [0, 0, 10, 0, 10, 10, 10, 0, 10],
        indices: [0, 1, 2],
      },
      SHOP,
    );
    expect(inspection.kind).toBe("fail");
    expect(inspection.findings.map((finding) => finding.code)).toEqual(["overhang"]);
    expect(inspection.solid.overhangDeg).toBeGreaterThan(45);
    expect("quote" in inspection).toBe(false);
  });

  it("rotates a vertex the same way the viewport does", () => {
    const degrees = { x: 20, y: -35, z: 50 };
    const source = { x: 4, y: -2, z: 7 };
    const rotated = rotateEulerXYZ(source, degrees);
    const vector = new THREE.Vector3(source.x, source.y, source.z).applyEuler(
      new THREE.Euler(
        THREE.MathUtils.degToRad(degrees.x),
        THREE.MathUtils.degToRad(degrees.y),
        THREE.MathUtils.degToRad(degrees.z),
        "XYZ",
      ),
    );
    expect(rotated.x).toBeCloseTo(vector.x, 5);
    expect(rotated.y).toBeCloseTo(vector.y, 5);
    expect(rotated.z).toBeCloseTo(vector.z, 5);
  });
});
