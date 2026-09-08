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

export const COPILOT_PROVIDER_ID = "borg.copilot";
export const COPILOT_SECRET_KEY = "githubOauthToken";
export const COPILOT_CLIENT_ID = "Iv1.b507a08c87ecfe98";
export const COPILOT_SCOPE = "copilot";
export const COPILOT_DEVICE_CODE_URL = "https://github.com/login/device/code";
export const COPILOT_ACCESS_TOKEN_URL =
  "https://github.com/login/oauth/access_token";
export const COPILOT_SESSION_TOKEN_URL =
  "https://api.github.com/copilot_internal/v2/token";
export const COPILOT_COMPLETIONS_URL =
  "https://api.githubcopilot.com/chat/completions";
export const COPILOT_MODELS_URL = "https://api.githubcopilot.com/models";
export const COPILOT_TIMEOUT_MS = 60_000;
export const COPILOT_TOOL_NAME_MAX = 64;
export const COPILOT_SESSION_SKEW_SECONDS = 60;
export const COPILOT_DEFAULT_SESSION_TTL_SECONDS = 1_500;

export const COPILOT_EGRESS = Object.freeze({
  kind: "remote",
  capacity: "internal",
  destination: COPILOT_COMPLETIONS_URL,
} satisfies ProviderEgress);

export const SAFE_COPILOT_ERRORS = Object.freeze({
  cancelled: "The Copilot request was cancelled.",
  timeout: "The Copilot request timed out.",
  missingToken: "Copilot is not connected. Sign in with GitHub in Settings.",
  rejectedKey: "Copilot rejected the GitHub token. Sign in again in Settings.",
  rateLimited: "Copilot rate-limited the request. Try again shortly.",
  unavailable: "Copilot is temporarily unavailable. Try again shortly.",
  rejected: "Copilot rejected the request.",
  protocol: "Copilot returned an unreadable response.",
  unknownTool: "Copilot returned an unknown tool.",
  emptyCatalog: "Copilot returned no models.",
  deviceFlowInactive: "Copilot sign-in is not in progress.",
  deviceFlowExpired: "Copilot sign-in expired. Start again.",
  deviceFlowDenied: "Copilot sign-in was denied.",
  deviceFlowFailed: "Copilot sign-in failed.",
});

const SAFE_COPILOT_ERROR_MESSAGES: ReadonlySet<string> = new Set(
  Object.values(SAFE_COPILOT_ERRORS),
);

const COPILOT_TOOL_NAME = /^[A-Za-z0-9_-]+$/;

export interface CopilotUsageParts {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheWriteTokens: number;
}

export interface CopilotDeviceFlowSession {
  readonly deviceCode: string;
  readonly interval: number;
  readonly expiresAtMs: number;
}

export interface CopilotDeviceFlowPublic {
  readonly userCode: string;
  readonly verificationUri: string;
  readonly interval: number;
  readonly expiresIn: number;
}

export type CopilotDeviceFlowPollResult =
  | { readonly status: "pending" }
  | { readonly status: "complete"; readonly accessToken: string }
  | { readonly status: "failed"; readonly error: string };

export async function resolveCopilotOauthToken(options: {
  getSecret(): Promise<string | undefined>;
  env?: NodeJS.ProcessEnv;
}): Promise<string | undefined> {
  const secret = (await options.getSecret())?.trim();
  if (secret && secret.length > 0) {
    return secret;
  }
  const env = options.env ?? process.env;
  const github = env.GITHUB_TOKEN?.trim();
  if (github && github.length > 0) {
    return github;
  }
  const gh = env.GH_TOKEN?.trim();
  if (gh && gh.length > 0) {
    return gh;
  }
  return undefined;
}

export async function startCopilotDeviceFlow(options: {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}): Promise<{
  readonly session: CopilotDeviceFlowSession;
  readonly public: CopilotDeviceFlowPublic;
}> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? COPILOT_TIMEOUT_MS);
  const combined = options.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout;
  let response: Response;
  try {
    response = await fetchImpl(COPILOT_DEVICE_CODE_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: COPILOT_CLIENT_ID,
        scope: COPILOT_SCOPE,
      }).toString(),
      redirect: "error",
      signal: combined,
    });
  } catch (error) {
    throw copilotErrorFromUnknown(error, timeout, options.signal);
  }
  if (!response.ok) {
    await discardBody(response);
    throw new Error(SAFE_COPILOT_ERRORS.deviceFlowFailed);
  }
  const payload = asObject(await readJson(response));
  const deviceCode = asNonemptyString(payload?.device_code);
  const userCode = asNonemptyString(payload?.user_code);
  const verificationUri = asNonemptyString(payload?.verification_uri);
  const interval = asPositiveInteger(payload?.interval) ?? 5;
  const expiresIn = asPositiveInteger(payload?.expires_in);
  if (!deviceCode || !userCode || !verificationUri || !expiresIn) {
    throw new Error(SAFE_COPILOT_ERRORS.protocol);
  }
  return {
    session: {
      deviceCode,
      interval,
      expiresAtMs: Date.now() + expiresIn * 1000,
    },
    public: {
      userCode,
      verificationUri,
      interval,
      expiresIn,
    },
  };
}

