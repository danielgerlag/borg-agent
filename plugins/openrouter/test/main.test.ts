import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderDispatchPermit } from "@borg/plugin-sdk";
import {
  OPENROUTER_PRODUCTION_ENDPOINT,
  OPENROUTER_TOOL_NAME_MAX,
  OpenRouterProvider,
  OpenRouterToolMap,
  SAFE_OPENROUTER_ERRORS,
  buildOpenRouterRequest,
  normalizeOpenAIUsage,
  resolveOpenRouterEndpoint,
  resolveOpenRouterModelsEndpoint,
} from "../src/runtime";
import { createOpenRouterHarness } from "./harness";

function createProviderDispatchPermit() {
  return {
    commit: vi.fn(async () => undefined),
  } satisfies ProviderDispatchPermit;
}

function sseResponse(frames: readonly string[], status = 200): Response {
  return new Response(`${frames.join("\n\n")}\n\n`, {
    status,
    headers: { "content-type": "text/event-stream" },
  });
}

function textStreamFrames(text = "Hello from OpenRouter"): string[] {
  return [
    `data: ${JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: text },
          finish_reason: null,
        },
      ],
    })}`,
    `data: ${JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    })}`,
    `data: ${JSON.stringify({
      id: "chatcmpl-test",
      object: "chat.completion.chunk",
      choices: [],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 8,
        prompt_tokens_details: {
          cached_tokens: 4,
          cache_write_tokens: 2,
        },
      },
    })}`,
    "data: [DONE]",
  ];
}

function toolStreamFrames(): string[] {
  return [
    `data: ${JSON.stringify({
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                type: "function",
                function: { name: "tools_echo", arguments: "" },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    })}`,
    `data: ${JSON.stringify({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                function: { arguments: '{"text":' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    })}`,
    `data: ${JSON.stringify({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                function: { arguments: '"hi"}' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    })}`,
    `data: ${JSON.stringify({
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    })}`,
    `data: ${JSON.stringify({
      choices: [],
      usage: { prompt_tokens: 6, completion_tokens: 3 },
    })}`,
    "data: [DONE]",
  ];
}

describe("OpenRouter request conversion", () => {
  it("keeps Chat Completions roles and omits token caps", () => {
    const tools = new OpenRouterToolMap();
    const body = buildOpenRouterRequest(
      {
        modelId: "openai/gpt-4o-mini",
        messages: [
          { role: "system", content: "Be careful." },
          { role: "user", content: "hello" },
          {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "call_1", name: "tools.echo", input: { text: "hi" } }],
          },
          {
            role: "tool",
            toolCallId: "call_1",
            content: JSON.stringify({ echoed: "hi" }),
          },
        ],
        tools: [
          {
            id: "tools.echo",
            description: "Echo",
            inputSchema: { type: "object" },
          },
        ],
      },
      tools,
    );

    expect(body.system).toBeUndefined();
    expect(Object.hasOwn(body, "max_tokens")).toBe(false);
    expect(Object.hasOwn(body, "max_completion_tokens")).toBe(false);
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "tools_echo",
          description: "Echo",
          parameters: { type: "object" },
        },
      },
    ]);
  });

  it("aliases tools.echo reversibly and rejects unknown or overlong names", () => {
    const tools = new OpenRouterToolMap();
    expect(tools.alias("tools.echo")).toBe("tools_echo");
    expect(tools.resolve("tools_echo")).toBe("tools.echo");
    expect(() => tools.alias("tools_echo")).toThrow(
      SAFE_OPENROUTER_ERRORS.unknownTool,
    );
    const overlong = `tool.${"x".repeat(OPENROUTER_TOOL_NAME_MAX)}`;
    expect(() => tools.alias(overlong)).toThrow(
      SAFE_OPENROUTER_ERRORS.unknownTool,
    );
  });
});

describe("OpenRouter usage normalization", () => {
  it("treats prompt_tokens as total input and clamps cache slices", () => {
    expect(
      normalizeOpenAIUsage({
        prompt_tokens: 10,
        completion_tokens: 8,
        prompt_tokens_details: {
          cached_tokens: 4,
          cache_write_tokens: 2,
        },
      }),
    ).toEqual({
      inputTokens: 10,
      outputTokens: 8,
      cachedInputTokens: 4,
      cacheWriteTokens: 2,
    });
    expect(
      normalizeOpenAIUsage({
        prompt_tokens: 10,
        completion_tokens: 1,
        prompt_tokens_details: {
          cached_tokens: 12,
          cache_write_tokens: 3,
        },
      }),
    ).toEqual({
      inputTokens: 10,
      outputTokens: 1,
      cachedInputTokens: 10,
      cacheWriteTokens: 0,
    });
  });
});

