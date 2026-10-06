/**
 * Solids, the print bed, and mesh inspection. Palette edits and designer tools use these rules.
 */

const EPSILON = 1e-4;

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface ShopRules {
  readonly bedMm: { readonly x: 250; readonly y: 210; readonly z: 220 };
  readonly maxOverhangDeg: 45;
}

export const SHOP: ShopRules = {
  bedMm: { x: 250, y: 210, z: 220 },
  maxOverhangDeg: 45,
};

export type Body =
  | {
      readonly id: string;
      readonly kind: "box";
      readonly widthMm: number;
      readonly depthMm: number;
      readonly heightMm: number;
      readonly position: Vec3;
      readonly rotationDeg: Vec3;
    }
  | {
      readonly id: string;
      readonly kind: "cylinder" | "cone";
      readonly radiusMm: number;
      readonly heightMm: number;
      readonly position: Vec3;
      readonly rotationDeg: Vec3;
    }
  | {
      readonly id: string;
      readonly kind: "sphere";
      readonly radiusMm: number;
      readonly position: Vec3;
      readonly rotationDeg: Vec3;
    };

export interface Scene {
  readonly bodies: readonly Body[];
  readonly selectedId: string | null;
}

export interface Mesh {
  readonly positions: readonly number[];
  readonly indices: readonly number[];
}

export interface MeasuredSolid {
  readonly boundsMm: Vec3;
  readonly volumeCm3: number;
  readonly overhangDeg: number;
  readonly mesh: Mesh;
}

export interface Finding {
  readonly code: "empty" | "footprint" | "overhang";
  readonly measured: number;
  readonly limit: number;
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
    };

export const EMPTY_SCENE: Scene = { bodies: [], selectedId: null };

export function bedFrame(): string {
  return `x and y are millimetres from the front-left corner. x 0, y 0 is that corner, not the centre. The centre of the bed is x ${SHOP.bedMm.x / 2}, y ${SHOP.bedMm.y / 2}. Position is the centre of the solid.`;
}

export interface MeshSpan {
  readonly min: Vec3;
  readonly max: Vec3;
  readonly centre: Vec3;
}

export function meshSpan(bodies: readonly Body[]): MeshSpan | undefined {
  const positions = compile(bodies).positions;
  if (positions.length === 0) {
    return undefined;
  }
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let index = 0; index < positions.length; index += 3) {
    const x = positions[index] ?? 0;
    const y = positions[index + 1] ?? 0;
    const z = positions[index + 2] ?? 0;
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
  }
  return {
    min: { x: minX, y: minY, z: minZ },
    max: { x: maxX, y: maxY, z: maxZ },
    centre: { x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: (minZ + maxZ) / 2 },
  };
}

export function shiftBodies(bodies: readonly Body[], delta: Vec3): Body[] {
  return bodies.map((body): Body => ({
    ...body,
    position: {
      x: body.position.x + delta.x,
      y: body.position.y + delta.y,
      z: body.position.z + delta.z,
    },
  }));
}

export function objectFrame(bodies: readonly Body[]): string {
  const span = meshSpan(bodies);
  if (!span) {
    return "The bed is empty. There is no object to move.";
  }
  const dx = SHOP.bedMm.x / 2 - span.centre.x;
  const dy = SHOP.bedMm.y / 2 - span.centre.y;
  return `The solids are one object. Its centre is x ${mm(span.centre.x)}, y ${mm(span.centre.y)}. It spans x ${mm(span.min.x)} to ${mm(span.max.x)} and y ${mm(span.min.y)} to ${mm(span.max.y)}. Selection is one solid, not the object. To centre the whole object on the bed, call translate with dxMm ${mm(dx)}, dyMm ${mm(dy)}, dzMm 0. translate moves every solid by that same amount and keeps their spacing.`;
}

