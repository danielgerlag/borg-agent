import type {
  Disposable,
  JsonValue,
  LlmProviderContribution,
  ModelCompletionRequest,
  ModelCompletionResult,
} from "@borg/plugin-sdk";
import { CostLedger } from "./cost-ledger";

export interface ModelRouterOptions {
  readonly fallbackPreferences?: readonly string[] | undefined;
}

interface RegisteredProvider {
  readonly pluginId: string;
  readonly provider: LlmProviderContribution;
}

function asNonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`${label} must be a nonnegative integer`);
  }
  return value as number;
}

function asJsonValue(value: unknown, label: string): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    return Object.freeze(
      value.map((entry) => asJsonValue(entry, label)),
    );
  }
  if (
    value &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.getOwnPropertySymbols(value).length === 0
  ) {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
          key,
          asJsonValue(entry, label),
        ]),
      ),
    );
  }
  throw new Error(`${label} must be JSON-serializable`);
}

function normalizeResult(
  providerId: string,
  candidate: unknown,
): ModelCompletionResult {
  if (!candidate || typeof candidate !== "object") {
    throw new Error(`Provider ${providerId} returned an invalid completion`);
  }
  const value = candidate as Record<string, unknown>;
  const content =
    value.content === undefined
      ? undefined
      : typeof value.content === "string"
        ? value.content
        : (() => {
            throw new Error(`Provider ${providerId} returned invalid content`);
          })();
  const toolCalls =
    value.toolCalls === undefined
      ? undefined
      : Array.isArray(value.toolCalls)
        ? value.toolCalls.map((candidateCall) => {
            if (!candidateCall || typeof candidateCall !== "object") {
              throw new Error(
                `Provider ${providerId} returned an invalid tool call`,
              );
            }
            const call = candidateCall as Record<string, unknown>;
            if (
              typeof call.id !== "string" ||
              call.id.length === 0 ||
              typeof call.name !== "string" ||
              call.name.length === 0
            ) {
              throw new Error(
                `Provider ${providerId} returned an invalid tool call`,
              );
            }
            return {
              id: call.id,
              name: call.name,
              input: asJsonValue(
                call.input,
                `${providerId} tool call ${call.name} input`,
              ),
            };
          })
        : (() => {
            throw new Error(
              `Provider ${providerId} returned invalid tool calls`,
            );
          })();
  if (!value.usage || typeof value.usage !== "object") {
    throw new Error(`Provider ${providerId} returned invalid usage`);
  }
  const usage = value.usage as Record<string, unknown>;
  const optionalInteger = (entry: unknown, label: string): number | undefined =>
    entry === undefined ? undefined : asNonnegativeInteger(entry, label);
  const amount =
    usage.amount === undefined
      ? undefined
      : typeof usage.amount === "number" &&
          Number.isFinite(usage.amount) &&
          usage.amount >= 0
        ? usage.amount
        : (() => {
            throw new Error(`${providerId} usage amount must be nonnegative`);
          })();
  const currency =
    usage.currency === undefined
      ? undefined
      : typeof usage.currency === "string" && usage.currency.length > 0
        ? usage.currency
        : (() => {
            throw new Error(`${providerId} usage currency is invalid`);
          })();
  const result = {
    content,
    toolCalls,
    usage: {
      inputTokens: asNonnegativeInteger(
        usage.inputTokens,
        `${providerId} inputTokens`,
      ),
      outputTokens: asNonnegativeInteger(
        usage.outputTokens,
        `${providerId} outputTokens`,
      ),
      cachedInputTokens: optionalInteger(
        usage.cachedInputTokens,
        `${providerId} cachedInputTokens`,
      ),
      cacheWriteTokens: optionalInteger(
        usage.cacheWriteTokens,
        `${providerId} cacheWriteTokens`,
      ),
      amount,
      currency,
    },
  };
  const cached = result.usage.cachedInputTokens ?? 0;
  const written = result.usage.cacheWriteTokens ?? 0;
  if (cached + written > result.usage.inputTokens) {
    throw new Error(
      `${providerId} cachedInputTokens and cacheWriteTokens must not exceed inputTokens`,
    );
  }
  return result;
}

export interface RoutedCompletion {
  readonly providerId: string;
  readonly modelId: string;
  readonly result: ModelCompletionResult;
}

export class ModelRouter {
  readonly #providers = new Map<string, RegisteredProvider>();
  readonly #fallbackPreferences: readonly string[];

