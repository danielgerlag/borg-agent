import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderDispatchPermit } from "@borg/plugin-sdk";
import {
  OPENAI_DEFAULT_MODEL,
  OPENAI_MAX_COMPLETION_TOKENS,
  OPENAI_PRODUCTION_ENDPOINT,
  OPENAI_TOOL_NAME_MAX,
  OpenAIProvider,
  OpenAIToolMap,
  SAFE_OPENAI_ERRORS,
  buildOpenAIRequest,
  normalizeOpenAIUsage,
  priceOpenAIUsage,
  resolveOpenAIEndpoint,
  resolveOpenAIModelEndpoint,
} from "../src/runtime";
import { createOpenAIHarness } from "./harness";

function createProviderDispatchPermit() {
  return {
    commit: vi.fn(async () => undefined),
  } satisfies ProviderDispatchPermit;
}

function sseResponse(
  frames: readonly string[],
  status = 200,
): Response {
  return new Response(`${frames.join("\n\n")}\n\n`, {
    status,
    headers: { "content-type": "text/event-stream" },
  });
}

function textStreamFrames(text = "Hello from GPT"): string[] {
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

describe("OpenAI request conversion", () => {
  it("keeps native Chat Completions roles and never sends max_tokens", () => {
    const tools = new OpenAIToolMap();
    const body = buildOpenAIRequest(
      {
        modelId: "gpt-5-mini",
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
    expect(body.max_completion_tokens).toBe(OPENAI_MAX_COMPLETION_TOKENS);
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.temperature).toBeUndefined();
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
    expect(body.messages).toEqual([
      { role: "system", content: "Be careful." },
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: {
              name: "tools_echo",
              arguments: JSON.stringify({ text: "hi" }),
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_1",
        content: JSON.stringify({ echoed: "hi" }),
      },
    ]);
  });

  it("aliases tools.echo reversibly and rejects unknown or overlong names", () => {
    const tools = new OpenAIToolMap();
    expect(tools.alias("tools.echo")).toBe("tools_echo");
    expect(tools.resolve("tools_echo")).toBe("tools.echo");
    expect(() => tools.alias("tools_echo")).toThrow(
      SAFE_OPENAI_ERRORS.unknownTool,
    );
    expect(() => tools.resolve("filesystem_read")).toThrow(
      SAFE_OPENAI_ERRORS.unknownTool,
    );
    const overlong = `tool.${"x".repeat(OPENAI_TOOL_NAME_MAX)}`;
    expect(() => tools.alias(overlong)).toThrow(
      SAFE_OPENAI_ERRORS.unknownTool,
    );
    expect(tools.alias("a".repeat(OPENAI_TOOL_NAME_MAX))).toHaveLength(
      OPENAI_TOOL_NAME_MAX,
    );
  });
});

describe("OpenAI usage normalization", () => {
  it("treats prompt_tokens as total input and clamps cache slices", () => {
    const usage = normalizeOpenAIUsage({
      prompt_tokens: 10,
      completion_tokens: 8,
      prompt_tokens_details: {
        cached_tokens: 4,
        cache_write_tokens: 2,
      },
    });
    expect(usage).toEqual({
      inputTokens: 10,
      outputTokens: 8,
      cachedInputTokens: 4,
      cacheWriteTokens: 2,
    });
    expect(priceOpenAIUsage("gpt-5-mini", usage)).toEqual({
      amount: Number(
        ((4 * 0.25 + 4 * 0.025 + 2 * 0.25 + 8 * 2) / 1_000_000).toFixed(8),
      ),
      currency: "USD",
    });

    expect(
      normalizeOpenAIUsage({
        prompt_tokens: 10,
        completion_tokens: 1,
        prompt_tokens_details: {
          cached_tokens: 8,
          cache_write_tokens: 5,
        },
      }),
    ).toEqual({
      inputTokens: 10,
      outputTokens: 1,
      cachedInputTokens: 8,
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

describe("OpenAI endpoint gating", () => {
  it("uses the production endpoint unless a loopback E2E override is present", () => {
    expect(resolveOpenAIEndpoint({})).toBe(OPENAI_PRODUCTION_ENDPOINT);
    expect(() =>
      resolveOpenAIEndpoint({
        BORG_OPENAI_ENDPOINT: "https://api.openai.com/v1/chat/completions",
      }),
    ).toThrow(SAFE_OPENAI_ERRORS.invalidEndpoint);
    expect(() =>
      resolveOpenAIEndpoint({
        BORG_E2E: "1",
        BORG_OPENAI_ENDPOINT: "https://example.com/v1/chat/completions",
      }),
    ).toThrow(SAFE_OPENAI_ERRORS.invalidEndpoint);
    expect(
      resolveOpenAIEndpoint({
        BORG_E2E: "1",
        BORG_OPENAI_ENDPOINT: "http://127.0.0.1:9/v1/chat/completions",
      }),
    ).toBe("http://127.0.0.1:9/v1/chat/completions");
    expect(
      resolveOpenAIModelEndpoint(OPENAI_PRODUCTION_ENDPOINT),
    ).toBe(`https://api.openai.com/v1/models/${OPENAI_DEFAULT_MODEL}`);
    expect(
      resolveOpenAIModelEndpoint("http://127.0.0.1:9/v1/chat/completions"),
    ).toBe(`http://127.0.0.1:9/v1/models/${OPENAI_DEFAULT_MODEL}`);
    expect(() =>
      resolveOpenAIModelEndpoint("http://127.0.0.1:9/v1/other"),
    ).toThrow(SAFE_OPENAI_ERRORS.invalidEndpoint);
  });
});

describe("OpenAIProvider", () => {
  it("looks up credentials, commits immediately before fetch, and streams text", async () => {
    const dispatchOrder: string[] = [];
    const permit = createProviderDispatchPermit();
    permit.commit.mockImplementation(async () => {
      dispatchOrder.push("commit");
    });
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      dispatchOrder.push("fetch");
      expect(url).toBe(OPENAI_PRODUCTION_ENDPOINT);
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer sk-openai-test");
      expect(init?.redirect).toBe("error");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.model).toBe("gpt-5-mini");
      expect(body.stream).toBe(true);
      expect(body.stream_options).toEqual({ include_usage: true });
      expect(body.max_completion_tokens).toBe(OPENAI_MAX_COMPLETION_TOKENS);
      expect(Object.hasOwn(body, "max_tokens")).toBe(false);
      expect(JSON.stringify(body)).not.toContain("sk-openai-test");
      return sseResponse(textStreamFrames());
    });
    const tokens: string[] = [];
    const provider = new OpenAIProvider({
      fetchImpl,
      getApiKey: async () => {
        await Promise.resolve();
        dispatchOrder.push("credential");
        return "sk-openai-test";
      },
    });
    const result = await provider.complete(
      {
        modelId: "gpt-5-mini",
        messages: [
          { role: "system", content: "Stay useful." },
          { role: "user", content: "hello" },
        ],
        tools: [],
      },
      permit,
      new AbortController().signal,
      async (token) => {
        tokens.push(token);
      },
    );
    expect(dispatchOrder).toEqual(["credential", "commit", "fetch"]);
    expect(permit.commit).toHaveBeenCalledOnce();
    expect(tokens).toEqual(["Hello from GPT"]);
    expect(result.content).toBe("Hello from GPT");
    expect(result.usage).toMatchObject({
      inputTokens: 10,
      outputTokens: 8,
      cachedInputTokens: 4,
      cacheWriteTokens: 2,
      currency: "USD",
    });
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
    const provider = new OpenAIProvider({
      fetchImpl,
      getApiKey: async () => "sk-openai-test",
    });
    const first = await provider.complete(
      {
        modelId: "gpt-5-mini",
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

    const second = await provider.complete(
      {
        modelId: "gpt-5-mini",
        messages: [
          { role: "user", content: "echo" },
          {
            role: "assistant",
            content: "",
            toolCalls: first.toolCalls,
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
      createProviderDispatchPermit(),
      new AbortController().signal,
    );
    expect(second.content).toBe("Used the tool");
  });

  it("aborts, rejects unknown aliases, and maps status codes without leaking secrets", async () => {
    const secret = "sk-openai-secret-value";
    for (const [status, message] of [
      [400, SAFE_OPENAI_ERRORS.rejected],
      [401, SAFE_OPENAI_ERRORS.rejectedKey],
      [403, SAFE_OPENAI_ERRORS.rejectedKey],
      [429, SAFE_OPENAI_ERRORS.rateLimited],
      [500, SAFE_OPENAI_ERRORS.unavailable],
      [529, SAFE_OPENAI_ERRORS.unavailable],
    ] as const) {
      const provider = new OpenAIProvider({
        fetchImpl: async () =>
          new Response(`{"error":{"message":"${secret}"}}`, { status }),
        getApiKey: async () => secret,
      });
      await expect(
        provider.complete(
          {
            modelId: "gpt-5-mini",
            messages: [{ role: "user", content: "hello" }],
            tools: [],
          },
          createProviderDispatchPermit(),
          new AbortController().signal,
        ),
      ).rejects.toThrow(message);
    }

    const aborting = new OpenAIProvider({
      fetchImpl: async (_url, init) => {
        const aborted = Object.assign(new Error("Aborted"), {
          name: "AbortError",
        });
        if (init?.signal?.aborted) {
          throw aborted;
        }
        await new Promise<void>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              reject(aborted);
            },
            { once: true },
          );
        });
        return sseResponse(textStreamFrames());
      },
      getApiKey: async () => secret,
    });
    const controller = new AbortController();
    const pending = aborting.complete(
      {
        modelId: "gpt-5-mini",
        messages: [{ role: "user", content: "hello" }],
        tools: [],
      },
      createProviderDispatchPermit(),
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toThrow(SAFE_OPENAI_ERRORS.cancelled);

    const unknownTool = new OpenAIProvider({
      fetchImpl: async () =>
        sseResponse([
          `data: ${JSON.stringify({
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_9",
                      type: "function",
                      function: { name: "not_registered", arguments: "{}" },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          })}`,
          "data: [DONE]",
        ]),
      getApiKey: async () => secret,
    });
    await expect(
      unknownTool.complete(
        {
          modelId: "gpt-5-mini",
          messages: [{ role: "user", content: "hello" }],
          tools: [],
        },
        createProviderDispatchPermit(),
        new AbortController().signal,
      ),
    ).rejects.toThrow(SAFE_OPENAI_ERRORS.unknownTool);

    const truncated = new OpenAIProvider({
      fetchImpl: async () =>
        new Response('data: {"choices":[{"delta":{"content":"hi"}}]', {
          status: 200,
        }),
      getApiKey: async () => secret,
    });
    await expect(
      truncated.complete(
        {
          modelId: "gpt-5-mini",
          messages: [{ role: "user", content: "hello" }],
          tools: [],
        },
        createProviderDispatchPermit(),
        new AbortController().signal,
      ),
    ).rejects.toThrow(SAFE_OPENAI_ERRORS.protocol);

    const malformed = new OpenAIProvider({
      fetchImpl: async () => sseResponse(["data: {not-json}"]),
      getApiKey: async () => secret,
    });
    await expect(
      malformed.complete(
        {
          modelId: "gpt-5-mini",
          messages: [{ role: "user", content: "hello" }],
          tools: [],
        },
        createProviderDispatchPermit(),
        new AbortController().signal,
      ),
    ).rejects.toThrow(SAFE_OPENAI_ERRORS.protocol);
  });

  it("does not leak the API key in thrown errors", async () => {
    const secret = "sk-openai-should-never-appear";
    const provider = new OpenAIProvider({
      fetchImpl: async () =>
        new Response(`authorization ${secret}`, { status: 401 }),
      getApiKey: async () => secret,
    });
    await provider
      .complete(
        {
          modelId: "gpt-5-mini",
          messages: [{ role: "user", content: "hello" }],
          tools: [],
        },
        createProviderDispatchPermit(),
        new AbortController().signal,
      )
      .catch((error: unknown) => {
        const serialized = JSON.stringify(error, Object.getOwnPropertyNames(error));
        expect(serialized).not.toContain(secret);
        expect(String(error)).not.toContain(secret);
      });
  });

  it("rejects overlong aliases before opening a network request", async () => {
    const fetchImpl = vi.fn();
    const provider = new OpenAIProvider({
      fetchImpl,
      getApiKey: async () => "sk-openai-test",
    });
    await expect(
      provider.complete(
        {
          modelId: "gpt-5-mini",
          messages: [{ role: "user", content: "hello" }],
          tools: [
            {
              id: `tool.${"x".repeat(OPENAI_TOOL_NAME_MAX)}`,
              description: "Too long",
              inputSchema: { type: "object" },
            },
          ],
        },
        createProviderDispatchPermit(),
        new AbortController().signal,
      ),
    ).rejects.toThrow(SAFE_OPENAI_ERRORS.unknownTool);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("times out with a safe message and does not leak secrets or bodies", async () => {
    const secret = "sk-openai-timeout-secret";
    const prompt = "secret prompt body that must not leak";
    const provider = new OpenAIProvider({
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
          modelId: "gpt-5-mini",
          messages: [{ role: "user", content: prompt }],
          tools: [],
        },
        createProviderDispatchPermit(),
        new AbortController().signal,
      )
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(SAFE_OPENAI_ERRORS.timeout);
    const serialized = JSON.stringify(error, Object.getOwnPropertyNames(error));
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(prompt);
    expect(String(error)).not.toContain(secret);
    expect(String(error)).not.toContain(prompt);
  });

  it("fails as protocol when [DONE] arrives with unfinished tool json", async () => {
    const provider = new OpenAIProvider({
      fetchImpl: async () =>
        sseResponse([
          `data: ${JSON.stringify({
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_trunc",
                      type: "function",
                      function: { name: "tools_echo", arguments: '{"text":' },
                    },
                  ],
                },
                finish_reason: "tool_calls",
              },
            ],
          })}`,
          "data: [DONE]",
        ]),
      getApiKey: async () => "sk-openai-test",
    });
    await expect(
      provider.complete(
        {
          modelId: "gpt-5-mini",
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
      ),
    ).rejects.toThrow(SAFE_OPENAI_ERRORS.protocol);
  });
});

describe("borg.openai lifecycle", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("registers from a saved key without a network call and disposes on disconnect", async () => {
    const fetchImpl = vi.fn(async () => sseResponse(textStreamFrames()));
    const fixture = createOpenAIHarness({ hasKey: true, fetchImpl });
    const harness = await fixture.activate();
    expect(fixture.providers).toHaveLength(1);
    expect(await fixture.invokeStatus()).toEqual({
      hasKey: true,
      connected: true,
    });
    expect(fetchImpl).not.toHaveBeenCalled();

    await fixture.invokeDisconnect();
    expect(fixture.providers).toHaveLength(0);
    expect(await fixture.invokeStatus()).toEqual({
      hasKey: true,
      connected: false,
    });
    await harness.deactivate();
    fixture.restoreFetch();
  });

  it("verifies on connect with a non-billed Models request", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("error");
      expect(String(url)).toBe(
        `https://api.openai.com/v1/models/${OPENAI_DEFAULT_MODEL}`,
      );
      expect(init?.body).toBeUndefined();
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer sk-openai-test");
      return new Response(JSON.stringify({ id: OPENAI_DEFAULT_MODEL }), {
        status: 200,
      });
    });
    const fixture = createOpenAIHarness({ fetchImpl });
    const harness = await fixture.activate();
    expect(fixture.providers).toHaveLength(0);
    fixture.secrets.set("apiKey", "sk-openai-test");
    await fixture.invokeConnect();
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fixture.providers).toHaveLength(1);
    await harness.deactivate();
    fixture.restoreFetch();
  });

  it("disposes registration when a key is replaced until it is verified again", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toContain("/v1/models/");
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("error");
      return new Response("{}", { status: 200 });
    });
    const fixture = createOpenAIHarness({ hasKey: true, fetchImpl });
    const harness = await fixture.activate();
    expect(fixture.providers).toHaveLength(1);
    fixture.secrets.set("apiKey", "sk-openai-replaced");
    await fixture.invokeDisconnect();
    expect(fixture.providers).toHaveLength(0);
    expect(await fixture.invokeStatus()).toEqual({
      hasKey: true,
      connected: false,
    });
    await fixture.invokeConnect();
    expect(fixture.providers).toHaveLength(1);
    expect(await fixture.invokeStatus()).toEqual({
      hasKey: true,
      connected: true,
    });
    await harness.deactivate();
    fixture.restoreFetch();
  });

  it("always deletes the secret and disposes registration", async () => {
    const fixture = createOpenAIHarness({ hasKey: true });
    const harness = await fixture.activate();
    expect(fixture.providers).toHaveLength(1);
    await fixture.invokeDisconnect();
    fixture.secrets.delete("apiKey");
    expect(fixture.providers).toHaveLength(0);
    expect(await fixture.invokeStatus()).toEqual({
      hasKey: false,
      connected: false,
    });
    await harness.deactivate();
  });
});
