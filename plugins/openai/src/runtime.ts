import {
  z,
  type JsonValue,
  type LlmProviderContribution,
  type ModelCompletionRequest,
  type ModelCompletionResult,
  type ModelMessage,
  type ModelToolCall,
  type ProviderDispatchPermit,
  type ProviderEgress,
} from "@borg/plugin-sdk";

export const OPENAI_PROVIDER_ID = "borg.openai";
export const OPENAI_SECRET_KEY = "apiKey";

export const OPENAI_PRODUCTION_ENDPOINT =
  "https://api.openai.com/v1/chat/completions";

export const OPENAI_TIMEOUT_MS = 60_000;

/** GPT-5 rejects `max_tokens`; send this Chat Completions cap instead. */
export const OPENAI_MAX_COMPLETION_TOKENS = 8_192;

export const OPENAI_TOOL_NAME_MAX = 64;
export const OPENAI_DEFAULT_MODEL = "gpt-5-mini";

export const OPENAI_MODELS = [
  "gpt-5-mini",
  "gpt-5-nano",
  "gpt-5",
] as const;

export type OpenAIModelId = (typeof OPENAI_MODELS)[number];

export interface OpenAIModelRates {
  readonly input: number;
  readonly cacheWrite: number;
  readonly cacheHit: number;
  readonly output: number;
}

export const OPENAI_PRICING = Object.freeze({
  "gpt-5-mini": Object.freeze({
    input: 0.25,
    cacheWrite: 0.25,
    cacheHit: 0.025,
    output: 2,
  }),
  "gpt-5-nano": Object.freeze({
    input: 0.05,
    cacheWrite: 0.05,
    cacheHit: 0.005,
    output: 0.4,
  }),
  "gpt-5": Object.freeze({
    input: 1.25,
    cacheWrite: 1.25,
    cacheHit: 0.125,
    output: 10,
  }),
}) satisfies Record<OpenAIModelId, OpenAIModelRates>;

export const OPENAI_EGRESS = Object.freeze({
  kind: "remote",
  capacity: "internal",
  destination: OPENAI_PRODUCTION_ENDPOINT,
} satisfies ProviderEgress);

export const SAFE_OPENAI_ERRORS = Object.freeze({
  cancelled: "The OpenAI request was cancelled.",
  timeout: "The OpenAI request timed out.",
  missingKey: "OpenAI is not connected. Add an API key in Settings.",
  rejectedKey: "OpenAI rejected the API key. Replace it in Settings.",
  rateLimited: "OpenAI rate-limited the request. Try again shortly.",
  unavailable: "OpenAI is temporarily unavailable. Try again shortly.",
  rejected: "OpenAI rejected the request.",
  protocol: "OpenAI returned an unreadable response.",
  unknownTool: "OpenAI returned an unknown tool.",
  invalidEndpoint: "OpenAI endpoint override is not allowed.",
});

const SAFE_OPENAI_ERROR_MESSAGES: ReadonlySet<string> = new Set(
  Object.values(SAFE_OPENAI_ERRORS),
);

const OPENAI_TOOL_NAME = /^[A-Za-z0-9_-]+$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export interface OpenAIUsageParts {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheWriteTokens: number;
}

export function isOpenAIModelId(value: string): value is OpenAIModelId {
  return Object.hasOwn(OPENAI_PRICING, value);
}

export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return LOOPBACK_HOSTS.has(host) || /^127(?:\.\d{1,3}){3}$/.test(host);
}

export function resolveOpenAIEndpoint(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.BORG_OPENAI_ENDPOINT?.trim();
  if (!override) {
    return OPENAI_PRODUCTION_ENDPOINT;
  }
  if (env.BORG_E2E !== "1") {
    throw new Error(SAFE_OPENAI_ERRORS.invalidEndpoint);
  }
  let parsed: URL;
  try {
    parsed = new URL(override);
  } catch {
    throw new Error(SAFE_OPENAI_ERRORS.invalidEndpoint);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(SAFE_OPENAI_ERRORS.invalidEndpoint);
  }
  if (!isLoopbackHostname(parsed.hostname)) {
    throw new Error(SAFE_OPENAI_ERRORS.invalidEndpoint);
  }
  return parsed.toString();
}

