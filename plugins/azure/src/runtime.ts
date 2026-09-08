import { execFile as nodeExecFile } from "node:child_process";
import net from "node:net";
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
import {
  AZURE_DEFAULT_API_VERSION,
  type AzureAuthMode,
} from "./config";

export const AZURE_PROVIDER_ID = "borg.azure";
export const AZURE_SECRET_KEY = "apiKey";
export const AZURE_TIMEOUT_MS = 60_000;
export const AZURE_TOOL_NAME_MAX = 64;
export const AZURE_COGNITIVE_RESOURCE =
  "https://cognitiveservices.azure.com";
export const AZURE_TOKEN_SCOPE = `${AZURE_COGNITIVE_RESOURCE}/.default`;
export const AZURE_IMDS_TOKEN_URL =
  "http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https://cognitiveservices.azure.com";
export const AZURE_TOKEN_REFRESH_SKEW_MS = 5 * 60_000;

export const SAFE_AZURE_ERRORS = Object.freeze({
  cancelled: "The Azure request was cancelled.",
  timeout: "The Azure request timed out.",
  missingKey: "Azure is not connected. Add an API key in Settings.",
  missingEndpoint: "Azure is not connected. Add a resource endpoint in Settings.",
  missingCredential:
    "Azure could not find credentials. Run az login or azd auth login, or use an API key.",
  rejectedKey: "Azure rejected the credentials. Replace them in Settings.",
  rateLimited: "Azure rate-limited the request. Try again shortly.",
  unavailable: "Azure is temporarily unavailable. Try again shortly.",
  rejected: "Azure rejected the request.",
  protocol: "Azure returned an unreadable response.",
  unknownTool: "Azure returned an unknown tool.",
  invalidEndpoint: "Azure endpoint must be an https resource URL.",
  emptyCatalog: "Azure returned no models.",
});

const SAFE_AZURE_ERROR_MESSAGES: ReadonlySet<string> = new Set(
  Object.values(SAFE_AZURE_ERRORS),
);

const AZURE_TOOL_NAME = /^[A-Za-z0-9_-]+$/;

export interface AzureUsageParts {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheWriteTokens: number;
}

export interface AzureAccessToken {
  readonly accessToken: string;
  readonly expiresAtMs: number;
}

export type AcquireAzureToken = (
  signal?: AbortSignal,
) => Promise<AzureAccessToken>;

export type AzureExecFile = (
  file: string,
  args: readonly string[],
) => Promise<string>;

export function isTruthyEnv(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export function foundryResourceUrl(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/+$/, "");
  const marker = "/api/projects/";
  const index = trimmed.indexOf(marker);
  return index >= 0 ? trimmed.slice(0, index) : trimmed;
}

function isDatedAzureApiVersion(version: string): boolean {
  return /^\d{4}-\d{2}-\d{2}/.test(version);
}

export function withApiVersion(url: string, apiVersion: string): string {
  const version = apiVersion.trim();
  if (version.length === 0) {
    return url;
  }
  const parsed = new URL(url);
  if (
    parsed.pathname.includes("/openai/v1/") &&
    isDatedAzureApiVersion(version)
  ) {
    return url;
  }
  parsed.searchParams.set("api-version", version);
  return parsed.toString();
}

export function resolveAzureResourceUrl(endpoint: string): string {
  const resource = foundryResourceUrl(endpoint);
  if (resource.length === 0) {
    throw new Error(SAFE_AZURE_ERRORS.missingEndpoint);
  }
  let parsed: URL;
  try {
    parsed = new URL(resource);
  } catch {
    throw new Error(SAFE_AZURE_ERRORS.invalidEndpoint);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(SAFE_AZURE_ERRORS.invalidEndpoint);
  }
  return resource;
}

export function resolveAzureCompletionsUrl(
  endpoint: string,
  apiVersion: string = AZURE_DEFAULT_API_VERSION,
): string {
  return withApiVersion(
    `${resolveAzureResourceUrl(endpoint)}/openai/v1/chat/completions`,
    apiVersion,
  );
}

export function resolveAzureModelsUrl(
  endpoint: string,
  apiVersion: string = AZURE_DEFAULT_API_VERSION,
): string {
  return withApiVersion(
    `${resolveAzureResourceUrl(endpoint)}/openai/v1/models`,
    apiVersion,
  );
}

