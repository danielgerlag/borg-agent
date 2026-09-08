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
import { DEFAULT_OLLAMA_BASE_URL } from "./config";

export const OLLAMA_PROVIDER_ID = "borg.ollama";
export const OLLAMA_TIMEOUT_MS = 60_000;
export const OLLAMA_TOOL_NAME_MAX = 64;

export const OLLAMA_EGRESS = Object.freeze({
  kind: "local",
  capacity: "local-only",
} satisfies ProviderEgress);

export const SAFE_OLLAMA_ERRORS = Object.freeze({
  cancelled: "The Ollama request was cancelled.",
  timeout: "The Ollama request timed out.",
  rateLimited: "Ollama rate-limited the request. Try again shortly.",
  unavailable: "Ollama is temporarily unavailable. Try again shortly.",
  rejected: "Ollama rejected the request.",
  protocol: "Ollama returned an unreadable response.",
  unknownTool: "Ollama returned an unknown tool.",
  invalidEndpoint: "Ollama only accepts loopback URLs.",
  emptyCatalog: "Ollama returned no models.",
});

const SAFE_OLLAMA_ERROR_MESSAGES: ReadonlySet<string> = new Set(
  Object.values(SAFE_OLLAMA_ERRORS),
);

const OLLAMA_TOOL_NAME = /^[A-Za-z0-9_-]+$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export interface OllamaUsageParts {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheWriteTokens: number;
}

export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return LOOPBACK_HOSTS.has(host) || /^127(?:\.\d{1,3}){3}$/.test(host);
}

export function joinOllamaPath(base: string, suffix: string): string {
  return `${base.replace(/\/+$/, "")}/${suffix.replace(/^\/+/, "")}`;
}

export function assertLoopbackUrl(candidate: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error(SAFE_OLLAMA_ERRORS.invalidEndpoint);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(SAFE_OLLAMA_ERRORS.invalidEndpoint);
  }
  if (!isLoopbackHostname(parsed.hostname)) {
    throw new Error(SAFE_OLLAMA_ERRORS.invalidEndpoint);
  }
  return parsed;
}

export function resolveOllamaBaseUrl(
  configured: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.BORG_OLLAMA_ENDPOINT?.trim();
  if (override) {
    if (env.BORG_E2E !== "1") {
      throw new Error(SAFE_OLLAMA_ERRORS.invalidEndpoint);
    }
    const parsed = assertLoopbackUrl(override);
    return parsed.toString().replace(/\/+$/, "");
  }
  const base = configured.trim() || DEFAULT_OLLAMA_BASE_URL;
  const parsed = assertLoopbackUrl(base);
  return parsed.toString().replace(/\/+$/, "");
}

export function resolveOllamaCompletionsUrl(
  baseUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return joinOllamaPath(resolveOllamaBaseUrl(baseUrl, env), "chat/completions");
}

export function resolveOllamaModelsUrl(
  baseUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return joinOllamaPath(resolveOllamaBaseUrl(baseUrl, env), "models");
}