  constructor(
    readonly costs: CostLedger,
    options: ModelRouterOptions = {},
  ) {
    this.#fallbackPreferences = Object.freeze([
      ...(options.fallbackPreferences ?? []),
    ]);
  }

  registerProvider(
    pluginId: string,
    provider: LlmProviderContribution,
  ): Disposable {
    if (
      !/^[a-z0-9]+(?:[.-][a-z0-9-]+)+$/.test(provider.id) ||
      !Array.isArray(provider.models) ||
      provider.models.length === 0 ||
      provider.models.some(
        (model) => typeof model !== "string" || model.length === 0,
      ) ||
      typeof provider.complete !== "function"
    ) {
      throw new Error(`Invalid LLM provider contribution ${provider.id}`);
    }
    if (this.#providers.has(provider.id)) {
      throw new Error(`LLM provider ${provider.id} is already registered`);
    }
    const providerId = provider.id;
    const registeredProvider: LlmProviderContribution = Object.freeze({
      id: providerId,
      models: Object.freeze([...provider.models]),
      complete: provider.complete.bind(provider),
    });
    const registration = { pluginId, provider: registeredProvider };
    this.#providers.set(providerId, registration);
    return {
      dispose: () => {
        if (this.#providers.get(providerId) === registration) {
          this.#providers.delete(providerId);
        }
      },
    };
  }

  removePlugin(pluginId: string): void {
    for (const [providerId, registration] of this.#providers) {
      if (registration.pluginId === pluginId) {
        this.#providers.delete(providerId);
      }
    }
  }

  listModels(): readonly {
    readonly providerId: string;
    readonly modelId: string;
    readonly preferenceId: string;
  }[] {
    return Object.freeze(
      [...this.#providers.values()]
        .flatMap(({ provider }) =>
          provider.models.map((modelId) =>
            Object.freeze({
              providerId: provider.id,
              modelId,
              preferenceId: `${provider.id}:${modelId}`,
            }),
          ),
        )
        .sort((left, right) =>
          left.preferenceId.localeCompare(right.preferenceId),
        ),
    );
  }

  resolvePreferences(
    preferences: readonly string[],
  ): { readonly providerId: string; readonly modelId: string } | undefined {
    const matches = (candidate: string, pattern: string): boolean => {
      if (pattern === "*") {
        return true;
      }
      if (pattern.endsWith("*")) {
        return candidate.startsWith(pattern.slice(0, -1));
      }
      return candidate === pattern;
    };
    for (const preference of preferences) {
      const separator = preference.indexOf(":");
      const providerPattern =
        separator > 0 ? preference.slice(0, separator) : "*";
      const modelPattern =
        separator > 0 ? preference.slice(separator + 1) : preference;
      for (const { provider } of this.#providers.values()) {
        if (!matches(provider.id, providerPattern)) {
          continue;
        }
        const modelId = provider.models.find((model) =>
          matches(model, modelPattern),
        );
        if (modelId) {
          return { providerId: provider.id, modelId };
        }
      }
    }
    return undefined;
  }

  async complete(
    request: Omit<ModelCompletionRequest, "modelId"> & {
      readonly providerId?: string | undefined;
      readonly modelId?: string | undefined;
      readonly runId?: string | undefined;
      readonly correlationId: string;
    },
    signal: AbortSignal,
    onToken?: (token: string) => void | Promise<void>,
  ): Promise<RoutedCompletion> {
    signal.throwIfAborted();
    const registration = this.#resolveRegistration(
      request.providerId,
      request.modelId,
    );
    if (!registration) {
      throw new Error(
        request.providerId
          ? `LLM provider ${request.providerId} is unavailable`
          : "No LLM provider is available",
      );
    }
    const modelId = request.modelId ?? registration.provider.models[0];
    if (!modelId || !registration.provider.models.includes(modelId)) {
      throw new Error(
        `Model ${request.modelId ?? "(default)"} is unavailable from ${registration.provider.id}`,
      );
    }
    let latestPartial: ModelCompletionResult["usage"] | undefined;
    let candidateResult: unknown;
    try {
      candidateResult = await registration.provider.complete(
        {
          modelId,
          messages: Object.freeze(
            request.messages.map((message) =>
              Object.freeze({
                ...message,
                toolCalls: message.toolCalls
                  ? Object.freeze(
                      message.toolCalls.map((toolCall) =>
                        Object.freeze({
                          ...toolCall,
                          input: structuredClone(toolCall.input),
                        }),
                      ),
                    )
                  : undefined,
              }),
            ),
          ),
          tools: Object.freeze(
            request.tools.map((tool) => Object.freeze({ ...tool })),
          ),
        },
        signal,
        onToken
          ? async (token) => {
              signal.throwIfAborted();
              if (typeof token !== "string" || token.length === 0) {
                throw new Error(
                  `Provider ${registration.provider.id} emitted an invalid token`,
                );
              }
              await onToken(token);
            }
          : undefined,
        (usage) => {
          latestPartial = normalizeResult(registration.provider.id, {
            content: "",
            usage,
          }).usage;
        },
      );
    } catch (error) {
      if (latestPartial) {
        this.costs.record({
          providerId: registration.provider.id,
          modelId,
          inputTokens: latestPartial.inputTokens,
          outputTokens: latestPartial.outputTokens,
          cachedInputTokens: latestPartial.cachedInputTokens,
          cacheWriteTokens: latestPartial.cacheWriteTokens,
          amount: latestPartial.amount,
          currency: latestPartial.currency,
          correlationId: request.correlationId,
          runId: request.runId,
        });
      }
      throw error;
    }
    const result = normalizeResult(
      registration.provider.id,
      candidateResult,
    );
    const usage = result.usage;
    this.costs.record({
      providerId: registration.provider.id,
      modelId,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      amount: usage.amount,
      currency: usage.currency,
      correlationId: request.correlationId,
      runId: request.runId,
    });
    signal.throwIfAborted();
    if (this.#providers.get(registration.provider.id) !== registration) {
      throw new Error(
        `LLM provider ${registration.provider.id} is no longer available`,
      );
    }
    return {
      providerId: registration.provider.id,
      modelId,
      result,
    };
  }

  #resolveRegistration(
    providerId: string | undefined,
    modelId: string | undefined,
  ): RegisteredProvider | undefined {
    if (providerId) {
      return this.#providers.get(providerId);
    }
    if (modelId) {
      return [...this.#providers.values()].find(({ provider }) =>
        provider.models.includes(modelId),
      );
    }
    const fallback = this.resolvePreferences(this.#fallbackPreferences);
    if (fallback) {
      return this.#providers.get(fallback.providerId);
    }
    return this.#providers.values().next().value;
  }
}
