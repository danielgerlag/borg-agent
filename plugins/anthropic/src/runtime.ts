import type {
  LlmProviderContribution,
  ModelCompletionRequest,
  ModelCompletionResult,
  ModelMessage,
  ModelToolCall,
} from "@borg/plugin-sdk";

export const ANTHROPIC_PROVIDER_ID = "borg.anthropic";
export const ANTHROPIC_SECRET_KEY = "apiKey";
export const ANTHROPIC_PRODUCTION_ENDPOINT =
  "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_VERSION = "2023-06-01";
export const ANTHROPIC_TIMEOUT_MS = 60_000;
export const ANTHROPIC_MAX_TOKENS = 8_192;
export const ANTHROPIC_TOOL_NAME_MAX = 128;
export const ANTHROPIC_DEFAULT_MODEL = "claude-sonnet-5";

export const ANTHROPIC_MODELS = [
  "claude-sonnet-5",
  "claude-haiku-4-5",
  "claude-opus-5",
] as const;

export type AnthropicModelId = (typeof ANTHROPIC_MODELS)[number];

export interface AnthropicModelRates {
  readonly input: number;
  readonly cacheWrite: number;
  readonly cacheHit: number;
  readonly output: number;
}

export const ANTHROPIC_PRICING = Object.freeze({
  "claude-sonnet-5": Object.freeze({
    input: 2,
    cacheWrite: 2.5,
    cacheHit: 0.2,
    output: 10,
  }),
  "claude-haiku-4-5": Object.freeze({
    input: 1,
    cacheWrite: 1.25,
    cacheHit: 0.1,
    output: 5,
  }),
  "claude-opus-5": Object.freeze({
    input: 5,
    cacheWrite: 6.25,
    cacheHit: 0.5,
    output: 25,
  }),
}) satisfies Record<AnthropicModelId, AnthropicModelRates>;

export const SAFE_ANTHROPIC_ERRORS = Object.freeze({
  cancelled: "The Anthropic request was cancelled.",
  timeout: "The Anthropic request timed out.",
  missingKey: "Anthropic is not connected. Add an API key in Settings.",
  rejectedKey: "Anthropic rejected the API key. Replace it in Settings.",
  rateLimited: "Anthropic rate-limited the request. Try again shortly.",
  unavailable: "Anthropic is temporarily unavailable. Try again shortly.",
  rejected: "Anthropic rejected the request.",
  protocol: "Anthropic returned an unreadable response.",
  unknownTool: "Anthropic returned an unknown tool.",
  invalidEndpoint: "Anthropic endpoint override is not allowed.",
});

const ANTHROPIC_TOOL_NAME = /^[A-Za-z0-9_-]+$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export interface AnthropicUsageParts {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheWriteTokens: number;
}

export function isAnthropicModelId(value: string): value is AnthropicModelId {
  return Object.hasOwn(ANTHROPIC_PRICING, value);
}

export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return LOOPBACK_HOSTS.has(host);
}

export function resolveAnthropicEndpoint(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.BORG_ANTHROPIC_ENDPOINT?.trim();
  if (!override) {
    return ANTHROPIC_PRODUCTION_ENDPOINT;
  }
  if (env.BORG_E2E !== "1") {
    throw new Error(SAFE_ANTHROPIC_ERRORS.invalidEndpoint);
  }
  let parsed: URL;
  try {
    parsed = new URL(override);
  } catch {
    throw new Error(SAFE_ANTHROPIC_ERRORS.invalidEndpoint);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(SAFE_ANTHROPIC_ERRORS.invalidEndpoint);
  }
  if (!isLoopbackHostname(parsed.hostname)) {
    throw new Error(SAFE_ANTHROPIC_ERRORS.invalidEndpoint);
  }
  return parsed.toString();
}

export function resolveAnthropicModelEndpoint(
  messagesEndpoint: string,
  modelId: AnthropicModelId = ANTHROPIC_DEFAULT_MODEL,
): string {
  let parsed: URL;
  try {
    parsed = new URL(messagesEndpoint);
  } catch {
    throw new Error(SAFE_ANTHROPIC_ERRORS.invalidEndpoint);
  }
  if (!/\/v1\/messages\/?$/.test(parsed.pathname)) {
    throw new Error(SAFE_ANTHROPIC_ERRORS.invalidEndpoint);
  }
  parsed.pathname = parsed.pathname.replace(
    /\/messages\/?$/,
    `/models/${modelId}`,
  );
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString();
}