// TCP probe: a laptop without IMDS would otherwise hang on the HTTP token call.
export function probeImds(timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "169.254.169.254", port: 80 });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(false);
    });
  });
}

export function execFileStdout(
  file: string,
  args: readonly string[],
): Promise<string> {
  return new Promise((resolve, reject) => {
    nodeExecFile(
      file,
      [...args],
      { encoding: "utf8", timeout: 20_000, windowsHide: true },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function parseExpiryMs(candidate: unknown, now: number): number {
  if (typeof candidate === "number" && Number.isFinite(candidate)) {
    return candidate > 1e12 ? candidate : candidate * 1000;
  }
  if (typeof candidate === "string" && candidate.trim().length > 0) {
    const trimmed = candidate.trim();
    if (/^\d+$/.test(trimmed)) {
      const numeric = Number(trimmed);
      return numeric > 1e12 ? numeric : numeric * 1000;
    }
    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return now + 3_600_000;
}

function parseAzAccessToken(stdout: string, now: number): AzureAccessToken {
  let payload: unknown;
  try {
    payload = JSON.parse(stdout);
  } catch {
    throw new Error(SAFE_AZURE_ERRORS.missingCredential);
  }
  const object = asObject(payload);
  if (!object) {
    throw new Error(SAFE_AZURE_ERRORS.missingCredential);
  }
  const accessToken = object.accessToken;
  if (typeof accessToken !== "string" || accessToken.trim().length === 0) {
    throw new Error(SAFE_AZURE_ERRORS.missingCredential);
  }
  return {
    accessToken: accessToken.trim(),
    expiresAtMs: parseExpiryMs(
      object.expires_on ?? object.expiresOn,
      now,
    ),
  };
}

export interface AzureTokenAcquirerOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchImpl?: typeof fetch;
  readonly execFile?: AzureExecFile;
  readonly probeImds?: () => Promise<boolean>;
  readonly now?: () => number;
}

export function createAzureTokenAcquirer(
  options: AzureTokenAcquirerOptions = {},
): AcquireAzureToken {
  const env = options.env ?? process.env;
  const fetchImpl = options.fetchImpl ?? fetch;
  const execFile = options.execFile ?? execFileStdout;
  const probe = options.probeImds ?? (() => probeImds());
  const now = options.now ?? (() => Date.now());
  let cached: AzureAccessToken | undefined;

  const shouldSkipManagedIdentity = (): boolean =>
    isTruthyEnv(env.BORG_AZURE_SKIP_MANAGED_IDENTITY);

  const shouldTryManagedIdentity = async (): Promise<boolean> => {
    if (shouldSkipManagedIdentity()) {
      return false;
    }
    if (
      (env.IDENTITY_ENDPOINT?.trim().length ?? 0) > 0 ||
      (env.MSI_ENDPOINT?.trim().length ?? 0) > 0 ||
      (env.AZURE_FEDERATED_TOKEN_FILE?.trim().length ?? 0) > 0
    ) {
      return true;
    }
    return probe();
  };

  const fromImds = async (signal?: AbortSignal): Promise<AzureAccessToken | undefined> => {
    const timeout = AbortSignal.timeout(3_000);
    const combined = signal
      ? AbortSignal.any([signal, timeout])
      : timeout;
    try {
      const response = await fetchImpl(AZURE_IMDS_TOKEN_URL, {
        method: "GET",
        headers: { Metadata: "true" },
        redirect: "error",
        signal: combined,
      });
      if (!response.ok) {
        await response.arrayBuffer().catch(() => undefined);
        return undefined;
      }
      const payload: unknown = await response.json();
      const object = asObject(payload);
      if (!object) {
        return undefined;
      }
      const accessToken = object.access_token;
      if (typeof accessToken !== "string" || accessToken.trim().length === 0) {
        return undefined;
      }
      return {
        accessToken: accessToken.trim(),
        expiresAtMs: parseExpiryMs(object.expires_on, now()),
      };
    } catch {
      return undefined;
    }
  };

  const fromCli = async (): Promise<AzureAccessToken> => {
    const instant = now();
    try {
      const stdout = await execFile("az", [
        "account",
        "get-access-token",
        "--resource",
        AZURE_COGNITIVE_RESOURCE,
        "--output",
        "json",
      ]);
      return parseAzAccessToken(stdout, instant);
    } catch {
      try {
        const stdout = await execFile("azd", [
          "auth",
          "token",
          "--scope",
          AZURE_TOKEN_SCOPE,
        ]);
        const accessToken = stdout.trim();
        if (accessToken.length === 0) {
          throw new Error(SAFE_AZURE_ERRORS.missingCredential);
        }
        return {
          accessToken,
          expiresAtMs: instant + 3_600_000,
        };
      } catch {
        throw new Error(SAFE_AZURE_ERRORS.missingCredential);
      }
    }
  };

  return async (signal) => {
    const instant = now();
    if (
      cached &&
      cached.expiresAtMs - instant > AZURE_TOKEN_REFRESH_SKEW_MS
    ) {
      return cached;
    }
    if (await shouldTryManagedIdentity()) {
      const imds = await fromImds(signal);
      if (imds) {
        cached = imds;
        return imds;
      }
    }
    const cli = await fromCli();
    cached = cli;
    return cli;
  };
}

export function normalizeOpenAIUsage(candidate: unknown): AzureUsageParts {
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
    throw new Error(SAFE_AZURE_ERRORS.protocol);
  }
  const data = object.data;
  if (!Array.isArray(data)) {
    throw new Error(SAFE_AZURE_ERRORS.protocol);
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

export class AzureToolMap {
  readonly #toWire = new Map<string, string>();
  readonly #fromWire = new Map<string, string>();

  alias(borgId: string): string {
    const existing = this.#toWire.get(borgId);
    if (existing) {
      return existing;
    }
    if (borgId.includes("_")) {
      throw new Error(SAFE_AZURE_ERRORS.unknownTool);
    }
    const wire = borgId.replaceAll(".", "_");
    if (
      wire.length === 0 ||
      wire.length > AZURE_TOOL_NAME_MAX ||
      !AZURE_TOOL_NAME.test(wire)
    ) {
      throw new Error(SAFE_AZURE_ERRORS.unknownTool);
    }
    this.#toWire.set(borgId, wire);
    this.#fromWire.set(wire, borgId);
    return wire;
  }

  resolve(wireName: string): string {
    const borgId = this.#fromWire.get(wireName);
    if (!borgId) {
      throw new Error(SAFE_AZURE_ERRORS.unknownTool);
    }
    return borgId;
  }
}

export function buildAzureRequest(
  request: ModelCompletionRequest,
  tools: AzureToolMap,
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
  tools: AzureToolMap,
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

export function classifyAzureStatus(status: number): string {
  if (status === 401 || status === 403) {
    return SAFE_AZURE_ERRORS.rejectedKey;
  }
  if (status === 429) {
    return SAFE_AZURE_ERRORS.rateLimited;
  }
  if (status === 400) {
    return SAFE_AZURE_ERRORS.rejected;
  }
  if (status === 529 || status >= 500) {
    return SAFE_AZURE_ERRORS.unavailable;
  }
  return SAFE_AZURE_ERRORS.rejected;
}

export function azureErrorFromUnknown(error: unknown): Error {
  if (isAbortError(error)) {
    return new Error(SAFE_AZURE_ERRORS.cancelled);
  }
  if (error instanceof Error) {
    if (SAFE_AZURE_ERROR_MESSAGES.has(error.message)) {
      return error;
    }
    if (/timeout/i.test(error.message)) {
      return new Error(SAFE_AZURE_ERRORS.timeout);
    }
  }
  return new Error(SAFE_AZURE_ERRORS.protocol);
}

export interface AzureProviderOptions {
  readonly fetchImpl?: typeof fetch;
  readonly endpoint: string;
  readonly apiVersion?: string;
  readonly authMode: AzureAuthMode;
  readonly timeoutMs?: number;
  readonly models?: readonly string[];
  readonly acquireAzureToken?: AcquireAzureToken;
  getApiKey(): Promise<string | undefined>;
}

interface ToolCallState {
  id: string;
  name: string;
  json: string;
}

export class AzureProvider implements LlmProviderContribution {
  readonly id = AZURE_PROVIDER_ID;
  readonly models: readonly string[];
  readonly egress: ProviderEgress;
  readonly #fetch: typeof fetch;
  readonly #completionsUrl: string;
  readonly #modelsUrl: string;
  readonly #timeoutMs: number;
  readonly #authMode: AzureAuthMode;
  readonly #getApiKey: () => Promise<string | undefined>;
  readonly #acquireAzureToken: AcquireAzureToken;

  constructor(options: AzureProviderOptions) {
    this.#fetch = options.fetchImpl ?? fetch;
    this.#completionsUrl = resolveAzureCompletionsUrl(
      options.endpoint,
      options.apiVersion ?? AZURE_DEFAULT_API_VERSION,
    );
    this.#modelsUrl = resolveAzureModelsUrl(
      options.endpoint,
      options.apiVersion ?? AZURE_DEFAULT_API_VERSION,
    );
    this.#timeoutMs = options.timeoutMs ?? AZURE_TIMEOUT_MS;
    this.#authMode = options.authMode;
    this.#getApiKey = options.getApiKey;
    this.#acquireAzureToken =
      options.acquireAzureToken ?? createAzureTokenAcquirer();
    this.models = Object.freeze([...(options.models ?? [])]);
    this.egress = Object.freeze({
      kind: "remote",
      capacity: "internal",
      destination: this.#completionsUrl,
    } satisfies ProviderEgress);
  }

  async verify(signal?: AbortSignal): Promise<readonly string[]> {
    const { response } = await this.#authenticatedFetch(
      this.#modelsUrl,
      { method: "GET" },
      signal ?? new AbortController().signal,
    );
    if (!response.ok) {
      await discardBody(response);
      throw new Error(classifyAzureStatus(response.status));
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error(SAFE_AZURE_ERRORS.protocol);
    }
    const models = parseOpenAIModelCatalog(payload);
    if (models.length === 0) {
      throw new Error(SAFE_AZURE_ERRORS.emptyCatalog);
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
    const tools = new AzureToolMap();
    const body = buildAzureRequest(request, tools);
    const { response, timeout, combined } = await this.#authenticatedFetch(
      this.#completionsUrl,
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
      throw new Error(classifyAzureStatus(response.status));
    }
    if (!response.body) {
      throw new Error(SAFE_AZURE_ERRORS.protocol);
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
        throw new Error(SAFE_AZURE_ERRORS.timeout);
      }
      throw azureErrorFromUnknown(error);
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
    if (signal.aborted) {
      throw new Error(SAFE_AZURE_ERRORS.cancelled);
    }
    const headers = new Headers(init.headers);
    if (this.#authMode === "api-key") {
      const apiKey = await this.#getApiKey();
      if (signal.aborted) {
        throw new Error(SAFE_AZURE_ERRORS.cancelled);
      }
      if (!apiKey) {
        throw new Error(SAFE_AZURE_ERRORS.missingKey);
      }
      headers.set("api-key", apiKey);
    } else {
      const token = await this.#acquireAzureToken(signal);
      if (signal.aborted) {
        throw new Error(SAFE_AZURE_ERRORS.cancelled);
      }
      headers.set("Authorization", `Bearer ${token.accessToken}`);
    }
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const combined = AbortSignal.any([signal, timeout]);
    if (combined.aborted) {
      throw new Error(SAFE_AZURE_ERRORS.cancelled);
    }
    await permit?.commit();
    try {
      const response = await this.#fetch(url, {
        ...init,
        headers,
        redirect: "error",
        signal: combined,
      });
      return { response, timeout, combined };
    } catch (error) {
      if (timeout.aborted && !signal.aborted) {
        throw new Error(SAFE_AZURE_ERRORS.timeout);
      }
      throw azureErrorFromUnknown(error);
    }
  }
}

interface SseFrame {
  readonly event: string;
  readonly data: string;
}

async function readOpenAICompatStream(
  body: ReadableStream<Uint8Array>,
  tools: AzureToolMap,
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
  let usageParts: AzureUsageParts = {
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
        throw new Error(SAFE_AZURE_ERRORS.protocol);
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
    throw new Error(SAFE_AZURE_ERRORS.protocol);
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
        throw new Error(SAFE_AZURE_ERRORS.protocol);
      }
      payload = object;
    } catch {
      throw new Error(SAFE_AZURE_ERRORS.protocol);
    }
    if (payload.error !== undefined && payload.error !== null) {
      throw new Error(SAFE_AZURE_ERRORS.protocol);
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
      throw new Error(SAFE_AZURE_ERRORS.rejected);
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
        throw new Error(SAFE_AZURE_ERRORS.protocol);
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
    throw new Error(SAFE_AZURE_ERRORS.protocol);
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
    throw new Error(SAFE_AZURE_ERRORS.protocol);
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
