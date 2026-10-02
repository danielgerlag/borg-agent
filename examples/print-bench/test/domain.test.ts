import { describe, expect, it } from "vitest";
import {
  OPENING_PARAMETERS,
  evaluate,
  inspect,
  solidFromGeometry,
  SHOP,
  type BracketGeometry,
} from "../src/domain.js";

describe("print bench domain", () => {
  it("opens on a bracket the shop will not price", () => {
    const inspection = evaluate(OPENING_PARAMETERS);
    expect(inspection.kind).toBe("fail");
    expect(inspection.findings.map((finding) => finding.code)).toEqual([
      "wall",
      "overhang",
    ]);
    expect(inspection.solid.wallMm).toBeCloseTo(0.8, 6);
    expect(inspection.solid.facetAngleDeg).toBeCloseTo(70, 6);
    expect("quote" in inspection).toBe(false);
  });

  it("prices a revision whose measured wall and overhang are inside the profile", () => {
    const inspection = evaluate({
      ...OPENING_PARAMETERS,
      wallMm: 1.6,
      chamferDeg: 30,
    });
    expect(inspection.kind).toBe("pass");
    if (inspection.kind !== "pass") {
      return;
    }
    expect(inspection.findings).toEqual([]);
    expect(inspection.quote.grams).toBeGreaterThan(0);
    expect(inspection.quote.hours).toBeGreaterThan(0);
    expect(inspection.quote.price.amount).toBeGreaterThan(0);
    expect(inspection.quote.price.currency).toBe("USD");
  });

  it("rejects a measured solid that never had a parameter record", () => {
    const rise = Math.cos((70 * Math.PI) / 180) * 12;
    const run = Math.sin((70 * Math.PI) / 180) * 12;
    const geometry: BracketGeometry = {
      outer: {
        min: { x: 0, y: 0, z: 0 },
        max: { x: 80, y: 40, z: 28 },
      },
      inner: {
        min: { x: 0.8, y: 0.8, z: 0.8 },
        max: { x: 79.2, y: 39.2, z: 28 },
      },
      hole: {
        min: { x: 37.5, y: 17.5, z: 0 },
        max: { x: 42.5, y: 22.5, z: 28 },
      },
      wedge: [
        { x: 0, y: 40 - run, z: 28 },
        { x: 80, y: 40 - run, z: 28 },
        { x: 80, y: 40, z: 28 - rise },
        { x: 0, y: 40, z: 28 - rise },
      ],
    };
    const inspection = inspect(solidFromGeometry(geometry), SHOP);
    expect(inspection.kind).toBe("fail");
    expect(inspection.solid.wallMm).toBeCloseTo(0.8, 6);
    expect(inspection.solid.facetAngleDeg).toBeCloseTo(70, 5);
    expect("quote" in inspection).toBe(false);
  });
});
