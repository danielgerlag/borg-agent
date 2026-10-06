/**
 * Stand-in model for designer tests. It speaks chat completions and never calls a live API.
 */

import { createServer, type Server } from "node:http";
import { addToolId, feedbackAskToolId, translateToolId } from "../src/contract.js";

export const GEAR_QUESTION = "How many teeth, and what diameter in millimetres?";
export const SPHERE_QUESTION = "What radius should the sphere have, in millimetres?";
export const designerModelPreference = "borg.openai:gpt-5-mini";

export function addedReply(kind: string): string {
  return `Added a ${kind}.`;
}

export function cylinderFromGearAnswer(answer: string): {
  readonly kind: "cylinder";
  readonly radiusMm: number;
  readonly heightMm: number;
} {
  const values = numbers(answer);
  const diameter = values.length >= 2 ? values[1] ?? 40 : values[0] ?? 40;
  return { kind: "cylinder", radiusMm: diameter / 2, heightMm: 8 };
}

interface ChatMessage {
  readonly role?: string;
  readonly content?: unknown;
  readonly tool_call_id?: string;
  readonly tool_calls?: readonly {
    readonly id?: string;
    readonly function?: { readonly name?: string; readonly arguments?: string };
  }[];
}

let callSequence = 0;

export function installDesignerFetch(): { readonly requests: unknown[]; restore(): void } {
  const requests: unknown[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.includes("/v1/chat/completions") && !url.includes("/v1/models/")) {
      return original(input, init);
    }
    if (url.includes("/v1/models/")) {
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const raw = typeof init?.body === "string" ? init.body : "{}";
    const body: unknown = JSON.parse(raw);
    requests.push(body);
    return sseResponse(framesFor(body));
  };
  return {
    requests,
    restore() {
      globalThis.fetch = original;
    },
  };
}

export function startDesignerServer(): Promise<{
  readonly url: string;
  close(): Promise<void>;
}> {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname.startsWith("/v1/models/")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
      return;
    }
    if (request.method !== "POST" || url.pathname !== "/v1/chat/completions") {
      response.writeHead(404);
      response.end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = parseJson(raw) ?? {};
      const payload = `${framesFor(body).join("\n\n")}\n\n`;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(payload);
    });
  });
  return listen(server);
}

function listen(server: Server): Promise<{ readonly url: string; close(): Promise<void> }> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Designer stand-in did not bind a port"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}/v1/chat/completions`,
        close: () =>
          new Promise((done, fail) => {
            server.close((error) => (error ? fail(error) : done()));
          }),
      });
    });
  });
}

function framesFor(body: unknown): string[] {
  const messages = readMessages(body);
  const line = userLine(messages);
  const last = messages.at(-1);
  if (last?.role === "tool") {
    const call = matchingCall(messages, last.tool_call_id);
    if (call?.function?.name === wire(feedbackAskToolId)) {
      return afterAnswer(line, answerText(last.content));
    }
    return afterEdit(call);
  }
  if (/\bcent(?:re|er) of the build plate\b/iu.test(line)) {
    return centreMove(userContent(messages));
  }
  return opening(line);
}

function opening(line: string): string[] {
  if (/\bgears?\b/iu.test(line)) {
    return ask(GEAR_QUESTION);
  }
  if (/\b(spheres?|balls?)\b/iu.test(line)) {
    const radius = numbers(line)[0];
    if (radius === undefined) {
      return ask(SPHERE_QUESTION);
    }
    return toolCall(addToolId, { solid: { kind: "sphere", radiusMm: radius } });
  }
  return ask("Name a solid and a size in millimetres.");
}

function afterAnswer(line: string, answer: string): string[] {
  if (/\bgears?\b/iu.test(line)) {
    return toolCall(addToolId, { solid: cylinderFromGearAnswer(answer) });
  }
  if (/\b(spheres?|balls?)\b/iu.test(line)) {
    const radius = numbers(answer)[0];
    if (radius === undefined) {
      return text("I still need a radius in millimetres.");
    }
    return toolCall(addToolId, { solid: { kind: "sphere", radiusMm: radius } });
  }
  return text("Name a solid and a size in millimetres.");
}