function mm(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

export function evaluate(scene: Scene): Inspection {
  return inspectMesh(compile(scene.bodies), SHOP);
}

export function compile(bodies: readonly Body[]): Mesh {
  const positions: number[] = [];
  const indices: number[] = [];
  for (const body of bodies) {
    appendBody(positions, indices, body);
  }
  return { positions, indices };
}

export function inspectMesh(mesh: Mesh, rules: ShopRules): Inspection {
  const solid = measureMesh(mesh);
  const findings: Finding[] = [];
  if (mesh.indices.length < 3) {
    findings.push({ code: "empty", measured: 0, limit: 1 });
  } else {
    const overflow = Math.max(
      0,
      -solid.minMm.x,
      solid.maxMm.x - rules.bedMm.x,
      -solid.minMm.y,
      solid.maxMm.y - rules.bedMm.y,
      -solid.minMm.z,
      solid.maxMm.z - rules.bedMm.z,
    );
    if (overflow > EPSILON) {
      findings.push({ code: "footprint", measured: overflow, limit: 0 });
    }
    if (solid.overhangDeg > rules.maxOverhangDeg + EPSILON) {
      findings.push({
        code: "overhang",
        measured: solid.overhangDeg,
        limit: rules.maxOverhangDeg,
      });
    }
  }
  if (findings.length === 0) {
    return { kind: "pass", solid, findings: [] };
  }
  return {
    kind: "fail",
    solid,
    findings: findings as [Finding, ...Finding[]],
  };
}

export function localMesh(body: Body): Mesh {
  const positions: number[] = [];
  const indices: number[] = [];
  if (body.kind === "box") {
    addBox(positions, indices, body.widthMm, body.depthMm, body.heightMm);
  } else if (body.kind === "sphere") {
    addSphere(positions, indices, body.radiusMm);
  } else if (body.kind === "cylinder") {
    addCylinder(positions, indices, body.radiusMm, body.heightMm, false);
  } else {
    addCylinder(positions, indices, body.radiusMm, body.heightMm, true);
  }
  return { positions, indices };
}

export function placeOnBed(body: Body, index: number): Body {
  const height = body.kind === "sphere" ? body.radiusMm * 2 : body.kind === "box" ? body.heightMm : body.heightMm;
  const column = index % 4;
  const row = Math.floor(index / 4);
  return {
    ...body,
    position: { x: 40 + column * 45, y: 40 + row * 45, z: height / 2 },
    rotationDeg: { x: 0, y: 0, z: 0 },
  };
}

interface BoundsSolid extends MeasuredSolid {
  readonly minMm: Vec3;
  readonly maxMm: Vec3;
}

function measureMesh(mesh: Mesh): BoundsSolid {
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
  const empty = mesh.positions.length === 0;
  return {
    minMm: empty ? { x: 0, y: 0, z: 0 } : { x: minX, y: minY, z: minZ },
    maxMm: empty ? { x: 0, y: 0, z: 0 } : { x: maxX, y: maxY, z: maxZ },
    boundsMm: empty
      ? { x: 0, y: 0, z: 0 }
      : { x: maxX - minX, y: maxY - minY, z: maxZ - minZ },
    volumeCm3: Math.abs(signedVolume(mesh)) / 1000,
    overhangDeg: worstOverhang(mesh),
    mesh,
  };
}

function appendBody(positions: number[], indices: number[], body: Body): void {
  const local = localMesh(body);
  const base = positions.length / 3;
  for (let index = 0; index < local.positions.length; index += 3) {
    const world = translate(
      rotateEulerXYZ(
        {
          x: local.positions[index] ?? 0,
          y: local.positions[index + 1] ?? 0,
          z: local.positions[index + 2] ?? 0,
        },
        body.rotationDeg,
      ),
      body.position,
    );
    positions.push(world.x, world.y, world.z);
  }
  for (const index of local.indices) {
    indices.push(base + index);
  }
}

function signedVolume(mesh: Mesh): number {
  let volume = 0;
  for (let index = 0; index < mesh.indices.length; index += 3) {
    const a = vertex(mesh, mesh.indices[index] ?? 0);
    const b = vertex(mesh, mesh.indices[index + 1] ?? 0);
    const c = vertex(mesh, mesh.indices[index + 2] ?? 0);
    volume += a.x * (b.y * c.z - b.z * c.y) - a.y * (b.x * c.z - b.z * c.x) + a.z * (b.x * c.y - b.y * c.x);
  }
  return volume / 6;
}

function worstOverhang(mesh: Mesh): number {
  let worst = 0;
  for (let index = 0; index < mesh.indices.length; index += 3) {
    const a = vertex(mesh, mesh.indices[index] ?? 0);
    const b = vertex(mesh, mesh.indices[index + 1] ?? 0);
    const c = vertex(mesh, mesh.indices[index + 2] ?? 0);
    if (a.z <= EPSILON && b.z <= EPSILON && c.z <= EPSILON) {
      continue;
    }
    const normal = faceNormal(a, b, c);
    const tilt = (Math.acos(clamp(normal.z, -1, 1)) * 180) / Math.PI;
    if (tilt > 90) {
      worst = Math.max(worst, tilt - 90);
    }
  }
  return worst;
}

function addBox(positions: number[], indices: number[], width: number, depth: number, height: number): void {
  const x = width / 2;
  const y = depth / 2;
  const z = height / 2;
  const base = positions.length / 3;
  const corners = [
    [-x, -y, -z],
    [x, -y, -z],
    [x, y, -z],
    [-x, y, -z],
    [-x, -y, z],
    [x, -y, z],
    [x, y, z],
    [-x, y, z],
  ];
  for (const corner of corners) {
    positions.push(corner[0] ?? 0, corner[1] ?? 0, corner[2] ?? 0);
  }
  const faces = [
    [0, 2, 1],
    [0, 3, 2],
    [4, 5, 6],
    [4, 6, 7],
    [0, 1, 5],
    [0, 5, 4],
    [1, 2, 6],
    [1, 6, 5],
    [2, 3, 7],
    [2, 7, 6],
    [3, 0, 4],
    [3, 4, 7],
  ];
  for (const face of faces) {
    indices.push(base + (face[0] ?? 0), base + (face[1] ?? 0), base + (face[2] ?? 0));
  }
}

function addCylinder(
  positions: number[],
  indices: number[],
  radius: number,
  height: number,
  cone: boolean,
): void {
  const segments = 24;
  const base = positions.length / 3;
  const half = height / 2;
  for (let step = 0; step < segments; step += 1) {
    const angle = (step / segments) * Math.PI * 2;
    positions.push(Math.cos(angle) * radius, Math.sin(angle) * radius, -half);
  }
  const topStart = segments;
  for (let step = 0; step < segments; step += 1) {
    const angle = (step / segments) * Math.PI * 2;
    const ring = cone ? 0 : radius;
    positions.push(Math.cos(angle) * ring, Math.sin(angle) * ring, half);
  }
  const bottomCenter = positions.length / 3;
  positions.push(0, 0, -half);
  const topCenter = positions.length / 3;
  positions.push(0, 0, half);
  for (let step = 0; step < segments; step += 1) {
    const next = (step + 1) % segments;
    indices.push(base + bottomCenter, base + next, base + step);
    indices.push(base + step, base + next, base + topStart + step);
    indices.push(base + next, base + topStart + next, base + topStart + step);
    if (!cone) {
      indices.push(base + topCenter, base + topStart + step, base + topStart + next);
    }
  }
}

function addSphere(positions: number[], indices: number[], radius: number): void {
  const stacks = 12;
  const slices = 24;
  const base = positions.length / 3;
  for (let stack = 0; stack <= stacks; stack += 1) {
    const phi = (stack / stacks) * Math.PI;
    for (let slice = 0; slice <= slices; slice += 1) {
      const theta = (slice / slices) * Math.PI * 2;
      positions.push(
        Math.sin(phi) * Math.cos(theta) * radius,
        Math.sin(phi) * Math.sin(theta) * radius,
        Math.cos(phi) * radius,
      );
    }
  }
  const stride = slices + 1;
  for (let stack = 0; stack < stacks; stack += 1) {
    for (let slice = 0; slice < slices; slice += 1) {
      const a = base + stack * stride + slice;
      const b = a + stride;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
}

export function rotateEulerXYZ(vertex: Vec3, degrees: Vec3): Vec3 {
  const x = (degrees.x * Math.PI) / 180;
  const y = (degrees.y * Math.PI) / 180;
  const z = (degrees.z * Math.PI) / 180;
  const c1 = Math.cos(x / 2);
  const s1 = Math.sin(x / 2);
  const c2 = Math.cos(y / 2);
  const s2 = Math.sin(y / 2);
  const c3 = Math.cos(z / 2);
  const s3 = Math.sin(z / 2);
  const qx = s1 * c2 * c3 + c1 * s2 * s3;
  const qy = c1 * s2 * c3 - s1 * c2 * s3;
  const qz = c1 * c2 * s3 + s1 * s2 * c3;
  const qw = c1 * c2 * c3 - s1 * s2 * s3;
  const tx = 2 * (qy * vertex.z - qz * vertex.y);
  const ty = 2 * (qz * vertex.x - qx * vertex.z);
  const tz = 2 * (qx * vertex.y - qy * vertex.x);
  return {
    x: vertex.x + qw * tx + (qy * tz - qz * ty),
    y: vertex.y + qw * ty + (qz * tx - qx * tz),
    z: vertex.z + qw * tz + (qx * ty - qy * tx),
  };
}

function faceNormal(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const ab = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
  const ac = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z };
  const cross = {
    x: ab.y * ac.z - ab.z * ac.y,
    y: ab.z * ac.x - ab.x * ac.z,
    z: ab.x * ac.y - ab.y * ac.x,
  };
  const length = Math.hypot(cross.x, cross.y, cross.z);
  if (length < EPSILON) {
    return { x: 0, y: 0, z: 1 };
  }
  return { x: cross.x / length, y: cross.y / length, z: cross.z / length };
}

function vertex(mesh: Mesh, index: number): Vec3 {
  return {
    x: mesh.positions[index * 3] ?? 0,
    y: mesh.positions[index * 3 + 1] ?? 0,
    z: mesh.positions[index * 3 + 2] ?? 0,
  };
}

function translate(vertex: Vec3, offset: Vec3): Vec3 {
  return { x: vertex.x + offset.x, y: vertex.y + offset.y, z: vertex.z + offset.z };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
