import { createServer, type Server } from "node:http";
import { addToolId, deleteToolId, designerModelId, feedbackAskToolId, placeToolId } from "../src/contract.js";
import { wireToolName } from "../src/provider.js";

export const GEAR_QUESTION = "How many teeth, and what diameter in millimetres?";
export const SPHERE_QUESTION = "What radius should the sphere have, in millimetres?";

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

interface DesignerResponse {
  readonly output: readonly Record<string, unknown>[];
  readonly usage: { readonly input_tokens: number; readonly output_tokens: number };
}

interface WireItem {
  readonly role?: string;
  readonly content?: unknown;
  readonly type?: string;
  readonly name?: string;
  readonly arguments?: unknown;
  readonly call_id?: string;
  readonly output?: unknown;
}

let callSequence = 0;

export function designerDouble(body: unknown): DesignerResponse {
  const items = readItems(body);
  const line = userLine(items);
  const last = items.at(-1);
  if (last?.type === "function_call_output") {
    const call = matchingCall(items, last);
    if (!call) {
      return text("I could not read the tool result.");
    }
    if (call.name === wireToolName(feedbackAskToolId)) {
      return afterAnswer(line, answerText(last.output));
    }
    return afterEdit(call);
  }
  return opening(line);
}

export function installDesignerFetch(): { readonly requests: unknown[]; restore(): void } {
  const requests: unknown[] = [];
  const original = globalThis.fetch;
  const previousKey = process.env.XAI_API_KEY;
  const previousUrl = process.env.BORG_PRINT_BENCH_MODEL_URL;
  process.env.XAI_API_KEY = "test-key";
  delete process.env.BORG_PRINT_BENCH_MODEL_URL;
  globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith("https://api.x.ai/")) {
      return original(input, init);
    }
    const raw = typeof init?.body === "string" ? init.body : "{}";
    const body: unknown = JSON.parse(raw);
    requests.push(body);
    return Response.json(designerDouble(body));
  };
  return {
    requests,
    restore() {
      globalThis.fetch = original;
      restoreEnv("XAI_API_KEY", previousKey);
      restoreEnv("BORG_PRINT_BENCH_MODEL_URL", previousUrl);
    },
  };
}

export function startDesignerServer(): Promise<{
  readonly url: string;
  readonly requests: unknown[];
  failure(): unknown;
  close(): Promise<void>;
}> {
  const requests: unknown[] = [];
  let lastError: unknown;
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer | string) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    });
    request.on("end", () => {
      try {
        const raw: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        requests.push(raw);
        const payload = designerDouble(raw);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(payload));
      } catch (error) {
        lastError = error;
        response.writeHead(500);
        response.end();
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Designer stand-in did not bind a port"));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}/responses`,
        requests,
        failure: () => lastError,
        close: () =>
          new Promise((done, fail) => {
            server.close((error) => (error ? fail(error) : done()));
          }),
      });
    });
  });
}

function opening(line: string): DesignerResponse {
  if (/\bgears?\b/iu.test(line)) {
    return ask(GEAR_QUESTION);
  }
  if (/\b(spheres?|balls?)\b/iu.test(line)) {
    const radius = numbers(line)[0];
    if (radius === undefined) {
      return ask(SPHERE_QUESTION);
    }
    return functionCall(addToolId, { kind: "sphere", radiusMm: radius });
  }
  return ask("Name a solid and a size in millimetres.");
}

function afterAnswer(line: string, answer: string): DesignerResponse {
  if (/\bgears?\b/iu.test(line)) {
    return functionCall(addToolId, cylinderFromGearAnswer(answer));
  }
  if (/\b(spheres?|balls?)\b/iu.test(line)) {
    const radius = numbers(answer)[0];
    if (radius === undefined) {
      return text("I still need a radius in millimetres.");
    }
    return functionCall(addToolId, { kind: "sphere", radiusMm: radius });
  }
  return text("Name a solid and a size in millimetres.");
}

function afterEdit(call: WireItem): DesignerResponse {
  const input = record(call.arguments);
  const kind = input && typeof input.kind === "string" ? input.kind : "solid";
  if (call.name === wireToolName(addToolId)) {
    return text(addedReply(kind));
  }
  if (call.name === wireToolName(deleteToolId)) {
    return text("Removed the solid.");
  }
  if (call.name === wireToolName(placeToolId)) {
    return text("Placed the solids.");
  }
  return text("Updated the solid.");
}

function ask(prompt: string): DesignerResponse {
  return functionCall(feedbackAskToolId, { title: "Designer", prompt, form: "text" });
}

function functionCall(name: string, input: unknown): DesignerResponse {
  callSequence += 1;
  return {
    output: [
      {
        type: "function_call",
        name: wireToolName(name),
        call_id: `call-${callSequence}`,
        arguments: JSON.stringify(input),
      },
    ],
    usage: { input_tokens: 11, output_tokens: 7 },
  };
}

function text(content: string): DesignerResponse {
  return {
    output: [
      {
        type: "message",
        content: [{ type: "output_text", text: content }],
      },
    ],
    usage: { input_tokens: 11, output_tokens: 7 },
  };
}

function readItems(body: unknown): WireItem[] {
  if (!isRecord(body) || body.model !== designerModelId || !Array.isArray(body.input)) {
    throw new Error("Designer stand-in expected a grok-4.7 responses body");
  }
  return body.input.filter(isRecord).map((item) => ({
    ...(typeof item.role === "string" ? { role: item.role } : {}),
    ...(item.content !== undefined ? { content: item.content } : {}),
    ...(typeof item.type === "string" ? { type: item.type } : {}),
    ...(typeof item.name === "string" ? { name: item.name } : {}),
    ...(item.arguments !== undefined ? { arguments: item.arguments } : {}),
    ...(typeof item.call_id === "string" ? { call_id: item.call_id } : {}),
    ...(item.output !== undefined ? { output: item.output } : {}),
  }));
}

function userLine(items: readonly WireItem[]): string {
  const user = items.find((item) => item.role === "user" && typeof item.content === "string");
  const content = typeof user?.content === "string" ? user.content : "";
  return content.split("\n")[0]?.trim() ?? "";
}

function matchingCall(items: readonly WireItem[], output: WireItem): WireItem | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item?.type === "function_call" && item.call_id === output.call_id) {
      return item;
    }
  }
  return undefined;
}

function answerText(output: unknown): string {
  const raw = typeof output === "string" ? parseJson(output) : output;
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
    const value: unknown = JSON.parse(text);
    return value;
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

function restoreEnv(name: "XAI_API_KEY" | "BORG_PRINT_BENCH_MODEL_URL", previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = previous;
}
