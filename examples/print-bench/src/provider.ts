import { randomUUID } from "node:crypto";
import { z, type PluginContext } from "@borg-agent/plugin-sdk";
import {
  addToolId,
  bodySchema,
  deleteToolId,
  transformToolId,
  type Primitive,
  type SceneBody,
} from "./contract.js";

const usage = {
  inputTokens: 8,
  outputTokens: 8,
  amount: 0,
  currency: "USD",
};

const help =
  "Name a box, cube, cylinder, sphere, or cone, with millimetres. Move, rotate, scale, and delete use the selection.";

export type PlannedCall =
  | { readonly name: typeof addToolId; readonly input: Primitive }
  | { readonly name: typeof transformToolId; readonly input: SceneBody }
  | { readonly name: typeof deleteToolId; readonly input: { readonly id: string } };

export function planFromPrompt(text: string): PlannedCall | { readonly content: string } {
  const request = text.split("\n")[0]?.trim() ?? "";
  const scene = readScene(text);
  const selected = scene.bodies.find((body) => body.id === readSelection(text)) ?? scene.bodies.at(-1);
  const lower = request.toLowerCase();
  if (/\b(delete|remove)\b/u.test(lower)) {
    return selected
      ? { name: deleteToolId, input: { id: selected.id } }
      : { content: "Nothing is selected." };
  }
  if (/\b(move|translate|shift)\b/u.test(lower)) {
    return selected ? move(request, selected, /\bto\b/u.test(lower)) : { content: "Nothing is selected." };
  }
  if (/\b(rotate|turn)\b/u.test(lower)) {
    return selected ? rotate(request, selected) : { content: "Nothing is selected." };
  }
  if (/\bscale\b/u.test(lower)) {
    return selected ? scale(request, selected) : { content: "Nothing is selected." };
  }
  const solid = primitiveFrom(lower, numbers(request, false));
  return solid ? { name: addToolId, input: solid } : { content: help };
}

export function registerScriptedModel(context: PluginContext): { dispose(): void } {
  return context.models.registerProvider({
    id: "example.print-bench",
    models: ["scripted"],
    egress: { kind: "local", capacity: "local-only" },
    async complete(request, permit, signal) {
      signal.throwIfAborted();
      await permit.commit();
      const last = request.messages.at(-1);
      if (last?.role === "tool") {
        return { content: "Solid updated.", usage };
      }
      const editable = [addToolId, transformToolId, deleteToolId].some((id) =>
        request.tools.some((tool) => tool.id === id),
      );
      if (!editable) {
        return { content: "This seat cannot edit the solid.", usage };
      }
      const text = request.messages.find((message) => message.role === "user")?.content ?? "";
      const planned = planFromPrompt(text);
      if ("content" in planned) {
        return { content: planned.content, usage };
      }
      return {
        toolCalls: [{ id: randomUUID(), name: planned.name, input: planned.input }],
        usage,
      };
    },
  });
}

function primitiveFrom(text: string, values: readonly number[]): Primitive | undefined {
  const mentions: { index: number; kind: Primitive["kind"] | "cube" }[] = [];
  for (const [word, kind] of [
    ["cube", "cube"],
    ["box", "box"],
    ["block", "box"],
    ["cylinder", "cylinder"],
    ["tube", "cylinder"],
    ["sphere", "sphere"],
    ["ball", "sphere"],
    ["cone", "cone"],
  ] as const) {
    const index = text.indexOf(word);
    if (index >= 0) {
      mentions.push({ index, kind });
    }
  }
  mentions.sort((left, right) => left.index - right.index);
  const kind = mentions[0]?.kind;
  const first = values[0] ?? 0;
  const second = values[1] ?? 0;
  const third = values[2] ?? 0;
  if (kind === "cube") {
    const size = first > 0 ? first : 30;
    return { kind: "box", widthMm: size, depthMm: size, heightMm: size };
  }
  if (kind === "box") {
    return {
      kind: "box",
      widthMm: first > 0 ? first : 40,
      depthMm: second > 0 ? second : 30,
      heightMm: third > 0 ? third : 20,
    };
  }
  if (kind === "cylinder") {
    return {
      kind: "cylinder",
      radiusMm: first > 0 ? first : 12,
      heightMm: second > 0 ? second : 30,
    };
  }
  if (kind === "cone") {
    return {
      kind: "cone",
      radiusMm: first > 0 ? first : 16,
      heightMm: second > 0 ? second : 28,
    };
  }
  if (kind === "sphere") {
    return { kind: "sphere", radiusMm: first > 0 ? first : 15 };
  }
  return undefined;
}

function move(request: string, body: SceneBody, absolute: boolean): PlannedCall {
  const [x, y, z] = numbers(request, true);
  const position = absolute
    ? { x: x ?? body.position.x, y: y ?? body.position.y, z: z ?? body.position.z }
    : {
        x: body.position.x + (x ?? 0),
        y: body.position.y + (y ?? 0),
        z: body.position.z + (z ?? 0),
      };
  return { name: transformToolId, input: { ...body, position } };
}

function rotate(request: string, body: SceneBody): PlannedCall {
  const values = numbers(request, true);
  const rotationDeg =
    values.length >= 3
      ? {
          x: body.rotationDeg.x + (values[0] ?? 0),
          y: body.rotationDeg.y + (values[1] ?? 0),
          z: body.rotationDeg.z + (values[2] ?? 0),
        }
      : { ...body.rotationDeg, z: body.rotationDeg.z + (values[0] ?? 0) };
  return { name: transformToolId, input: { ...body, rotationDeg } };
}

function scale(request: string, body: SceneBody): PlannedCall {
  const factor = numbers(request, false)[0] ?? 2;
  if (body.kind === "box") {
    return {
      name: transformToolId,
      input: {
        ...body,
        widthMm: body.widthMm * factor,
        depthMm: body.depthMm * factor,
        heightMm: body.heightMm * factor,
      },
    };
  }
  if (body.kind === "sphere") {
    return { name: transformToolId, input: { ...body, radiusMm: body.radiusMm * factor } };
  }
  return {
    name: transformToolId,
    input: { ...body, radiusMm: body.radiusMm * factor, heightMm: body.heightMm * factor },
  };
}

function readScene(text: string): { bodies: SceneBody[] } {
  const match = text.match(/Scene: (\[.*\])/u);
  const parsed = z.array(bodySchema).safeParse(match?.[1] ? JSON.parse(match[1]) : []);
  return { bodies: parsed.success ? parsed.data : [] };
}

function readSelection(text: string): string | undefined {
  const match = text.match(/Selection: ([^\s]+)/u);
  return match?.[1] === "none" ? undefined : match?.[1];
}

function numbers(text: string, signed: boolean): number[] {
  const pattern = signed ? /-?\d+(?:\.\d+)?/gu : /\d+(?:\.\d+)?/gu;
  return [...text.matchAll(pattern)].map((match) => Number(match[0])).filter((value) => Number.isFinite(value));
}