describe("OpenRouter endpoint gating", () => {
  it("pins openrouter.ai unless a loopback E2E override is present", () => {
    expect(resolveOpenRouterEndpoint({})).toBe(OPENROUTER_PRODUCTION_ENDPOINT);
    expect(() =>
      resolveOpenRouterEndpoint({
        BORG_OPENROUTER_ENDPOINT: "https://openrouter.ai/api/v1/chat/completions",
      }),
    ).toThrow(SAFE_OPENROUTER_ERRORS.invalidEndpoint);
    expect(() =>
      resolveOpenRouterEndpoint({
        BORG_E2E: "1",
        BORG_OPENROUTER_ENDPOINT: "https://example.com/api/v1/chat/completions",
      }),
    ).toThrow(SAFE_OPENROUTER_ERRORS.invalidEndpoint);
    expect(
      resolveOpenRouterEndpoint({
        BORG_E2E: "1",
        BORG_OPENROUTER_ENDPOINT: "http://127.0.0.1:9/v1/chat/completions",
      }),
    ).toBe("http://127.0.0.1:9/v1/chat/completions");
    expect(resolveOpenRouterModelsEndpoint(OPENROUTER_PRODUCTION_ENDPOINT)).toBe(
      "https://openrouter.ai/api/v1/models",
    );
  });
});

describe("OpenRouterProvider", () => {
  it("looks up credentials, commits immediately before fetch, and streams text", async () => {
    const dispatchOrder: string[] = [];
    const permit = createProviderDispatchPermit();
    permit.commit.mockImplementation(async () => {
      dispatchOrder.push("commit");
    });
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      dispatchOrder.push("fetch");
      expect(url).toBe(OPENROUTER_PRODUCTION_ENDPOINT);
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer sk-or-test");
      expect(headers.get("http-referer")).toBeNull();
      expect(headers.get("x-title")).toBeNull();
      expect(init?.redirect).toBe("error");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(Object.hasOwn(body, "max_tokens")).toBe(false);
      expect(Object.hasOwn(body, "max_completion_tokens")).toBe(false);
      expect(JSON.stringify(body)).not.toContain("sk-or-test");
      return sseResponse(textStreamFrames());
    });
    const tokens: string[] = [];
    const provider = new OpenRouterProvider({
      fetchImpl,
      models: ["openai/gpt-4o-mini"],
      getApiKey: async () => {
        await Promise.resolve();
        dispatchOrder.push("credential");
        return "sk-or-test";
      },
    });
    const result = await provider.complete(
      {
        modelId: "openai/gpt-4o-mini",
        messages: [{ role: "user", content: "hello" }],
        tools: [],
      },
      permit,
      new AbortController().signal,
      async (token) => {
        tokens.push(token);
      },
    );
    expect(dispatchOrder).toEqual(["credential", "commit", "fetch"]);
    expect(tokens).toEqual(["Hello from OpenRouter"]);
    expect(result.content).toBe("Hello from OpenRouter");
    expect(result.usage).toEqual({
      inputTokens: 10,
      outputTokens: 8,
      cachedInputTokens: 4,
      cacheWriteTokens: 2,
    });
    expect(result.usage.amount).toBeUndefined();
    expect(result.usage.currency).toBeUndefined();
  });

  it("maps tool calls and a tool-result second turn", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        readonly messages: readonly { readonly role: string }[];
      };
      if (body.messages.some((message) => message.role === "tool")) {
        return sseResponse(textStreamFrames("Used the tool"));
      }
      return sseResponse(toolStreamFrames());
    });
    const provider = new OpenRouterProvider({
      fetchImpl,
      models: ["openai/gpt-4o-mini"],
      getApiKey: async () => "sk-or-test",
    });
    const first = await provider.complete(
      {
        modelId: "openai/gpt-4o-mini",
        messages: [{ role: "user", content: "echo" }],
        tools: [
          {
            id: "tools.echo",
            description: "Echo",
            inputSchema: { type: "object" },
          },
        ],
      },
      createProviderDispatchPermit(),
      new AbortController().signal,
    );
    expect(first.toolCalls).toEqual([
      { id: "call_1", name: "tools.echo", input: { text: "hi" } },
    ]);
  });

  it("maps status codes without leaking secrets", async () => {
    const secret = "sk-or-secret-value";
    for (const [status, message] of [
      [400, SAFE_OPENROUTER_ERRORS.rejected],
      [401, SAFE_OPENROUTER_ERRORS.rejectedKey],
      [403, SAFE_OPENROUTER_ERRORS.rejectedKey],
      [429, SAFE_OPENROUTER_ERRORS.rateLimited],
      [500, SAFE_OPENROUTER_ERRORS.unavailable],
    ] as const) {
      const provider = new OpenRouterProvider({
        fetchImpl: async () =>
          new Response(`{"error":{"message":"${secret}"}}`, { status }),
        getApiKey: async () => secret,
      });
      await expect(
        provider.complete(
          {
            modelId: "openai/gpt-4o-mini",
            messages: [{ role: "user", content: "hello" }],
            tools: [],
          },
          createProviderDispatchPermit(),
          new AbortController().signal,
        ),
      ).rejects.toThrow(message);
    }
  });

  it("times out with a safe message and does not leak secrets or bodies", async () => {
    const secret = "sk-or-timeout-secret";
    const prompt = "secret prompt body that must not leak";
    const provider = new OpenRouterProvider({
      timeoutMs: 20,
      fetchImpl: async (_url, init) => {
        await new Promise<void>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
            },
            { once: true },
          );
        });
        return sseResponse(textStreamFrames());
      },
      getApiKey: async () => secret,
    });
    const error = await provider
      .complete(
        {
          modelId: "openai/gpt-4o-mini",
          messages: [{ role: "user", content: prompt }],
          tools: [],
        },
        createProviderDispatchPermit(),
        new AbortController().signal,
      )
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(SAFE_OPENROUTER_ERRORS.timeout);
    const serialized = JSON.stringify(error, Object.getOwnPropertyNames(error));
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(prompt);
  });
});