export function resolveOpenAIModelEndpoint(
  completionsEndpoint: string,
  modelId: OpenAIModelId = OPENAI_DEFAULT_MODEL,
): string {
  let parsed: URL;
  try {
    parsed = new URL(completionsEndpoint);
  } catch {
    throw new Error(SAFE_OPENAI_ERRORS.invalidEndpoint);
  }
  if (!/\/v1\/chat\/completions\/?$/.test(parsed.pathname)) {
    throw new Error(SAFE_OPENAI_ERRORS.invalidEndpoint);
  }
  parsed.pathname = parsed.pathname.replace(
    /\/chat\/completions\/?$/,
    `/models/${modelId}`,
  );
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

export function normalizeOpenAIUsage(candidate: unknown): OpenAIUsageParts {
  const value = asObject(candidate) ?? {};
  const inputTokens = asNonnegativeInteger(value.prompt_tokens);
  const outputTokens = asNonnegativeInteger(value.completion_tokens);
  const details = asObject(value.prompt_tokens_details) ?? {};
  let cachedInputTokens = asNonnegativeInteger(details.cached_tokens);
  let cacheWriteTokens = asNonnegativeInteger(details.cache_write_tokens);
  if (cachedInputTokens + cacheWriteTokens > inputTokens) {
    cacheWriteTokens = Math.min(
      cacheWriteTokens,
      Math.max(0, inputTokens - cachedInputTokens),
    );
    cachedInputTokens = Math.min(cachedInputTokens, inputTokens);
  }
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    cacheWriteTokens,
  };
}

export function priceOpenAIUsage(
  modelId: string,
  usage: OpenAIUsageParts,
): { readonly amount: number; readonly currency: "USD" } {
  const rates = isOpenAIModelId(modelId)
    ? OPENAI_PRICING[modelId]
    : OPENAI_PRICING[OPENAI_DEFAULT_MODEL];
  const billedInput = Math.max(
    0,
    usage.inputTokens - usage.cachedInputTokens - usage.cacheWriteTokens,
  );
  const amount =
    (billedInput * rates.input +
      usage.cachedInputTokens * rates.cacheHit +
      usage.cacheWriteTokens * rates.cacheWrite +
      usage.outputTokens * rates.output) /
    1_000_000;
  return {
    amount: Number(amount.toFixed(8)),
    currency: "USD",
  };
}

export class OpenAIToolMap {
  readonly #toWire = new Map<string, string>();
  readonly #fromWire = new Map<string, string>();

  alias(borgId: string): string {
    const existing = this.#toWire.get(borgId);
    if (existing) {
      return existing;
    }
    if (borgId.includes("_")) {
      throw new Error(SAFE_OPENAI_ERRORS.unknownTool);
    }
    const wire = borgId.replaceAll(".", "_");
    if (
      wire.length === 0 ||
      wire.length > OPENAI_TOOL_NAME_MAX ||
      !OPENAI_TOOL_NAME.test(wire)
    ) {
      throw new Error(SAFE_OPENAI_ERRORS.unknownTool);
    }
    this.#toWire.set(borgId, wire);
    this.#fromWire.set(wire, borgId);
    return wire;
  }

  resolve(wireName: string): string {
    const borgId = this.#fromWire.get(wireName);
    if (!borgId) {
      throw new Error(SAFE_OPENAI_ERRORS.unknownTool);
    }
    return borgId;
  }
}

