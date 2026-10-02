const HEIGHT_MM = 28;
const SLOPE_MM = 12;
const EPSILON = 1e-6;

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface Box {
  readonly min: Vec3;
  readonly max: Vec3;
}

export interface FanBracketParameters {
  readonly wallMm: number;
  readonly holeMm: number;
  readonly footprint: { readonly widthMm: number; readonly depthMm: number };
  readonly chamferDeg: number;
}

export interface ShopRules {
  readonly bedMm: { readonly x: 250; readonly y: 210; readonly z: 220 };
  readonly minWallMm: 1.2;
  readonly maxOverhangDeg: 45;
  readonly densityGPerCm3: 1.27;
  readonly gramsPerHour: 15;
  readonly usdPerGram: 0.08;
  readonly usdPerHour: 12;
}

export const SHOP: ShopRules = {
  bedMm: { x: 250, y: 210, z: 220 },
  minWallMm: 1.2,
  maxOverhangDeg: 45,
  densityGPerCm3: 1.27,
  gramsPerHour: 15,
  usdPerGram: 0.08,
  usdPerHour: 12,
};

export const OPENING_PARAMETERS: FanBracketParameters = {
  wallMm: 0.8,
  holeMm: 5,
  footprint: { widthMm: 80, depthMm: 40 },
  chamferDeg: 70,
};

export interface Mesh {
  readonly positions: readonly number[];
  readonly indices: readonly number[];
}

export interface BracketGeometry {
  readonly outer: Box;
  readonly inner: Box;
  readonly hole: Box;
  readonly wedge: readonly [Vec3, Vec3, Vec3, Vec3];
}

export interface Measurements {
  readonly wallMm: number;
  readonly holeMm: number;
  readonly facetAngleDeg: number;
  readonly boundsMm: Vec3;
  readonly volumeCm3: number;
}

export interface MeasuredSolid extends BracketGeometry, Measurements {
  readonly mesh: Mesh;
}

export interface Finding {
  readonly code: "wall" | "hole" | "footprint" | "overhang";
  readonly measured: number;
  readonly limit: number;
}

export interface Quote {
  readonly grams: number;
  readonly hours: number;
  readonly price: { readonly currency: "USD"; readonly amount: number };
}

const passBrand: unique symbol = Symbol("print-bench-pass");

export interface PassToken {
  readonly [passBrand]: "pass";
  readonly solid: MeasuredSolid;
}

export type Inspection =
  | {
      readonly kind: "fail";
      readonly solid: MeasuredSolid;
      readonly findings: readonly [Finding, ...Finding[]];
    }
  | {
      readonly kind: "pass";
      readonly solid: MeasuredSolid;
      readonly findings: readonly [];
      readonly quote: Quote;
      readonly token: PassToken;
    };

export function compile(parameters: FanBracketParameters): MeasuredSolid {
  return solidFromGeometry(geometryFromParameters(parameters));
}

export function evaluate(parameters: FanBracketParameters): Inspection {
  return inspect(compile(parameters), SHOP);
}

export function solidFromGeometry(geometry: BracketGeometry): MeasuredSolid {
  return {
    ...geometry,
    ...measure(geometry),
    mesh: meshFromGeometry(geometry),
  };
}

export function geometryFromParameters(
  parameters: FanBracketParameters,
): BracketGeometry {
  const width = parameters.footprint.widthMm;
  const depth = parameters.footprint.depthMm;
  const wall = parameters.wallMm;
  const radians = (parameters.chamferDeg * Math.PI) / 180;
  const run = Math.sin(radians) * SLOPE_MM;
  const rise = Math.cos(radians) * SLOPE_MM;
  return {
    outer: box({ x: 0, y: 0, z: 0 }, { x: width, y: depth, z: HEIGHT_MM }),
    inner: box(
      { x: wall, y: wall, z: wall },
      { x: width - wall, y: depth - wall, z: HEIGHT_MM },
    ),
    hole: centeredHole(width, depth, parameters.holeMm),
    wedge: [
      { x: 0, y: depth - run, z: HEIGHT_MM },
      { x: width, y: depth - run, z: HEIGHT_MM },
      { x: width, y: depth, z: HEIGHT_MM - rise },
      { x: 0, y: depth, z: HEIGHT_MM - rise },
    ],
  };
}

export function measure(geometry: BracketGeometry): Measurements {
  const wallMm = Math.min(
    geometry.inner.min.x - geometry.outer.min.x,
    geometry.outer.max.x - geometry.inner.max.x,
    geometry.inner.min.y - geometry.outer.min.y,
    geometry.outer.max.y - geometry.inner.max.y,
    geometry.inner.min.z - geometry.outer.min.z,
  );
  const normal = wedgeNormal(geometry.wedge);
  const facetAngleDeg =
    (Math.atan2(Math.abs(normal.z), Math.abs(normal.y)) * 180) / Math.PI;
  const boundsMm = {
    x: geometry.outer.max.x - geometry.outer.min.x,
    y: geometry.outer.max.y - geometry.outer.min.y,
    z: geometry.outer.max.z - geometry.outer.min.z,
  };
  const outerVolume = volumeOf(geometry.outer);
  const innerVolume = Math.max(0, volumeOf(geometry.inner));
  const floor = Math.max(0, geometry.inner.min.z - geometry.outer.min.z);
  const holeVolume = geometryHoleSpan(geometry.hole) ** 2 * floor;
  const [a, , , d] = geometry.wedge;
  const run = Math.max(0, d.y - a.y);
  const rise = Math.max(0, a.z - d.z);
  const wedgeVolume = (boundsMm.x * run * rise) / 2;
  const volumeCm3 = Math.max(
    0,
    (outerVolume - innerVolume - holeVolume - wedgeVolume) / 1000,
  );
  return {
    wallMm,
    holeMm: geometryHoleSpan(geometry.hole),
    facetAngleDeg,
    boundsMm,
    volumeCm3,
  };
}

