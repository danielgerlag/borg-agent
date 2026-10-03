import { randomUUID } from "node:crypto";
import {
  contractJsonValueSchema,
  type ContractJsonValue,
  type ModelCompletionRequest,
  type ModelCompletionResult,
  type ModelMessage,
  type ModelToolCall,
  type ModelUsage,
} from "@borg-agent/contracts";
import {
  z,
  type PluginContext,
  type ProviderDispatchPermit,
} from "@borg-agent/plugin-sdk";
import { designerModelId, designerProviderId } from "./contract.js";

export const designerModelUrl = "https://api.x.ai/v1/responses";
export const missingDesignerKeyMessage = "Set XAI_API_KEY to talk to the designer.";

const localUrlMessage = "The designer model URL must stay on this machine.";
const rejectedKeyMessage = "The designer rejected the API key.";
const unreachableMessage = "The designer model is unreachable.";
const unreadableMessage = "The designer returned an unreadable response.";
const unknownToolMessage = "The designer called an unknown tool.";
const timedOutMessage = "The designer model timed out.";
const busyMessage = "The designer is busy. Try again shortly.";
const rejectedMessage = "The designer rejected the request.";
const completionTimeoutMs = 60_000;

const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1"]);

const responseSchema = z
  .object({
    output: z.array(z.unknown()).optional(),
    output_text: z.string().optional(),
    usage: z
      .object({
        input_tokens: z.number().optional(),
        output_tokens: z.number().optional(),
      })
      .optional(),
  })
  .passthrough();

const functionCallSchema = z
  .object({
    name: z.string().min(1),
    arguments: z.unknown().optional(),
    call_id: z.string().min(1).optional(),
    id: z.string().min(1).optional(),
  })
  .passthrough();

const messageSchema = z
  .object({
    content: z
      .union([
        z.string(),
        z.array(z.object({ text: z.string().optional() }).passthrough()),
        z.null(),
      ])
      .optional(),
  })
  .passthrough();

export interface DesignerTurn {
  readonly request: ModelCompletionRequest;
  readonly permit: ProviderDispatchPermit;
  readonly signal: AbortSignal;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
  readonly onUsage?: ((usage: ModelUsage) => void | Promise<void>) | undefined;
}

export function wireToolName(id: string): string {
  return id.replaceAll(".", "_").replaceAll("-", "_");
}

export function designerModelEndpoint(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.BORG_PRINT_BENCH_MODEL_URL?.trim();
  if (!override) {
    return designerModelUrl;
  }
  let url: URL;
  try {
    url = new URL(override);
  } catch {
    throw new Error(localUrlMessage);
  }
  const host = url.hostname.replace(/^\[|\]$/gu, "").toLowerCase();
  const loopback = loopbackHosts.has(host) || /^127(?:\.\d{1,3}){3}$/u.test(host);
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !loopback) {
    throw new Error(localUrlMessage);
  }
  return url.toString();
}

export async function completeDesignerTurn(turn: DesignerTurn): Promise<ModelCompletionResult> {
  turn.signal.throwIfAborted();
  const env = turn.env ?? process.env;
  const endpoint = designerModelEndpoint(env);
  const apiKey = env.XAI_API_KEY?.trim() ?? "";
  if (apiKey.length === 0) {
    throw new Error(missingDesignerKeyMessage);
  }
  const aliases = aliasTools(turn.request.tools);
  const outbound = {
    model: turn.request.modelId,
    input: toInput(turn.request.messages),
    ...(turn.request.tools.length > 0 ? { tools: toTools(turn.request.tools) } : {}),
  };
  await turn.permit.commit();
  const result = await requestCompletion({
    endpoint,
    apiKey,
    outbound,
    signal: turn.signal,
    fetchImpl: turn.fetchImpl ?? globalThis.fetch,
    fromWire: aliases,
  });
  if (turn.onUsage) {
    await turn.onUsage(result.usage);
  }
  return result;
}

export function registerDesignerModel(context: PluginContext): { dispose(): void } {
  return context.models.registerProvider({
    id: designerProviderId,
    models: [designerModelId],
    // The registered destination stays on the public API. Tests may point the fetch at loopback.
    egress: {
      kind: "remote",
      capacity: "private",
      destination: designerModelUrl,
    },
    async complete(request, permit, signal, onRawToken, onUsage) {
      void onRawToken;
      return completeDesignerTurn({
        request,
        permit,
        signal,
        ...(onUsage ? { onUsage } : {}),
      });
    },
  });
}

function aliasTools(tools: ModelCompletionRequest["tools"]): Map<string, string> {
  const fromWire = new Map<string, string>();
  for (const tool of tools) {
    const wire = wireToolName(tool.id);
    const previous = fromWire.get(wire);
    if (previous !== undefined && previous !== tool.id) {
      throw new Error("The designer tool names collide.");
    }
    fromWire.set(wire, tool.id);
  }
  return fromWire;
}

function toTools(tools: ModelCompletionRequest["tools"]): ContractJsonValue[] {
  return tools.map((tool) => ({
    type: "function",
    name: wireToolName(tool.id),
    description: tool.description,
    parameters: parametersOf(tool.inputSchema),
  }));
}

function parametersOf(schema: ContractJsonValue): { readonly [key: string]: ContractJsonValue } {
  if (!isJsonObject(schema)) {
    throw new Error("The designer tool schema is not an object.");
  }
  const parameters: { [key: string]: ContractJsonValue } = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key !== "$schema" && value !== undefined) {
      parameters[key] = value;
    }
  }
  return parameters;
}