export function buildOpenAIRequest(
  request: ModelCompletionRequest,
  tools: OpenAIToolMap,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.modelId,
    max_completion_tokens: OPENAI_MAX_COMPLETION_TOKENS,
    stream: true,
    stream_options: { include_usage: true },
    messages: request.messages.map((message) => convertMessage(message, tools)),
  };

  if (request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({
      type: "function",
      function: {
        name: tools.alias(tool.id),
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
  }

  return body;
}

function convertMessage(
  message: ModelMessage,
  tools: OpenAIToolMap,
): Record<string, unknown> {
  if (message.role === "assistant") {
    const toolCalls = message.toolCalls ?? [];
    const converted: Record<string, unknown> = {
      role: "assistant",
      content: message.content.trim().length > 0 ? message.content : null,
    };
    if (toolCalls.length > 0) {
      converted.tool_calls = toolCalls.map((toolCall) => ({
        id: toolCall.id,
        type: "function",
        function: {
          name: tools.alias(toolCall.name),
          arguments: JSON.stringify(toolCall.input ?? {}),
        },
      }));
    }
    return converted;
  }

  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId ?? "",
      content: message.content,
    };
  }

  return {
    role: message.role,
    content: message.content,
  };
}

export function classifyOpenAIStatus(status: number): string {
  if (status === 401 || status === 403) {
    return SAFE_OPENAI_ERRORS.rejectedKey;
  }
  if (status === 429) {
    return SAFE_OPENAI_ERRORS.rateLimited;
  }
  if (status === 400) {
    return SAFE_OPENAI_ERRORS.rejected;
  }
  if (status === 529 || status >= 500) {
    return SAFE_OPENAI_ERRORS.unavailable;
  }
  return SAFE_OPENAI_ERRORS.rejected;
}

export function openaiErrorFromUnknown(error: unknown): Error {
  if (isAbortError(error)) {
    return new Error(SAFE_OPENAI_ERRORS.cancelled);
  }
  if (error instanceof Error) {
    if (SAFE_OPENAI_ERROR_MESSAGES.has(error.message)) {
      return error;
    }
    if (/timeout/i.test(error.message)) {
      return new Error(SAFE_OPENAI_ERRORS.timeout);
    }
  }
  return new Error(SAFE_OPENAI_ERRORS.protocol);
}

export interface OpenAIProviderOptions {
  readonly fetchImpl?: typeof fetch;
  readonly endpoint?: string;
  readonly timeoutMs?: number;
  getApiKey(): Promise<string | undefined>;
}

interface ToolCallState {
  id: string;
  name: string;
  json: string;
}

export class OpenAIProvider implements LlmProviderContribution {
  readonly id = OPENAI_PROVIDER_ID;
  readonly models = OPENAI_MODELS;
  readonly egress = OPENAI_EGRESS;
  readonly #fetch: typeof fetch;
  readonly #endpoint: string;
  readonly #timeoutMs: number;
  readonly #getApiKey: () => Promise<string | undefined>;

  constructor(options: OpenAIProviderOptions) {
    this.#fetch = options.fetchImpl ?? fetch;
    this.#endpoint = options.endpoint ?? resolveOpenAIEndpoint();
    this.#timeoutMs = options.timeoutMs ?? OPENAI_TIMEOUT_MS;
    this.#getApiKey = options.getApiKey;
  }

  async verify(signal?: AbortSignal): Promise<void> {
    const { response } = await this.#authenticatedFetch(
      resolveOpenAIModelEndpoint(this.#endpoint, OPENAI_DEFAULT_MODEL),
      { method: "GET" },
      signal ?? new AbortController().signal,
    );
    if (!response.ok) {
      await discardBody(response);
      throw new Error(classifyOpenAIStatus(response.status));
    }
    await discardBody(response);
  }

  async complete(
    request: ModelCompletionRequest,
    permit: ProviderDispatchPermit,
    signal: AbortSignal,
    onToken?: ((token: string) => void | Promise<void>) | undefined,
    onUsage?:
      | ((usage: ModelCompletionResult["usage"]) => void | Promise<void>)
      | undefined,
  ): Promise<ModelCompletionResult> {
    const tools = new OpenAIToolMap();
    const body = buildOpenAIRequest(request, tools);
    const { response, timeout, combined } = await this.#authenticatedFetch(
      this.#endpoint,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      },
      signal,
      permit,
    );

    if (!response.ok) {
      await discardBody(response);
      throw new Error(classifyOpenAIStatus(response.status));
    }
    if (!response.body) {
      throw new Error(SAFE_OPENAI_ERRORS.protocol);
    }