function afterEdit(
  call: { readonly function?: { readonly name?: string; readonly arguments?: string } } | undefined,
): string[] {
  const input = record(call?.function?.arguments);
  const solid = record(input?.solid);
  const kind = solid && typeof solid.kind === "string" ? solid.kind : "solid";
  if (call?.function?.name === wire(addToolId)) {
    return text(addedReply(kind));
  }
  if (call?.function?.name === wire(translateToolId)) {
    return text("Moved the whole object.");
  }
  return text("Updated the solid.");
}

function centreMove(content: string): string[] {
  const dxMm = labelled(content, "dxMm");
  const dyMm = labelled(content, "dyMm");
  const dzMm = labelled(content, "dzMm");
  if (dxMm === undefined || dyMm === undefined || dzMm === undefined) {
    return text("I need a delta.");
  }
  return toolCall(translateToolId, { dxMm, dyMm, dzMm });
}

function ask(prompt: string): string[] {
  return toolCall(feedbackAskToolId, { prompt, form: "text" });
}

function toolCall(name: string, input: unknown): string[] {
  callSequence += 1;
  return [
    frame({
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: `call-${callSequence}`,
                type: "function",
                function: { name: wire(name), arguments: JSON.stringify(input) },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    }),
    frame({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
    frame({
      choices: [],
      usage: { prompt_tokens: 11, completion_tokens: 7 },
    }),
    "data: [DONE]",
  ];
}

function text(content: string): string[] {
  return [
    frame({
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content },
          finish_reason: null,
        },
      ],
    }),
    frame({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
    frame({
      choices: [],
      usage: { prompt_tokens: 11, completion_tokens: 7 },
    }),
    "data: [DONE]",
  ];
}

function frame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}`;
}

function sseResponse(frames: readonly string[]): Response {
  return new Response(`${frames.join("\n\n")}\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function wire(toolId: string): string {
  return toolId.replaceAll(".", "_");
}

function readMessages(body: unknown): ChatMessage[] {
  if (!isRecord(body) || !Array.isArray(body.messages)) {
    return [];
  }
  return body.messages.filter(isRecord).map((message) => ({
    ...(typeof message.role === "string" ? { role: message.role } : {}),
    ...(message.content !== undefined ? { content: message.content } : {}),
    ...(typeof message.tool_call_id === "string" ? { tool_call_id: message.tool_call_id } : {}),
    ...(Array.isArray(message.tool_calls)
      ? {
          tool_calls: message.tool_calls.filter(isRecord).map((call) => ({
            ...(typeof call.id === "string" ? { id: call.id } : {}),
            ...(isRecord(call.function)
              ? {
                  function: {
                    ...(typeof call.function.name === "string" ? { name: call.function.name } : {}),
                    ...(typeof call.function.arguments === "string"
                      ? { arguments: call.function.arguments }
                      : {}),
                  },
                }
              : {}),
          })),
        }
      : {}),
  }));
}

function userLine(messages: readonly ChatMessage[]): string {
  return userContent(messages).split("\n")[0]?.trim() ?? "";
}

function userContent(messages: readonly ChatMessage[]): string {
  const user = messages.find((message) => message.role === "user" && typeof message.content === "string");
  return typeof user?.content === "string" ? user.content : "";
}

function labelled(text: string, label: string): number | undefined {
  const match = new RegExp(`${label} (-?\\d+(?:\\.\\d+)?)`, "u").exec(text);
  const raw = match?.[1];
  if (raw === undefined) {
    return undefined;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function matchingCall(messages: readonly ChatMessage[], toolCallId: string | undefined) {
  if (!toolCallId) {
    return undefined;
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const call = messages[index]?.tool_calls?.find((item) => item.id === toolCallId);
    if (call) {
      return call;
    }
  }
  return undefined;
}

function answerText(content: unknown): string {
  const raw = typeof content === "string" ? parseJson(content) : content;
  if (!isRecord(raw) || !isRecord(raw.answer) || typeof raw.answer.text !== "string") {
    return "";
  }
  return raw.answer.text;
}

function record(value: unknown): Record<string, unknown> | undefined {
  const raw = typeof value === "string" ? parseJson(value) : value;
  return isRecord(raw) ? raw : undefined;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function numbers(text: string): number[] {
  return [...text.matchAll(/\d+(?:\.\d+)?/gu)]
    .map((match) => Number(match[0]))
    .filter((value) => Number.isFinite(value) && value > 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