function isJsonObject(
  value: ContractJsonValue,
): value is { readonly [key: string]: ContractJsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toInput(messages: readonly ModelMessage[]): ContractJsonValue[] {
  const items: ContractJsonValue[] = [];
  for (const message of messages) {
    if (message.role === "system" || message.role === "user") {
      items.push({ role: message.role, content: message.content });
    } else if (message.role === "assistant") {
      if (message.content.length > 0) {
        items.push({ role: "assistant", content: message.content });
      }
      for (const call of message.toolCalls ?? []) {
        items.push({
          type: "function_call",
          call_id: call.id,
          name: wireToolName(call.name),
          arguments: JSON.stringify(call.input),
        });
      }
    } else if (message.role === "tool") {
      if (!message.toolCallId) {
        throw new Error("The designer history is missing a tool call id.");
      }
      items.push({
        type: "function_call_output",
        call_id: message.toolCallId,
        output: message.content,
      });
    } else {
      const unexpected: never = message.role;
      throw new Error(`Unexpected designer message role ${unexpected}`);
    }
  }
  return items;
}

async function requestCompletion(input: {
  readonly endpoint: string;
  readonly apiKey: string;
  readonly outbound: ContractJsonValue;
  readonly signal: AbortSignal;
  readonly fetchImpl: typeof fetch;
  readonly fromWire: ReadonlyMap<string, string>;
}): Promise<ModelCompletionResult> {
  let response: Response;
  try {
    response = await input.fetchImpl(input.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input.outbound),
      redirect: "error",
      signal: AbortSignal.any([input.signal, AbortSignal.timeout(completionTimeoutMs)]),
    });
  } catch (error) {
    input.signal.throwIfAborted();
    return failed(timeoutError(error) ? timedOutMessage : unreachableMessage);
  }
  input.signal.throwIfAborted();
  if (!response.ok) {
    if (response.status === 400) {
      const detail = await errorDetail(response);
      return failed(detail.length > 0 ? `${rejectedMessage} ${detail}` : rejectedMessage);
    }
    await discard(response);
    return failed(statusMessage(response.status));
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return failed(unreadableMessage);
  }
  return parseCompletion(payload, input.fromWire);
}

function parseCompletion(
  payload: unknown,
  fromWire: ReadonlyMap<string, string>,
): ModelCompletionResult {
  const parsed = responseSchema.safeParse(payload);
  if (!parsed.success) {
    return failed(unreadableMessage);
  }
  const texts: string[] = [];
  const toolCalls: ModelToolCall[] = [];
  for (const item of parsed.data.output ?? []) {
    const type = readType(item);
    if (type === "function_call") {
      const call = readFunctionCall(item, fromWire);
      if ("message" in call) {
        return failed(call.message);
      }
      toolCalls.push(call);
      continue;
    }
    if (type !== "message") {
      continue;
    }
    const message = messageSchema.safeParse(item);
    if (!message.success) {
      return failed(unreadableMessage);
    }
    const text = messageText(message.data.content);
    if (text.length > 0) {
      texts.push(text);
    }
  }
  const text = texts.join("\n").trim() || (parsed.data.output_text ?? "").trim();
  const usage = {
    inputTokens: whole(parsed.data.usage?.input_tokens),
    outputTokens: whole(parsed.data.usage?.output_tokens),
  };
  if (toolCalls.length > 0 && text.length > 0) {
    return { content: text, toolCalls, usage };
  }
  if (toolCalls.length > 0) {
    return { toolCalls, usage };
  }
  if (text.length > 0) {
    return { content: text, usage };
  }
  return failed(unreadableMessage);
}

function readFunctionCall(
  item: unknown,
  fromWire: ReadonlyMap<string, string>,
): ModelToolCall | { readonly message: string } {
  const parsed = functionCallSchema.safeParse(item);
  if (!parsed.success) {
    return { message: unreadableMessage };
  }
  const name = fromWire.get(parsed.data.name);
  if (!name) {
    return { message: unknownToolMessage };
  }
  const input = parseArguments(parsed.data.arguments);
  if (!input) {
    return { message: unreadableMessage };
  }
  return {
    id: parsed.data.call_id ?? parsed.data.id ?? randomUUID(),
    name,
    input,
  };
}

function parseArguments(value: unknown): ContractJsonValue | undefined {
  try {
    const raw: unknown = typeof value === "string" ? JSON.parse(value) : value;
    const parsed = contractJsonValueSchema.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function messageText(
  content: string | readonly { readonly text?: string | undefined }[] | null | undefined,
): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (!content) {
    return "";
  }
  return content.map((part) => part.text ?? "").join("").trim();
}

function readType(item: unknown): string | undefined {
  if (typeof item !== "object" || item === null || !("type" in item)) {
    return undefined;
  }
  return typeof item.type === "string" ? item.type : undefined;
}

function statusMessage(status: number): string {
  if (status === 401 || status === 403) {
    return rejectedKeyMessage;
  }
  if (status === 429) {
    return busyMessage;
  }
  if (status === 408) {
    return timedOutMessage;
  }
  if (status >= 500) {
    return unreachableMessage;
  }
  return rejectedMessage;
}

function timeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

function failed(message: string): ModelCompletionResult {
  return {
    content: message,
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

function whole(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.floor(value);
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    return;
  }
}

async function errorDetail(response: Response): Promise<string> {
  try {
    const text = (await response.text()).replace(/\s+/gu, " ").trim();
    const parsed: unknown = text.startsWith("{") ? JSON.parse(text) : undefined;
    const message = errorMessage(parsed) || text;
    return message.slice(0, 240);
  } catch {
    return "";
  }
}

function errorMessage(value: unknown): string {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return "";
  }
  if ("message" in value && typeof value.message === "string") {
    return value.message;
  }
  if (
    "error" in value &&
    typeof value.error === "object" &&
    value.error !== null &&
    "message" in value.error &&
    typeof value.error.message === "string"
  ) {
    return value.error.message;
  }
  return "";
}
