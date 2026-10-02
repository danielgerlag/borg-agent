import { randomUUID } from "node:crypto";
import { z, type PluginContext } from "@borg-agent/plugin-sdk";
import {
  addToolId,
  bodySchema,
  deleteToolId,
  feedbackAskToolId,
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

export type DesignerStep =
  | PlannedCall
  | {
      readonly name: typeof feedbackAskToolId;
      readonly input: {
        readonly title: string;
        readonly prompt: string;
        readonly form: "text";
      };
    }
  | {
      readonly name: typeof feedbackAskToolId;
      readonly input: {
        readonly title: string;
        readonly prompt: string;
        readonly form: "choice";
        readonly choices: readonly { readonly id: string; readonly label: string }[];
      };
    }
  | { readonly content: string };

interface TurnMessage {
  readonly role: string;
  readonly content: string;
  readonly toolCalls?: readonly { readonly name: string; readonly input?: unknown }[] | undefined;
}

const solidChoices = [
  { id: "box", label: "Box" },
  { id: "cylinder", label: "Cylinder" },
  { id: "sphere", label: "Sphere" },
  { id: "cone", label: "Cone" },
] as const;

export function nextDesignerStep(messages: readonly TurnMessage[], canAsk = true): DesignerStep {
  const done = finished(messages);
  if (done) {
    return { content: done };
  }
  const user = messages.find((message) => message.role === "user")?.content ?? "";
  return decide(user, answers(messages), canAsk);
}

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
      const editable = [addToolId, transformToolId, deleteToolId].some((id) =>
        request.tools.some((tool) => tool.id === id),
      );
      if (!editable) {
        return { content: "This seat cannot edit the solid.", usage };
      }
      const step = nextDesignerStep(
        request.messages,
        request.tools.some((tool) => tool.id === feedbackAskToolId),
      );
      if ("content" in step) {
        return { content: step.content, usage };
      }
      return {
        toolCalls: [{ id: randomUUID(), name: step.name, input: step.input }],
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

function decide(user: string, replies: readonly string[], canAsk: boolean): DesignerStep {
  const lines = user.split("\n");
  const brief = lines[0]?.trim() ?? "";
  const spoken = [brief, ...replies].filter((part) => part.length > 0).join(" ");
  const sceneText = [spoken, ...lines.slice(1)].join("\n");
  const lower = spoken.toLowerCase();
  if (/\b(delete|remove)\b/u.test(lower)) {
    return planFromPrompt(sceneText);
  }
  if (/\b(move|translate|shift|rotate|turn|scale)\b/u.test(lower)) {
    if (numbers(spoken, true).length === 0) {
      if (replies.length > 0 || !canAsk) {
        return replies.length > 0
          ? { content: "I still need a distance, an angle, or a scale." }
          : planFromPrompt(sceneText);
      }
      return askText(editQuestion(lower));
    }
    return planFromPrompt(sceneText);
  }
  const shape = mentionedShape(lower);
  if (!shape) {
    return canAsk && replies.length < 2
      ? askChoice("Which solid should I add?", solidChoices)
      : { content: help };
  }
  const dims = numbers(spoken, false).filter((value) => value > 0);
  if (dims.length === 0) {
    const last = replies.at(-1)?.toLowerCase() ?? "";
    if (last.length > 0 && !mentionedShape(last) && numbers(last, false).every((value) => value <= 0)) {
      return { content: "I still need a size in millimetres." };
    }
    return canAsk ? askText(dimensionQuestion(shape)) : planFromPrompt(sceneText);
  }
  return planFromPrompt(sceneText);
}

function finished(messages: readonly TurnMessage[]): string | undefined {
  if (messages.at(-1)?.role !== "tool") {
    return undefined;
  }
  const call = precedingCall(messages);
  if (!call || call.name === feedbackAskToolId) {
    return undefined;
  }
  if (call.name === addToolId) {
    const kind = isRecord(call.input) && typeof call.input.kind === "string" ? call.input.kind : "solid";
    return `Added a ${kind}.`;
  }
  if (call.name === deleteToolId) {
    return "Removed the solid.";
  }
  if (call.name === transformToolId) {
    return "Updated the solid.";
  }
  return "Solid updated.";
}

function answers(messages: readonly TurnMessage[]): string[] {
  const found: string[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const call = message?.toolCalls?.[0];
    if (message?.role !== "assistant" || call?.name !== feedbackAskToolId) {
      continue;
    }
    const follow = messages[index + 1];
    if (follow?.role !== "tool") {
      continue;
    }
    const text = answerText(follow.content);
    if (text.length > 0) {
      found.push(text);
    }
  }
  return found;
}

function precedingCall(
  messages: readonly TurnMessage[],
): { readonly name: string; readonly input?: unknown } | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const call = messages[index]?.toolCalls?.[0];
    if (call) {
      return call;
    }
  }
  return undefined;
}

function answerText(content: string): string {
  try {
    const parsed: unknown = JSON.parse(content);
    if (!isRecord(parsed) || !isRecord(parsed.answer)) {
      return content.trim();
    }
    const answer = parsed.answer;
    if (answer.kind === "choice" && typeof answer.choiceId === "string") {
      return answer.choiceId;
    }
    if (answer.kind === "text" && typeof answer.text === "string") {
      return answer.text.trim();
    }
    if (answer.kind === "confirm" && typeof answer.confirmed === "boolean") {
      return answer.confirmed ? "yes" : "no";
    }
  } catch {
    return content.trim();
  }
  return content.trim();
}

function mentionedShape(text: string): "cube" | "box" | "cylinder" | "sphere" | "cone" | undefined {
  const mentions: { index: number; kind: "cube" | "box" | "cylinder" | "sphere" | "cone" }[] = [];
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
  return mentions[0]?.kind;
}

function dimensionQuestion(shape: string): string {
  if (shape === "sphere") {
    return "What radius should the sphere have, in millimetres?";
  }
  if (shape === "cylinder") {
    return "What radius and height should the cylinder have, in millimetres?";
  }
  if (shape === "cone") {
    return "What radius and height should the cone have, in millimetres?";
  }
  if (shape === "cube") {
    return "What size should the cube be, in millimetres?";
  }
  return "What width, depth, and height should the box have, in millimetres?";
}

function editQuestion(lower: string): string {
  if (/\bscale\b/u.test(lower)) {
    return "What scale factor should I use?";
  }
  if (/\b(rotate|turn)\b/u.test(lower)) {
    return "How many degrees should I rotate it?";
  }
  return "How far should I move it, in millimetres? Give x, y, and z.";
}

function askText(prompt: string): DesignerStep {
  return { name: feedbackAskToolId, input: { title: "Designer", prompt, form: "text" } };
}

function askChoice(
  prompt: string,
  choices: readonly { readonly id: string; readonly label: string }[],
): DesignerStep {
  return { name: feedbackAskToolId, input: { title: "Designer", prompt, form: "choice", choices } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