export function inspect(solid: MeasuredSolid, rules: ShopRules): Inspection {
  const findings: Finding[] = [];
  if (solid.wallMm + EPSILON < rules.minWallMm) {
    findings.push({
      code: "wall",
      measured: solid.wallMm,
      limit: rules.minWallMm,
    });
  }
  const opening = Math.min(
    solid.inner.max.x - solid.inner.min.x,
    solid.inner.max.y - solid.inner.min.y,
  );
  if (solid.holeMm > opening + EPSILON || solid.holeMm <= 0) {
    findings.push({
      code: "hole",
      measured: solid.holeMm,
      limit: Math.max(0, opening),
    });
  }
  if (
    solid.boundsMm.x > rules.bedMm.x + EPSILON ||
    solid.boundsMm.y > rules.bedMm.y + EPSILON ||
    solid.boundsMm.z > rules.bedMm.z + EPSILON
  ) {
    findings.push({
      code: "footprint",
      measured: Math.max(solid.boundsMm.x, solid.boundsMm.y, solid.boundsMm.z),
      limit: Math.min(rules.bedMm.x, rules.bedMm.y, rules.bedMm.z),
    });
  }
  if (solid.facetAngleDeg > rules.maxOverhangDeg + EPSILON) {
    findings.push({
      code: "overhang",
      measured: solid.facetAngleDeg,
      limit: rules.maxOverhangDeg,
    });
  }
  if (findings.length === 0) {
    const token: PassToken = { [passBrand]: "pass", solid };
    return { kind: "pass", solid, findings: [], quote: price(token, rules), token };
  }
  return {
    kind: "fail",
    solid,
    findings: findings as [Finding, ...Finding[]],
  };
}

export function price(token: PassToken, rules: ShopRules): Quote {
  const grams = token.solid.volumeCm3 * rules.densityGPerCm3;
  const hours = grams / rules.gramsPerHour;
  return {
    grams,
    hours,
    price: {
      currency: "USD",
      amount: rules.usdPerGram * grams + rules.usdPerHour * hours,
    },
  };
}

function geometryHoleSpan(hole: Box): number {
  return hole.max.x - hole.min.x;
}

function wedgeNormal(wedge: readonly [Vec3, Vec3, Vec3, Vec3]): Vec3 {
  const [a, b, , d] = wedge;
  const ab = subtract(b, a);
  const ad = subtract(d, a);
  const cross = {
    x: ab.y * ad.z - ab.z * ad.y,
    y: ab.z * ad.x - ab.x * ad.z,
    z: ab.x * ad.y - ab.y * ad.x,
  };
  const length = Math.hypot(cross.x, cross.y, cross.z);
  if (length < EPSILON) {
    return { x: 0, y: 1, z: 0 };
  }
  return { x: cross.x / length, y: cross.y / length, z: cross.z / length };
}

function meshFromGeometry(geometry: BracketGeometry): Mesh {
  const positions: number[] = [];
  const indices: number[] = [];
  addBox(positions, indices, geometry.outer);
  addBox(positions, indices, geometry.inner);
  addBox(positions, indices, geometry.hole);
  const [a, b, c, d] = geometry.wedge;
  addTriangle(positions, indices, a, b, c);
  addTriangle(positions, indices, a, c, d);
  return { positions, indices };
}

function addBox(positions: number[], indices: number[], solid: Box): void {
  const base = positions.length / 3;
  const { min, max } = solid;
  const corners = [
    [min.x, min.y, min.z],
    [max.x, min.y, min.z],
    [max.x, max.y, min.z],
    [min.x, max.y, min.z],
    [min.x, min.y, max.z],
    [max.x, min.y, max.z],
    [max.x, max.y, max.z],
    [min.x, max.y, max.z],
  ];
  for (const corner of corners) {
    positions.push(corner[0] ?? 0, corner[1] ?? 0, corner[2] ?? 0);
  }
  const faces = [
    [0, 1, 2, 3],
    [4, 7, 6, 5],
    [0, 4, 5, 1],
    [1, 5, 6, 2],
    [2, 6, 7, 3],
    [3, 7, 4, 0],
  ];
  for (const face of faces) {
    const a = face[0];
    const b = face[1];
    const c = face[2];
    const d = face[3];
    if (a === undefined || b === undefined || c === undefined || d === undefined) {
      continue;
    }
    indices.push(base + a, base + b, base + c, base + a, base + c, base + d);
  }
}

function addTriangle(
  positions: number[],
  indices: number[],
  a: Vec3,
  b: Vec3,
  c: Vec3,
): void {
  const base = positions.length / 3;
  positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  indices.push(base, base + 1, base + 2);
}

function centeredHole(width: number, depth: number, holeMm: number): Box {
  return box(
    { x: width / 2 - holeMm / 2, y: depth / 2 - holeMm / 2, z: 0 },
    { x: width / 2 + holeMm / 2, y: depth / 2 + holeMm / 2, z: HEIGHT_MM },
  );
}

function box(min: Vec3, max: Vec3): Box {
  return { min, max };
}

function volumeOf(solid: Box): number {
  return (
    (solid.max.x - solid.min.x) *
    (solid.max.y - solid.min.y) *
    (solid.max.z - solid.min.z)
  );
}

function subtract(left: Vec3, right: Vec3): Vec3 {
  return {
    x: left.x - right.x,
    y: left.y - right.y,
    z: left.z - right.z,
  };
}
