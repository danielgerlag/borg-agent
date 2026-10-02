import type { PlacedPart } from "./contract.js";
import { SHOP } from "./domain.js";

export interface GearSpec {
  readonly teeth: number;
  readonly diameterMm: number;
  readonly thicknessMm: number;
}

export function gearParts(spec: GearSpec): PlacedPart[] {
  const center = { x: SHOP.bedMm.x / 2, y: SHOP.bedMm.y / 2 };
  const maxOuter =
    Math.min(center.x, SHOP.bedMm.x - center.x, center.y, SHOP.bedMm.y - center.y) - 2;
  const thickness = clamp(spec.thicknessMm, 2, 40);
  let radius = clamp(spec.diameterMm, 16, maxOuter * 2) / 2;
  let toothDepth = clamp(radius * 0.4, 3, 16);
  if (radius + toothDepth > maxOuter) {
    toothDepth = Math.min(toothDepth, maxOuter / 5);
    radius = maxOuter - toothDepth;
  }
  const teeth = clampInt(spec.teeth, 3, 36);
  const pitch = (2 * Math.PI * radius) / teeth;
  const toothWidth = Math.max(1.2, round(pitch * 0.42));
  const depth = round(toothDepth);
  const height = round(thickness);
  const radial = radius + depth / 2;
  const parts: PlacedPart[] = [];
  for (let index = 0; index < teeth; index += 1) {
    const theta = (index / teeth) * Math.PI * 2;
    parts.push({
      kind: "box",
      widthMm: toothWidth,
      depthMm: depth,
      heightMm: height,
      position: {
        x: round(center.x + Math.cos(theta) * radial),
        y: round(center.y + Math.sin(theta) * radial),
        z: round(height / 2),
      },
      rotationDeg: { x: 0, y: 0, z: round((theta * 180) / Math.PI - 90) },
    });
  }
  parts.push({
    kind: "cylinder",
    radiusMm: round(radius),
    heightMm: height,
    position: { x: center.x, y: center.y, z: round(height / 2) },
    rotationDeg: { x: 0, y: 0, z: 0 },
  });
  return parts;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clampInt(value: number, min: number, max: number): number {
  return Math.round(clamp(value, min, max));
}