export async function pollCopilotDeviceFlow(options: {
  readonly deviceCode: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}): Promise<CopilotDeviceFlowPollResult> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? COPILOT_TIMEOUT_MS);
  const combined = options.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout;
  let response: Response;
  try {
    response = await fetchImpl(COPILOT_ACCESS_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: COPILOT_CLIENT_ID,
        device_code: options.deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }).toString(),
      redirect: "error",
      signal: combined,
    });
  } catch (error) {
    throw copilotErrorFromUnknown(error, timeout, options.signal);
  }
  const payload = asObject(await readJson(response).catch(() => ({})));
  const accessToken = asNonemptyString(payload?.access_token);
  if (accessToken) {
    return { status: "complete", accessToken };
  }
  const code = asNonemptyString(payload?.error);
  if (code === "authorization_pending" || code === "slow_down") {
    return { status: "pending" };
  }
  if (code === "expired_token") {
    return { status: "failed", error: SAFE_COPILOT_ERRORS.deviceFlowExpired };
  }
  if (code === "access_denied") {
    return { status: "failed", error: SAFE_COPILOT_ERRORS.deviceFlowDenied };
  }
  return { status: "failed", error: SAFE_COPILOT_ERRORS.deviceFlowFailed };
}

export function normalizeOpenAIUsage(candidate: unknown): CopilotUsageParts {
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
    throw new Error(SAFE_COPILOT_ERRORS.protocol);
  }
  const data = object.data;
  if (!Array.isArray(data)) {
    throw new Error(SAFE_COPILOT_ERRORS.protocol);
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

export class CopilotToolMap {
  readonly #toWire = new Map<string, string>();
  readonly #fromWire = new Map<string, string>();

  alias(borgId: string): string {
    const existing = this.#toWire.get(borgId);
    if (existing) {
      return existing;
    }
    if (borgId.includes("_")) {
      throw new Error(SAFE_COPILOT_ERRORS.unknownTool);
    }
    const wire = borgId.replaceAll(".", "_");
    if (
      wire.length === 0 ||
      wire.length > COPILOT_TOOL_NAME_MAX ||
      !COPILOT_TOOL_NAME.test(wire)
    ) {
      throw new Error(SAFE_COPILOT_ERRORS.unknownTool);
    }
    this.#toWire.set(borgId, wire);
    this.#fromWire.set(wire, borgId);
    return wire;
  }

  resolve(wireName: string): string {
    const borgId = this.#fromWire.get(wireName);
    if (!borgId) {
      throw new Error(SAFE_COPILOT_ERRORS.unknownTool);
    }
    return borgId;
  }
}

export function buildCopilotRequest(
  request: ModelCompletionRequest,
  tools: CopilotToolMap,
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
  tools: CopilotToolMap,
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

export function classifyCopilotStatus(status: number): string {
  if (status === 401 || status === 403) {
    return SAFE_COPILOT_ERRORS.rejectedKey;
  }
  if (status === 429) {
    return SAFE_COPILOT_ERRORS.rateLimited;
  }
  if (status === 400) {
    return SAFE_COPILOT_ERRORS.rejected;
  }
  if (status === 529 || status >= 500) {
    return SAFE_COPILOT_ERRORS.unavailable;
  }
  return SAFE_COPILOT_ERRORS.rejected;
}

export function copilotErrorFromUnknown(
  error: unknown,
  timeout?: AbortSignal,
  signal?: AbortSignal,
): Error {
  if (timeout?.aborted && !signal?.aborted) {
    return new Error(SAFE_COPILOT_ERRORS.timeout);
  }
  if (isAbortError(error)) {
    return new Error(SAFE_COPILOT_ERRORS.cancelled);
  }
  if (error instanceof Error) {
    if (SAFE_COPILOT_ERROR_MESSAGES.has(error.message)) {
      return error;
    }
    if (/timeout/i.test(error.message)) {
      return new Error(SAFE_COPILOT_ERRORS.timeout);
    }
  }
  return new Error(SAFE_COPILOT_ERRORS.protocol);
}

export interface CopilotSessionToken {
  readonly token: string;
  readonly expiresAt: number;
}

export interface CopilotProviderOptions {
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly models?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => number;
  getOauthToken(): Promise<string | undefined>;
}

interface ToolCallState {
  id: string;
  name: string;
  json: string;
}

export class CopilotProvider implements LlmProviderContribution {
  readonly id = COPILOT_PROVIDER_ID;
  readonly models: readonly string[];
  readonly egress = COPILOT_EGRESS;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #env: NodeJS.ProcessEnv;
  readonly #now: () => number;
  readonly #getOauthToken: () => Promise<string | undefined>;
  #session: CopilotSessionToken | undefined;

  constructor(options: CopilotProviderOptions) {
    this.#fetch = options.fetchImpl ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? COPILOT_TIMEOUT_MS;
    this.#env = options.env ?? process.env;
    this.#now = options.now ?? (() => Date.now());
    this.#getOauthToken = options.getOauthToken;
    this.models = Object.freeze([...(options.models ?? [])]);
  }

  async verify(signal?: AbortSignal): Promise<readonly string[]> {
    const session = await this.#sessionToken(signal ?? new AbortController().signal);
    const { response } = await this.#request(
      COPILOT_MODELS_URL,
      {
        method: "GET",
        headers: copilotApiHeaders(session.token),
      },
      signal ?? new AbortController().signal,
    );
    if (!response.ok) {
      await discardBody(response);
      throw new Error(classifyCopilotStatus(response.status));
    }
    const models = parseOpenAIModelCatalog(await readJson(response));
    if (models.length === 0) {
      throw new Error(SAFE_COPILOT_ERRORS.emptyCatalog);
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
    const tools = new CopilotToolMap();
    const body = buildCopilotRequest(request, tools);
    const session = await this.#sessionToken(signal);
    const { response, timeout, combined } = await this.#request(
      COPILOT_COMPLETIONS_URL,
      {
        method: "POST",
        headers: {
          ...copilotApiHeaders(session.token),
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      },
      signal,
      permit,
    );
    if (!response.ok) {
      await discardBody(response);
      throw new Error(classifyCopilotStatus(response.status));
    }
    if (!response.body) {
      throw new Error(SAFE_COPILOT_ERRORS.protocol);
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
      throw copilotErrorFromUnknown(error, timeout, signal);
    }
  }

  async #sessionToken(signal: AbortSignal): Promise<CopilotSessionToken> {
    const nowSeconds = Math.floor(this.#now() / 1000);
    if (
      this.#session &&
      this.#session.expiresAt > nowSeconds + COPILOT_SESSION_SKEW_SECONDS
    ) {
      return this.#session;
    }
    const oauth = await resolveCopilotOauthToken({
      getSecret: this.#getOauthToken,
      env: this.#env,
    });
    if (!oauth) {
      throw new Error(SAFE_COPILOT_ERRORS.missingToken);
    }
    const { response } = await this.#request(
      COPILOT_SESSION_TOKEN_URL,
      {
        method: "GET",
        headers: {
          Authorization: `token ${oauth}`,
          "User-Agent": "borg-desktop",
          Accept: "application/json",
        },
      },
      signal,
    );
    if (!response.ok) {
      await discardBody(response);
      throw new Error(classifyCopilotStatus(response.status));
    }
    const payload = asObject(await readJson(response));
    const token = asNonemptyString(payload?.token);
    if (!token) {
      throw new Error(SAFE_COPILOT_ERRORS.protocol);
    }
    const expiresAt =
      asPositiveInteger(payload?.expires_at) ??
      nowSeconds + COPILOT_DEFAULT_SESSION_TTL_SECONDS;
    this.#session = { token, expiresAt };
    return this.#session;
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
      throw new Error(SAFE_COPILOT_ERRORS.cancelled);
    }
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const combined = AbortSignal.any([signal, timeout]);
    if (combined.aborted) {
      throw new Error(SAFE_COPILOT_ERRORS.cancelled);
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
      throw copilotErrorFromUnknown(error, timeout, signal);
    }
  }
}

