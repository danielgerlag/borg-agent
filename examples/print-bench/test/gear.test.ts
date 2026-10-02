import { describe, expect, it } from "vitest";
import * as THREE from "three";
import type { PlacedPart } from "../src/contract.js";
import { compile, rotateEulerXYZ, SHOP, type Body } from "../src/domain.js";
import { gearParts } from "../src/gear.js";

function asBodies(parts: readonly PlacedPart[]): Body[] {
  return parts.map((part, index) => {
    const id = `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
    switch (part.kind) {
      case "box":
      case "cylinder":
      case "cone":
      case "sphere":
        return { id, ...part };
      default: {
        const unreachable: never = part;
        return unreachable;
      }
    }
  });
}

describe("print bench gear", () => {
  it("sits a toothed disc on the bed, with each tooth pointing outward", () => {
    const parts = gearParts({ teeth: 8, diameterMm: 40, thicknessMm: 8 });
    const disc = parts.find((part) => part.kind === "cylinder");
    const teeth = parts.filter((part) => part.kind === "box");
    expect(disc).toMatchObject({ radiusMm: 20, heightMm: 8 });
    expect(teeth).toHaveLength(8);
    if (!disc) {
      return;
    }
    for (const tooth of teeth) {
      if (tooth.kind !== "box") {
        continue;
      }
      const outward = {
        x: tooth.position.x - disc.position.x,
        y: tooth.position.y - disc.position.y,
      };
      const distance = Math.hypot(outward.x, outward.y);
      expect(distance).toBeCloseTo(disc.radiusMm + tooth.depthMm / 2, 2);
      const domain = rotateEulerXYZ({ x: 0, y: 1, z: 0 }, tooth.rotationDeg);
      const euler = new THREE.Euler(
        THREE.MathUtils.degToRad(tooth.rotationDeg.x),
        THREE.MathUtils.degToRad(tooth.rotationDeg.y),
        THREE.MathUtils.degToRad(tooth.rotationDeg.z),
        "XYZ",
      );
      const rendered = new THREE.Vector3(0, 1, 0).applyEuler(euler);
      expect(rendered.x).toBeCloseTo(domain.x, 5);
      expect(rendered.y).toBeCloseTo(domain.y, 5);
      expect((domain.x * outward.x + domain.y * outward.y) / distance).toBeGreaterThan(0.99);
    }
    const mesh = compile(asBodies(parts));
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let index = 0; index < mesh.positions.length; index += 3) {
      const x = mesh.positions[index] ?? 0;
      const y = mesh.positions[index + 1] ?? 0;
      const z = mesh.positions[index + 2] ?? 0;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      minZ = Math.min(minZ, z);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      maxZ = Math.max(maxZ, z);
    }
    expect(minZ).toBeCloseTo(0, 2);
    expect(maxZ).toBeCloseTo(8, 2);
    expect(minX).toBeGreaterThanOrEqual(-0.01);
    expect(minY).toBeGreaterThanOrEqual(-0.01);
    expect(maxX).toBeLessThanOrEqual(SHOP.bedMm.x + 0.01);
    expect(maxY).toBeLessThanOrEqual(SHOP.bedMm.y + 0.01);
  });

  it("keeps a large requested diameter on the bed", () => {
    const parts = gearParts({ teeth: 6, diameterMm: 400, thicknessMm: 8 });
    const mesh = compile(asBodies(parts));
    for (let index = 0; index < mesh.positions.length; index += 3) {
      const x = mesh.positions[index] ?? 0;
      const y = mesh.positions[index + 1] ?? 0;
      expect(x).toBeGreaterThanOrEqual(-0.01);
      expect(y).toBeGreaterThanOrEqual(-0.01);
      expect(x).toBeLessThanOrEqual(SHOP.bedMm.x + 0.01);
      expect(y).toBeLessThanOrEqual(SHOP.bedMm.y + 0.01);
    }
  });
});