describe("borg.openrouter lifecycle", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("registers from a saved key and models without a network call", async () => {
    const fetchImpl = vi.fn(async () => sseResponse(textStreamFrames()));
    const fixture = createOpenRouterHarness({
      hasKey: true,
      models: ["openai/gpt-4o-mini"],
      fetchImpl,
    });
    const harness = await fixture.activate();
    expect(fixture.providers).toHaveLength(1);
    expect(fixture.providers[0]?.models).toEqual(["openai/gpt-4o-mini"]);
    expect(await fixture.invokeStatus()).toEqual({
      hasKey: true,
      connected: true,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    await fixture.invokeDisconnect();
    expect(fixture.providers).toHaveLength(0);
    await harness.deactivate();
    fixture.restoreFetch();
  });

  it("does not restore when a key is present but models are empty", async () => {
    const fixture = createOpenRouterHarness({ hasKey: true });
    const harness = await fixture.activate();
    expect(fixture.providers).toHaveLength(0);
    await harness.deactivate();
  });

  it("verifies on connect against /models and persists ids", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("GET");
      expect(String(url)).toBe("https://openrouter.ai/api/v1/models");
      expect(init?.body).toBeUndefined();
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer sk-or-test");
      return new Response(
        JSON.stringify({
          data: [{ id: "openai/gpt-4o-mini" }, { id: "anthropic/claude-sonnet-4" }],
        }),
        { status: 200 },
      );
    });
    const fixture = createOpenRouterHarness({ fetchImpl });
    const harness = await fixture.activate();
    fixture.secrets.set("apiKey", "sk-or-test");
    await fixture.invokeConnect();
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fixture.getConfig().models).toEqual([
      "openai/gpt-4o-mini",
      "anthropic/claude-sonnet-4",
    ]);
    expect(fixture.providers).toHaveLength(1);
    await harness.deactivate();
    fixture.restoreFetch();
  });

  it("disposes registration when a key is replaced until it is verified again", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: "openai/gpt-4o-mini" }] }), {
        status: 200,
      }),
    );
    const fixture = createOpenRouterHarness({
      hasKey: true,
      models: ["openai/gpt-4o-mini"],
      fetchImpl,
    });
    const harness = await fixture.activate();
    expect(fixture.providers).toHaveLength(1);
    fixture.secrets.set("apiKey", "sk-or-replaced");
    await fixture.invokeDisconnect();
    expect(fixture.providers).toHaveLength(0);
    await fixture.invokeConnect();
    expect(fixture.providers).toHaveLength(1);
    await harness.deactivate();
    fixture.restoreFetch();
  });
});
