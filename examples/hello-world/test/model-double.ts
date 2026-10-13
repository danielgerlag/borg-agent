/**
 * Stand-in model for hello world tests. It speaks chat completions and never calls a live API.
 */

import { feedbackAskToolId, readToolId, writeToolId } from "../src/contract.js";

export const FILE_QUESTION = "Which relative path, and what text should the file contain?";
export const helloWorldModelPreference = "borg.openai:gpt-5-mini";

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

export function installHelloWorldFetch(): { readonly requests: unknown[]; restore(): void } {
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

function framesFor(body: unknown): string[] {
  const messages = readMessages(body);
  const line = userLine(messages);
  const last = messages.at(-1);
  if (last?.role === "tool") {
    const call = matchingCall(messages, last.tool_call_id);
    const name = call?.function?.name;
    if (name === wire(feedbackAskToolId)) {
      return afterAnswer(answerText(last.content));
    }
    const payload = toolPayload(last.content);
    if (typeof payload?.error === "string") {
      return text(payload.error);
    }
    if (name === wire(readToolId)) {
      const content = typeof payload?.content === "string" ? payload.content : "";
      return toolCall(writeToolId, { path: "summary.txt", content: content.trim() });
    }
    if (name === wire(writeToolId)) {
      const written = typeof payload?.path === "string" ? payload.path : "the file";
      return text(`Wrote ${written}.`);
    }
    return text("Done.");
  }
  if (line.includes("../")) {
    return toolCall(readToolId, { path: "../secret.txt" });
  }
  if (line === "write a file") {
    return toolCall(feedbackAskToolId, { prompt: FILE_QUESTION, form: "text" });
  }
  if (line.includes("notes.txt")) {
    return toolCall(readToolId, { path: "notes.txt" });
  }
  return text("Name a file in this folder.");
}

function afterAnswer(answer: string): string[] {
  const splitAt = answer.indexOf(" | ");
  if (splitAt === -1) {
    return text("I need a path and the text.");
  }
  const path = answer.slice(0, splitAt);
  const content = answer.slice(splitAt + 3);
  if (path.length === 0) {
    return text("I need a path and the text.");
  }
  return toolCall(writeToolId, { path, content });
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
  const user = messages.find((message) => message.role === "user" && typeof message.content === "string");
  const content = user?.content;
  if (typeof content !== "string") {
    return "";
  }
  return content.split("\n")[0]?.trim() ?? "";
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

function toolPayload(content: unknown): Record<string, unknown> | undefined {
  const raw = typeof content === "string" ? parseJson(content) : content;
  return isRecord(raw) ? raw : undefined;
}

function parseJson(text: string): unknown {
  try {
    const value: unknown = JSON.parse(text);
    return value;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