export function normalizeAnthropicUsage(candidate: unknown): AnthropicUsageParts {
  const value =
    candidate && typeof candidate === "object"
      ? (candidate as Record<string, unknown>)
      : {};
  const uncached = asNonnegativeInteger(value.input_tokens);
  const cacheRead = asNonnegativeInteger(value.cache_read_input_tokens);
  const cacheWrite = asNonnegativeInteger(value.cache_creation_input_tokens);
  return {
    inputTokens: uncached + cacheRead + cacheWrite,
    outputTokens: asNonnegativeInteger(value.output_tokens),
    cachedInputTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
  };
}

export function priceAnthropicUsage(
  modelId: string,
  usage: AnthropicUsageParts,
): { readonly amount: number; readonly currency: "USD" } {
  const rates = isAnthropicModelId(modelId)
    ? ANTHROPIC_PRICING[modelId]
    : ANTHROPIC_PRICING["claude-sonnet-5"];
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

export class WireToolMap {
  readonly #toWire = new Map<string, string>();
  readonly #fromWire = new Map<string, string>();

  alias(borgId: string): string {
    const existing = this.#toWire.get(borgId);
    if (existing) {
      return existing;
    }
    if (borgId.includes("_")) {
      throw new Error(SAFE_ANTHROPIC_ERRORS.unknownTool);
    }
    const wire = borgId.replaceAll(".", "_");
    if (
      wire.length === 0 ||
      wire.length > ANTHROPIC_TOOL_NAME_MAX ||
      !ANTHROPIC_TOOL_NAME.test(wire)
    ) {
      throw new Error(SAFE_ANTHROPIC_ERRORS.unknownTool);
    }
    this.#toWire.set(borgId, wire);
    this.#fromWire.set(wire, borgId);
    return wire;
  }

  resolve(wireName: string): string {
    const borgId = this.#fromWire.get(wireName);
    if (!borgId) {
      throw new Error(SAFE_ANTHROPIC_ERRORS.unknownTool);
    }
    return borgId;
  }
}

export function buildAnthropicRequest(
  request: ModelCompletionRequest,
  tools: WireToolMap,
): Record<string, unknown> {
  const systemBlocks: Record<string, unknown>[] = [];
  const messages: Record<string, unknown>[] = [];
  const pendingToolResults: Record<string, unknown>[] = [];

  const flushToolResults = (): void => {
    if (pendingToolResults.length === 0) {
      return;
    }
    messages.push({
      role: "user",
      content: pendingToolResults.splice(0),
    });
  };

  for (const message of request.messages) {
    if (message.role === "system") {
      flushToolResults();
      if (message.content.trim().length > 0) {
        systemBlocks.push({ type: "text", text: message.content });
      }
      continue;
    }
    if (message.role === "tool") {
      pendingToolResults.push({
        type: "tool_result",
        tool_use_id: message.toolCallId ?? "",
        content: message.content,
      });
      continue;
    }
    flushToolResults();
    messages.push(convertMessage(message, tools));
  }
  flushToolResults();

  const body: Record<string, unknown> = {
    model: request.modelId,
    max_tokens: ANTHROPIC_MAX_TOKENS,
    stream: true,
    messages,
  };

  if (systemBlocks.length > 0) {
    const last = systemBlocks.at(-1);
    if (last) {
      last.cache_control = { type: "ephemeral", ttl: "5m" };
    }
    body.system = systemBlocks;
  }

  if (request.tools.length > 0) {
    const converted = request.tools.map((tool, index) => {
      const entry: Record<string, unknown> = {
        name: tools.alias(tool.id),
        description: tool.description,
        input_schema: tool.inputSchema,
      };
      if (index === request.tools.length - 1) {
        entry.cache_control = { type: "ephemeral", ttl: "5m" };
      }
      return entry;
    });
    body.tools = converted;
  }

  return body;
}

function convertMessage(
  message: ModelMessage,
  tools: WireToolMap,
): Record<string, unknown> {
  if (message.role === "assistant") {
    const content: Record<string, unknown>[] = [];
    if (message.content.trim().length > 0) {
      content.push({ type: "text", text: message.content });
    }
    for (const toolCall of message.toolCalls ?? []) {
      content.push({
        type: "tool_use",
        id: toolCall.id,
        name: tools.alias(toolCall.name),
        input: toolCall.input ?? {},
      });
    }
    return { role: "assistant", content };
  }

  return {
    role: "user",
    content: message.content,
  };
}

export function classifyAnthropicStatus(status: number): string {
  if (status === 401 || status === 403) {
    return SAFE_ANTHROPIC_ERRORS.rejectedKey;
  }
  if (status === 429) {
    return SAFE_ANTHROPIC_ERRORS.rateLimited;
  }
  if (status === 400) {
    return SAFE_ANTHROPIC_ERRORS.rejected;
  }
  if (status === 529 || status >= 500) {
    return SAFE_ANTHROPIC_ERRORS.unavailable;
  }
  return SAFE_ANTHROPIC_ERRORS.rejected;
}

export function anthropicErrorFromUnknown(error: unknown): Error {
  if (isAbortError(error)) {
    return new Error(SAFE_ANTHROPIC_ERRORS.cancelled);
  }
  if (error instanceof Error) {
    if (
      Object.values(SAFE_ANTHROPIC_ERRORS).includes(
        error.message as (typeof SAFE_ANTHROPIC_ERRORS)[keyof typeof SAFE_ANTHROPIC_ERRORS],
      )
    ) {
      return error;
    }
    if (/timeout/i.test(error.message)) {
      return new Error(SAFE_ANTHROPIC_ERRORS.timeout);
    }
  }
  return new Error(SAFE_ANTHROPIC_ERRORS.protocol);
}

export interface AnthropicProviderOptions {
  readonly fetchImpl?: typeof fetch;
  readonly endpoint?: string;
  readonly timeoutMs?: number;
  getApiKey(): Promise<string | undefined>;
}

interface ToolBlockState {
  readonly id: string;
  readonly name: string;
  json: string;
}

export class AnthropicProvider implements LlmProviderContribution {
  readonly id = ANTHROPIC_PROVIDER_ID;
  readonly models = ANTHROPIC_MODELS;
  readonly #fetch: typeof fetch;
  readonly #endpoint: string;
  readonly #timeoutMs: number;
  readonly #getApiKey: () => Promise<string | undefined>;

  constructor(options: AnthropicProviderOptions) {
    this.#fetch = options.fetchImpl ?? fetch;
    this.#endpoint = options.endpoint ?? resolveAnthropicEndpoint();
    this.#timeoutMs = options.timeoutMs ?? ANTHROPIC_TIMEOUT_MS;
    this.#getApiKey = options.getApiKey;
  }

  async verify(signal?: AbortSignal): Promise<void> {
    const { response } = await this.#authenticatedFetch(
      resolveAnthropicModelEndpoint(this.#endpoint, ANTHROPIC_DEFAULT_MODEL),
      { method: "GET" },
      signal ?? new AbortController().signal,
    );
    if (!response.ok) {
      await discardBody(response);
      throw new Error(classifyAnthropicStatus(response.status));
    }
    await discardBody(response);
  }

  async complete(
    request: ModelCompletionRequest,
    signal: AbortSignal,
    onToken?: ((token: string) => void | Promise<void>) | undefined,
    onUsage?:
      | ((usage: ModelCompletionResult["usage"]) => void | Promise<void>)
      | undefined,
  ): Promise<ModelCompletionResult> {
    const tools = new WireToolMap();
    const body = buildAnthropicRequest(request, tools);
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
    );

    if (!response.ok) {
      await discardBody(response);
      throw new Error(classifyAnthropicStatus(response.status));
    }
    if (!response.body) {
      throw new Error(SAFE_ANTHROPIC_ERRORS.protocol);
    }

    try {
      return await this.#readStream(
        response.body,
        tools,
        request.modelId,
        combined,
        onToken,
        onUsage,
      );
    } catch (error) {
      if (timeout.aborted && !signal.aborted) {
        throw new Error(SAFE_ANTHROPIC_ERRORS.timeout);
      }
      throw anthropicErrorFromUnknown(error);
    }
  }

  async #authenticatedFetch(
    url: string,
    init: RequestInit,
    signal: AbortSignal,
  ): Promise<{
    readonly response: Response;
    readonly timeout: AbortSignal;
    readonly combined: AbortSignal;
  }> {
    const throwIfCancelled = (candidate: AbortSignal): void => {
      if (candidate.aborted) {
        throw new Error(SAFE_ANTHROPIC_ERRORS.cancelled);
      }
    };
    throwIfCancelled(signal);
    const apiKey = await this.#getApiKey();
    throwIfCancelled(signal);
    if (!apiKey) {
      throw new Error(SAFE_ANTHROPIC_ERRORS.missingKey);
    }

    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const combined = AbortSignal.any([signal, timeout]);
    throwIfCancelled(combined);

    try {
      const response = await this.#fetch(url, {
        ...init,
        headers: {
          ...init.headers,
          "x-api-key": apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        redirect: "error",
        signal: combined,
      });
      return { response, timeout, combined };
    } catch (error) {
      if (timeout.aborted && !signal.aborted) {
        throw new Error(SAFE_ANTHROPIC_ERRORS.timeout);
      }
      throw anthropicErrorFromUnknown(error);
    }
  }

  async #readStream(
    body: ReadableStream<Uint8Array>,
    tools: WireToolMap,
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
    let usageParts: AnthropicUsageParts = {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
    };
    const toolBlocks = new Map<number, ToolBlockState>();
    const finishedTools: ModelToolCall[] = [];
    let completed = false;

    const publishUsage = async (): Promise<void> => {
      if (!onUsage) {
        return;
      }
      const priced = priceAnthropicUsage(modelId, usageParts);
      await onUsage({
        inputTokens: usageParts.inputTokens,
        outputTokens: usageParts.outputTokens,
        cachedInputTokens: usageParts.cachedInputTokens,
        cacheWriteTokens: usageParts.cacheWriteTokens,
        amount: priced.amount,
        currency: priced.currency,
      });
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
      throw new Error(SAFE_ANTHROPIC_ERRORS.protocol);
    }

    const priced = priceAnthropicUsage(modelId, usageParts);
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
      if (frame.event === "ping" || frame.data === "[DONE]") {
        return;
      }
      let payload: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(frame.data);
        if (!parsed || typeof parsed !== "object") {
          throw new Error(SAFE_ANTHROPIC_ERRORS.protocol);
        }
        payload = parsed as Record<string, unknown>;
      } catch {
        throw new Error(SAFE_ANTHROPIC_ERRORS.protocol);
      }

      const type =
        typeof payload.type === "string" ? payload.type : frame.event;
      if (type === "error") {
        throw new Error(SAFE_ANTHROPIC_ERRORS.protocol);
      }
      if (type === "message_start") {
        const message =
          payload.message && typeof payload.message === "object"
            ? (payload.message as Record<string, unknown>)
            : {};
        usageParts = mergeUsage(usageParts, message.usage);
        await publishUsage();
        return;
      }
      if (type === "content_block_start") {
        const index = asIndex(payload.index);
        const block =
          payload.content_block && typeof payload.content_block === "object"
            ? (payload.content_block as Record<string, unknown>)
            : {};
        if (block.type === "tool_use") {
          if (typeof block.id !== "string" || typeof block.name !== "string") {
            throw new Error(SAFE_ANTHROPIC_ERRORS.protocol);
          }
          toolBlocks.set(index, {
            id: block.id,
            name: tools.resolve(block.name),
            json: "",
          });
        }
        return;
      }
      if (type === "content_block_delta") {
        const index = asIndex(payload.index);
        const delta =
          payload.delta && typeof payload.delta === "object"
            ? (payload.delta as Record<string, unknown>)
            : {};
        if (delta.type === "text_delta" && typeof delta.text === "string") {
          if (delta.text.length > 0) {
            text += delta.text;
            if (onToken) {
              await onToken(delta.text);
            }
          }
        }
        if (
          delta.type === "input_json_delta" &&
          typeof delta.partial_json === "string"
        ) {
          const block = toolBlocks.get(index);
          if (block) {
            block.json += delta.partial_json;
          }
        }
        return;
      }
      if (type === "content_block_stop") {
        const index = asIndex(payload.index);
        const block = toolBlocks.get(index);
        if (block) {
          finishedTools.push({
            id: block.id,
            name: block.name,
            input: parseToolInput(block.json),
          });
          toolBlocks.delete(index);
        }
        return;
      }
      if (type === "message_delta") {
        usageParts = mergeUsage(usageParts, payload.usage);
        await publishUsage();
        return;
      }
      if (type === "message_stop") {
        if (toolBlocks.size > 0) {
          throw new Error(SAFE_ANTHROPIC_ERRORS.protocol);
        }
        completed = true;
      }
    }
  }
}

interface SseFrame {
  readonly event: string;
  readonly data: string;
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
    throw new Error(SAFE_ANTHROPIC_ERRORS.protocol);
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

function mergeUsage(
  current: AnthropicUsageParts,
  candidate: unknown,
): AnthropicUsageParts {
  if (!candidate || typeof candidate !== "object") {
    return current;
  }
  const next = normalizeAnthropicUsage(candidate);
  return {
    inputTokens: Math.max(current.inputTokens, next.inputTokens),
    outputTokens: Math.max(current.outputTokens, next.outputTokens),
    cachedInputTokens: Math.max(
      current.cachedInputTokens,
      next.cachedInputTokens,
    ),
    cacheWriteTokens: Math.max(current.cacheWriteTokens, next.cacheWriteTokens),
  };
}

function parseToolInput(json: string): unknown {
  if (json.trim().length === 0) {
    return {};
  }
  try {
    return JSON.parse(json);
  } catch {
    throw new Error(SAFE_ANTHROPIC_ERRORS.protocol);
  }
}

function asNonnegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : 0;
}

function asIndex(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) ? value : -1;
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