    try {
      return await readOpenAIStream(
        response.body,
        tools,
        request.modelId,
        combined,
        onToken,
        onUsage,
      );
    } catch (error) {
      if (timeout.aborted && !signal.aborted) {
        throw new Error(SAFE_OPENAI_ERRORS.timeout);
      }
      throw openaiErrorFromUnknown(error);
    }
  }

  async #authenticatedFetch(
    url: string,
    init: RequestInit,
    signal: AbortSignal,
    permit?: ProviderDispatchPermit,
  ): Promise<{
    readonly response: Response;
    readonly timeout: AbortSignal;
    readonly combined: AbortSignal;
  }> {
    const throwIfCancelled = (candidate: AbortSignal): void => {
      if (candidate.aborted) {
        throw new Error(SAFE_OPENAI_ERRORS.cancelled);
      }
    };
    throwIfCancelled(signal);
    const apiKey = await this.#getApiKey();
    throwIfCancelled(signal);
    if (!apiKey) {
      throw new Error(SAFE_OPENAI_ERRORS.missingKey);
    }

    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const combined = AbortSignal.any([signal, timeout]);
    throwIfCancelled(combined);
    await permit?.commit();

    try {
      const response = await this.#fetch(url, {
        ...init,
        headers: {
          ...init.headers,
          Authorization: `Bearer ${apiKey}`,
        },
        redirect: "error",
        signal: combined,
      });
      return { response, timeout, combined };
    } catch (error) {
      if (timeout.aborted && !signal.aborted) {
        throw new Error(SAFE_OPENAI_ERRORS.timeout);
      }
      throw openaiErrorFromUnknown(error);
    }
  }
}

interface SseFrame {
  readonly event: string;
  readonly data: string;
}

async function readOpenAIStream(
  body: ReadableStream<Uint8Array>,
  tools: OpenAIToolMap,
  modelId: string,
  signal: AbortSignal,
  onToken?: ((token: string) => void | Promise<void>) | undefined,
  onUsage?:
    | ((usage: ModelCompletionResult["usage"]) => void | Promise<void>)
    | undefined,
): Promise<ModelCompletionResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let usageParts: OpenAIUsageParts = {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
  };
  const toolBlocks = new Map<number, ToolCallState>();
  const finishedTools: ModelToolCall[] = [];
  let completed = false;

  const publishUsage = async (): Promise<void> => {
    if (!onUsage) {
      return;
    }
    const priced = priceOpenAIUsage(modelId, usageParts);
    await onUsage({
      inputTokens: usageParts.inputTokens,
      outputTokens: usageParts.outputTokens,
      cachedInputTokens: usageParts.cachedInputTokens,
      cacheWriteTokens: usageParts.cacheWriteTokens,
      amount: priced.amount,
      currency: priced.currency,
    });
  };

  const finishTools = (): void => {
    const indexes = [...toolBlocks.keys()].sort((left, right) => left - right);
    for (const index of indexes) {
      const block = toolBlocks.get(index);
      if (!block || block.id.length === 0 || block.name.length === 0) {
        throw new Error(SAFE_OPENAI_ERRORS.protocol);
      }
      finishedTools.push({
        id: block.id,
        name: block.name,
        input: parseToolInput(block.json),
      });
    }
    toolBlocks.clear();
  };

  try {
    while (!completed) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        await parseSseFrames(buffer, handleEvent);
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const frames = splitSseBuffer(buffer);
      buffer = frames.rest;
      for (const frame of frames.frames) {
        await handleEvent(frame);
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (!completed) {
    throw new Error(SAFE_OPENAI_ERRORS.protocol);
  }

  const priced = priceOpenAIUsage(modelId, usageParts);
  return {
    ...(text.length > 0 ? { content: text } : {}),
    ...(finishedTools.length > 0 ? { toolCalls: finishedTools } : {}),
    usage: {
      inputTokens: usageParts.inputTokens,
      outputTokens: usageParts.outputTokens,
      cachedInputTokens: usageParts.cachedInputTokens,
      cacheWriteTokens: usageParts.cacheWriteTokens,
      amount: priced.amount,
      currency: priced.currency,
    },
  };

  async function handleEvent(frame: SseFrame): Promise<void> {
    if (frame.data === "[DONE]") {
      finishTools();
      completed = true;
      return;
    }

    let payload: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(frame.data);
      const object = asObject(parsed);
      if (!object) {
        throw new Error(SAFE_OPENAI_ERRORS.protocol);
      }
      payload = object;
    } catch {
      throw new Error(SAFE_OPENAI_ERRORS.protocol);
    }

    if (payload.error !== undefined && payload.error !== null) {
      throw new Error(SAFE_OPENAI_ERRORS.protocol);
    }

    if (payload.usage !== undefined && payload.usage !== null) {
      usageParts = normalizeOpenAIUsage(payload.usage);
      await publishUsage();
    }

    const choices = Array.isArray(payload.choices) ? payload.choices : [];
    const choice = asObject(choices[0]);
    if (!choice) {
      return;
    }
    if (choice.finish_reason === "content_filter") {
      throw new Error(SAFE_OPENAI_ERRORS.rejected);
    }

    const delta = asObject(choice.delta) ?? {};
    if (typeof delta.content === "string" && delta.content.length > 0) {
      text += delta.content;
      if (onToken) {
        await onToken(delta.content);
      }
    }
    if (typeof delta.refusal === "string" && delta.refusal.length > 0) {
      text += delta.refusal;
      if (onToken) {
        await onToken(delta.refusal);
      }
    }

    const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
    for (const item of toolCalls) {
      const call = asObject(item);
      if (!call) {
        continue;
      }
      const index = asIndex(call.index);
      if (index < 0) {
        throw new Error(SAFE_OPENAI_ERRORS.protocol);
      }
      let state = toolBlocks.get(index);
      if (!state) {
        state = { id: "", name: "", json: "" };
        toolBlocks.set(index, state);
      }
      if (typeof call.id === "string" && call.id.length > 0) {
        state.id = call.id;
      }
      const fn = asObject(call.function) ?? {};
      if (typeof fn.name === "string" && fn.name.length > 0) {
        state.name = tools.resolve(fn.name);
      }
      if (typeof fn.arguments === "string") {
        state.json += fn.arguments;
      }
    }
  }
}