export function normalizeOpenAIUsage(candidate: unknown): OllamaUsageParts {
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

export function parseOpenAIModelCatalog(payload: unknown): string[] {
  const object = asObject(payload);
  if (!object) {
    throw new Error(SAFE_OLLAMA_ERRORS.protocol);
  }
  const data = object.data;
  if (!Array.isArray(data)) {
    throw new Error(SAFE_OLLAMA_ERRORS.protocol);
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of data) {
    const row = asObject(item);
    const id = row?.id;
    if (typeof id === "string" && id.length > 0 && !seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

export class OllamaToolMap {
  readonly #toWire = new Map<string, string>();
  readonly #fromWire = new Map<string, string>();

  alias(borgId: string): string {
    const existing = this.#toWire.get(borgId);
    if (existing) {
      return existing;
    }
    if (borgId.includes("_")) {
      throw new Error(SAFE_OLLAMA_ERRORS.unknownTool);
    }
    const wire = borgId.replaceAll(".", "_");
    if (
      wire.length === 0 ||
      wire.length > OLLAMA_TOOL_NAME_MAX ||
      !OLLAMA_TOOL_NAME.test(wire)
    ) {
      throw new Error(SAFE_OLLAMA_ERRORS.unknownTool);
    }
    this.#toWire.set(borgId, wire);
    this.#fromWire.set(wire, borgId);
    return wire;
  }

  resolve(wireName: string): string {
    const borgId = this.#fromWire.get(wireName);
    if (!borgId) {
      throw new Error(SAFE_OLLAMA_ERRORS.unknownTool);
    }
    return borgId;
  }
}

export function buildOllamaRequest(
  request: ModelCompletionRequest,
  tools: OllamaToolMap,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.modelId,
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
  tools: OllamaToolMap,
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

export function classifyOllamaStatus(status: number): string {
  if (status === 401 || status === 403) {
    return SAFE_OLLAMA_ERRORS.rejected;
  }
  if (status === 429) {
    return SAFE_OLLAMA_ERRORS.rateLimited;
  }
  if (status === 400) {
    return SAFE_OLLAMA_ERRORS.rejected;
  }
  if (status === 529 || status >= 500) {
    return SAFE_OLLAMA_ERRORS.unavailable;
  }
  return SAFE_OLLAMA_ERRORS.rejected;
}

export function ollamaErrorFromUnknown(error: unknown): Error {
  if (isAbortError(error)) {
    return new Error(SAFE_OLLAMA_ERRORS.cancelled);
  }
  if (error instanceof Error) {
    if (SAFE_OLLAMA_ERROR_MESSAGES.has(error.message)) {
      return error;
    }
    if (/timeout/i.test(error.message)) {
      return new Error(SAFE_OLLAMA_ERRORS.timeout);
    }
  }
  return new Error(SAFE_OLLAMA_ERRORS.protocol);
}

export interface OllamaProviderOptions {
  readonly fetchImpl?: typeof fetch;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly models?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
}

interface ToolCallState {
  id: string;
  name: string;
  json: string;
}

export class OllamaProvider implements LlmProviderContribution {
  readonly id = OLLAMA_PROVIDER_ID;
  readonly models: readonly string[];
  readonly egress = OLLAMA_EGRESS;
  readonly #fetch: typeof fetch;
  readonly #baseUrl: string;
  readonly #timeoutMs: number;

  constructor(options: OllamaProviderOptions = {}) {
    this.#fetch = options.fetchImpl ?? fetch;
    this.#baseUrl = resolveOllamaBaseUrl(
      options.baseUrl ?? DEFAULT_OLLAMA_BASE_URL,
      options.env ?? process.env,
    );
    this.#timeoutMs = options.timeoutMs ?? OLLAMA_TIMEOUT_MS;
    this.models = Object.freeze([...(options.models ?? [])]);
  }

  async verify(signal?: AbortSignal): Promise<readonly string[]> {
    const { response } = await this.#request(
      joinOllamaPath(this.#baseUrl, "models"),
      { method: "GET" },
      signal ?? new AbortController().signal,
    );
    if (!response.ok) {
      await discardBody(response);
      throw new Error(classifyOllamaStatus(response.status));
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error(SAFE_OLLAMA_ERRORS.protocol);
    }
    const models = parseOpenAIModelCatalog(payload);
    if (models.length === 0) {
      throw new Error(SAFE_OLLAMA_ERRORS.emptyCatalog);
    }
    return models;
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
    const tools = new OllamaToolMap();
    const body = buildOllamaRequest(request, tools);
    const { response, timeout, combined } = await this.#request(
      joinOllamaPath(this.#baseUrl, "chat/completions"),
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
      throw new Error(classifyOllamaStatus(response.status));
    }
    if (!response.body) {
      throw new Error(SAFE_OLLAMA_ERRORS.protocol);
    }
    try {
      return await readOpenAICompatStream(
        response.body,
        tools,
        combined,
        onToken,
        onUsage,
      );
    } catch (error) {
      if (timeout.aborted && !signal.aborted) {
        throw new Error(SAFE_OLLAMA_ERRORS.timeout);
      }
      throw ollamaErrorFromUnknown(error);
    }
  }

  async #request(
    url: string,
    init: RequestInit,
    signal: AbortSignal,
    permit?: ProviderDispatchPermit,
  ): Promise<{
    readonly response: Response;
    readonly timeout: AbortSignal;
    readonly combined: AbortSignal;
  }> {
    if (signal.aborted) {
      throw new Error(SAFE_OLLAMA_ERRORS.cancelled);
    }
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const combined = AbortSignal.any([signal, timeout]);
    if (combined.aborted) {
      throw new Error(SAFE_OLLAMA_ERRORS.cancelled);
    }
    await permit?.commit();
    try {
      const response = await this.#fetch(url, {
        ...init,
        redirect: "error",
        signal: combined,
      });
      return { response, timeout, combined };
    } catch (error) {
      if (timeout.aborted && !signal.aborted) {
        throw new Error(SAFE_OLLAMA_ERRORS.timeout);
      }
      throw ollamaErrorFromUnknown(error);
    }
  }
}

interface SseFrame {
  readonly event: string;
  readonly data: string;
}

async function readOpenAICompatStream(
  body: ReadableStream<Uint8Array>,
  tools: OllamaToolMap,
  signal: AbortSignal,
  onToken: ((token: string) => void | Promise<void>) | undefined,
  onUsage:
    | ((usage: ModelCompletionResult["usage"]) => void | Promise<void>)
    | undefined,
): Promise<ModelCompletionResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let usageParts: OllamaUsageParts = {
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
    await onUsage({
      inputTokens: usageParts.inputTokens,
      outputTokens: usageParts.outputTokens,
      cachedInputTokens: usageParts.cachedInputTokens,
      cacheWriteTokens: usageParts.cacheWriteTokens,
    });
  };

  const finishTools = (): void => {
    const indexes = [...toolBlocks.keys()].sort((left, right) => left - right);
    for (const index of indexes) {
      const block = toolBlocks.get(index);
      if (!block || block.id.length === 0 || block.name.length === 0) {
        throw new Error(SAFE_OLLAMA_ERRORS.protocol);
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
    throw new Error(SAFE_OLLAMA_ERRORS.protocol);
  }

  return {
    ...(text.length > 0 ? { content: text } : {}),
    ...(finishedTools.length > 0 ? { toolCalls: finishedTools } : {}),
    usage: {
      inputTokens: usageParts.inputTokens,
      outputTokens: usageParts.outputTokens,
      cachedInputTokens: usageParts.cachedInputTokens,
      cacheWriteTokens: usageParts.cacheWriteTokens,
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
        throw new Error(SAFE_OLLAMA_ERRORS.protocol);
      }
      payload = object;
    } catch {
      throw new Error(SAFE_OLLAMA_ERRORS.protocol);
    }
    if (payload.error !== undefined && payload.error !== null) {
      throw new Error(SAFE_OLLAMA_ERRORS.protocol);
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
      throw new Error(SAFE_OLLAMA_ERRORS.rejected);
    }
    const delta = asObject(choice.delta) ?? {};
    if (typeof delta.content === "string" && delta.content.length > 0) {
      text += delta.content;
      if (onToken) {
        await onToken(delta.content);
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
        throw new Error(SAFE_OLLAMA_ERRORS.protocol);
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
    throw new Error(SAFE_OLLAMA_ERRORS.protocol);
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
    throw new Error(SAFE_OLLAMA_ERRORS.protocol);
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