function copilotApiHeaders(sessionToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${sessionToken}`,
    "Editor-Version": "Borg/0.1.0",
    "Editor-Plugin-Version": "copilot/0.1.0",
    "Copilot-Integration-Id": "vscode-chat",
    Accept: "application/json",
  };
}

interface SseFrame {
  readonly event: string;
  readonly data: string;
}

async function readOpenAICompatStream(
  body: ReadableStream<Uint8Array>,
  tools: CopilotToolMap,
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
  let usageParts: CopilotUsageParts = {
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
        throw new Error(SAFE_COPILOT_ERRORS.protocol);
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
    throw new Error(SAFE_COPILOT_ERRORS.protocol);
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
        throw new Error(SAFE_COPILOT_ERRORS.protocol);
      }
      payload = object;
    } catch {
      throw new Error(SAFE_COPILOT_ERRORS.protocol);
    }
    if (payload.error !== undefined && payload.error !== null) {
      throw new Error(SAFE_COPILOT_ERRORS.protocol);
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
      throw new Error(SAFE_COPILOT_ERRORS.rejected);
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
        throw new Error(SAFE_COPILOT_ERRORS.protocol);
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
    throw new Error(SAFE_COPILOT_ERRORS.protocol);
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
    throw new Error(SAFE_COPILOT_ERRORS.protocol);
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

function asPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function asNonemptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
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

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error(SAFE_COPILOT_ERRORS.protocol);
  }
}

async function discardBody(response: Response): Promise<void> {
  await response.arrayBuffer().catch(() => undefined);
}