function splitSseBuffer(buffer: string): {
  readonly frames: readonly SseFrame[];
  readonly rest: string;
} {
  const frames: SseFrame[] = [];
  let rest = buffer;
  while (true) {
    const separator = rest.search(/\r?\n\r?\n/);
    if (separator < 0) {
      break;
    }
    const raw = rest.slice(0, separator);
    const match = rest.slice(separator).match(/^\r?\n\r?\n/);
    rest = rest.slice(separator + (match?.[0].length ?? 2));
    const frame = parseSseFrame(raw);
    if (frame) {
      frames.push(frame);
    }
  }
  return { frames, rest };
}

async function parseSseFrames(
  buffer: string,
  handle: (frame: SseFrame) => void | Promise<void>,
): Promise<void> {
  const { frames, rest } = splitSseBuffer(`${buffer}\n\n`);
  if (rest.trim().length > 0 && frames.length === 0) {
    throw new Error(SAFE_OPENAI_ERRORS.protocol);
  }
  for (const frame of frames) {
    await handle(frame);
  }
}

function parseSseFrame(raw: string): SseFrame | undefined {
  let event = "message";
  const data: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      data.push(line.slice(5).trimStart());
    }
  }
  if (data.length === 0) {
    return undefined;
  }
  return { event, data: data.join("\n") };
}

function parseToolInput(json: string): JsonValue {
  if (json.trim().length === 0) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(json);
    return z.json().parse(parsed);
  } catch {
    throw new Error(SAFE_OPENAI_ERRORS.protocol);
  }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function asNonnegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : 0;
}

function asIndex(value: unknown): number {
  if (value === undefined) {
    return 0;
  }
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : -1;
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === "AbortError") ||
    (error instanceof DOMException && error.name === "AbortError")
  );
}

async function discardBody(response: Response): Promise<void> {
  await response.arrayBuffer().catch(() => undefined);
}
