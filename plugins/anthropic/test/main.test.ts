import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ANTHROPIC_DEFAULT_MODEL,
  ANTHROPIC_PRODUCTION_ENDPOINT,
  ANTHROPIC_TOOL_NAME_MAX,
  ANTHROPIC_VERSION,
  AnthropicProvider,
  SAFE_ANTHROPIC_ERRORS,
  WireToolMap,
  buildAnthropicRequest,
  normalizeAnthropicUsage,
  priceAnthropicUsage,
  resolveAnthropicEndpoint,
  resolveAnthropicModelEndpoint,
} from "../src/runtime";
import { createAnthropicHarness } from "./harness";

function sseResponse(
  frames: readonly string[],
  status = 200,
): Response {
  return new Response(`${frames.join("\n\n")}\n\n`, {
    status,
    headers: { "content-type": "text/event-stream" },
  });
}

function textStreamFrames(text = "Hello from Claude"): string[] {
  return [
    `event: message_start\ndata: ${JSON.stringify({
      type: "message_start",
      message: {
        usage: {
          input_tokens: 10,
          output_tokens: 0,
          cache_read_input_tokens: 4,
          cache_creation_input_tokens: 2,
        },
      },
    })}`,
    `event: content_block_start\ndata: ${JSON.stringify({
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    })}`,
    `event: content_block_delta\ndata: ${JSON.stringify({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text },
    })}`,
    `event: content_block_stop\ndata: ${JSON.stringify({
      type: "content_block_stop",
      index: 0,
    })}`,
    `event: message_delta\ndata: ${JSON.stringify({
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 8 },
    })}`,
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}`,
  ];
}

function toolStreamFrames(): string[] {
  return [
    `event: message_start\ndata: ${JSON.stringify({
      type: "message_start",
      message: { usage: { input_tokens: 6, output_tokens: 0 } },
    })}`,
    `event: content_block_start\ndata: ${JSON.stringify({
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: "call_1",
        name: "tools_echo",
        input: {},
      },
    })}`,
    `event: content_block_delta\ndata: ${JSON.stringify({
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"text":' },
    })}`,
    `event: content_block_delta\ndata: ${JSON.stringify({
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '"hi"}' },
    })}`,
    `event: content_block_stop\ndata: ${JSON.stringify({
      type: "content_block_stop",
      index: 0,
    })}`,
    `event: message_delta\ndata: ${JSON.stringify({
      type: "message_delta",
      usage: { output_tokens: 3 },
    })}`,
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}`,
  ];
}

describe("Anthropic request conversion", () => {
  it("hoists system messages, maps tools, and caches the stable prefix", () => {
    const tools = new WireToolMap();
    const body = buildAnthropicRequest(
      {
        modelId: "claude-sonnet-5",
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

    expect(body.system).toEqual([
      {
        type: "text",
        text: "Be careful.",
        cache_control: { type: "ephemeral", ttl: "5m" },
      },
    ]);
    expect(body.tools).toEqual([
      {
        name: "tools_echo",
        description: "Echo",
        input_schema: { type: "object" },
        cache_control: { type: "ephemeral", ttl: "5m" },
      },
    ]);
    expect(body.messages).toEqual([
      { role: "user", content: "hello" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_1",
            name: "tools_echo",
            input: { text: "hi" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_1",
            content: JSON.stringify({ echoed: "hi" }),
          },
        ],
      },
    ]);
  });

  it("groups contiguous tool results into one user message", () => {
    const tools = new WireToolMap();
    const body = buildAnthropicRequest(
      {
        modelId: "claude-sonnet-5",
        messages: [
          { role: "user", content: "use both" },
          {
            role: "assistant",
            content: "",
            toolCalls: [
              { id: "call_1", name: "tools.echo", input: { text: "one" } },
              { id: "call_2", name: "tools.echo", input: { text: "two" } },
            ],
          },
          {
            role: "tool",
            toolCallId: "call_1",
            content: JSON.stringify({ echoed: "one" }),
          },
          {
            role: "tool",
            toolCallId: "call_2",
            content: JSON.stringify({ echoed: "two" }),
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

    expect(body.messages).toEqual([
      { role: "user", content: "use both" },
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_1",
            name: "tools_echo",
            input: { text: "one" },
          },
          {
            type: "tool_use",
            id: "call_2",
            name: "tools_echo",
            input: { text: "two" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_1",
            content: JSON.stringify({ echoed: "one" }),
          },
          {
            type: "tool_result",
            tool_use_id: "call_2",
            content: JSON.stringify({ echoed: "two" }),
          },
        ],
      },
    ]);
  });

  it("rejects unknown and overlong tool aliases before network", () => {
    const tools = new WireToolMap();
    tools.alias("tools.echo");
    expect(() => tools.resolve("filesystem_read")).toThrow(
      SAFE_ANTHROPIC_ERRORS.unknownTool,
    );
    const overlong = `tool.${"x".repeat(ANTHROPIC_TOOL_NAME_MAX)}`;
    expect(() => tools.alias(overlong)).toThrow(
      SAFE_ANTHROPIC_ERRORS.unknownTool,
    );
    expect(tools.alias("a".repeat(ANTHROPIC_TOOL_NAME_MAX))).toHaveLength(
      ANTHROPIC_TOOL_NAME_MAX,
    );
  });
});

describe("Anthropic usage normalization", () => {
  it("adds cache tokens into total input and prices without double counting", () => {
    const usage = normalizeAnthropicUsage({
      input_tokens: 10,
      output_tokens: 4,
      cache_read_input_tokens: 6,
      cache_creation_input_tokens: 2,
    });
    expect(usage).toEqual({
      inputTokens: 18,
      outputTokens: 4,
      cachedInputTokens: 6,
      cacheWriteTokens: 2,
    });
    expect(priceAnthropicUsage("claude-sonnet-5", usage)).toEqual({
      amount: Number(((10 * 2 + 6 * 0.2 + 2 * 2.5 + 4 * 10) / 1_000_000).toFixed(8)),
      currency: "USD",
    });
  });
});

describe("Anthropic endpoint gating", () => {
  it("uses the production endpoint unless a loopback E2E override is present", () => {
    expect(resolveAnthropicEndpoint({})).toBe(ANTHROPIC_PRODUCTION_ENDPOINT);
    expect(() =>
      resolveAnthropicEndpoint({
        BORG_ANTHROPIC_ENDPOINT: "https://api.anthropic.com/v1/messages",
      }),
    ).toThrow(SAFE_ANTHROPIC_ERRORS.invalidEndpoint);
    expect(() =>
      resolveAnthropicEndpoint({
        BORG_E2E: "1",
        BORG_ANTHROPIC_ENDPOINT: "https://example.com/v1/messages",
      }),
    ).toThrow(SAFE_ANTHROPIC_ERRORS.invalidEndpoint);
    expect(
      resolveAnthropicEndpoint({
        BORG_E2E: "1",
        BORG_ANTHROPIC_ENDPOINT: "http://127.0.0.1:9/v1/messages",
      }),
    ).toBe("http://127.0.0.1:9/v1/messages");
    expect(
      resolveAnthropicModelEndpoint(ANTHROPIC_PRODUCTION_ENDPOINT),
    ).toBe(`https://api.anthropic.com/v1/models/${ANTHROPIC_DEFAULT_MODEL}`);
    expect(
      resolveAnthropicModelEndpoint("http://127.0.0.1:9/v1/messages"),
    ).toBe(`http://127.0.0.1:9/v1/models/${ANTHROPIC_DEFAULT_MODEL}`);
    expect(() =>
      resolveAnthropicModelEndpoint("http://127.0.0.1:9/v1/other"),
    ).toThrow(SAFE_ANTHROPIC_ERRORS.invalidEndpoint);
  });
});

describe("AnthropicProvider", () => {
  it("sends required headers and streams text", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(url).toBe(ANTHROPIC_PRODUCTION_ENDPOINT);
      const headers = new Headers(init?.headers);
      expect(headers.get("x-api-key")).toBe("sk-ant-test");
      expect(headers.get("anthropic-version")).toBe(ANTHROPIC_VERSION);
      expect(init?.redirect).toBe("error");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.model).toBe("claude-sonnet-5");
      expect(body.stream).toBe(true);
      expect(JSON.stringify(body)).not.toContain("sk-ant-test");
      return sseResponse(textStreamFrames());
    });
    const tokens: string[] = [];
    const provider = new AnthropicProvider({
      fetchImpl,
      getApiKey: async () => "sk-ant-test",
    });
    const result = await provider.complete(
      {
        modelId: "claude-sonnet-5",
        messages: [
          { role: "system", content: "Stay useful." },
          { role: "user", content: "hello" },
        ],
        tools: [],
      },
      new AbortController().signal,
      async (token) => {
        tokens.push(token);
      },
    );
    expect(tokens).toEqual(["Hello from Claude"]);
    expect(result.content).toBe("Hello from Claude");
    expect(result.usage).toMatchObject({
      inputTokens: 16,
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
      if (body.messages.some((message) => message.role === "assistant")) {
        return sseResponse(textStreamFrames("Used the tool"));
      }
      return sseResponse(toolStreamFrames());
    });
    const provider = new AnthropicProvider({
      fetchImpl,
      getApiKey: async () => "sk-ant-test",
    });
    const first = await provider.complete(
      {
        modelId: "claude-sonnet-5",
        messages: [{ role: "user", content: "echo" }],
        tools: [
          {
            id: "tools.echo",
            description: "Echo",
            inputSchema: { type: "object" },
          },
        ],
      },
      new AbortController().signal,
    );
    expect(first.toolCalls).toEqual([
      { id: "call_1", name: "tools.echo", input: { text: "hi" } },
    ]);

    const second = await provider.complete(
      {
        modelId: "claude-sonnet-5",
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
      new AbortController().signal,
    );
    expect(second.content).toBe("Used the tool");
  });

  it("aborts, rejects unknown aliases, and maps status codes without leaking secrets", async () => {
    const secret = "sk-ant-secret-value";
    for (const [status, message] of [
      [400, SAFE_ANTHROPIC_ERRORS.rejected],
      [401, SAFE_ANTHROPIC_ERRORS.rejectedKey],
      [403, SAFE_ANTHROPIC_ERRORS.rejectedKey],
      [429, SAFE_ANTHROPIC_ERRORS.rateLimited],
      [500, SAFE_ANTHROPIC_ERRORS.unavailable],
      [529, SAFE_ANTHROPIC_ERRORS.unavailable],
    ] as const) {
      const provider = new AnthropicProvider({
        fetchImpl: async () =>
          new Response(`{"error":{"message":"${secret}"}}`, { status }),
        getApiKey: async () => secret,
      });
      await expect(
        provider.complete(
          {
            modelId: "claude-sonnet-5",
            messages: [{ role: "user", content: "hello" }],
            tools: [],
          },
          new AbortController().signal,
        ),
      ).rejects.toThrow(message);
    }

    const aborting = new AnthropicProvider({
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
        modelId: "claude-sonnet-5",
        messages: [{ role: "user", content: "hello" }],
        tools: [],
      },
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toThrow(SAFE_ANTHROPIC_ERRORS.cancelled);

    const unknownTool = new AnthropicProvider({
      fetchImpl: async () =>
        sseResponse([
          `event: content_block_start\ndata: ${JSON.stringify({
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "tool_use",
              id: "call_9",
              name: "not_registered",
              input: {},
            },
          })}`,
          `event: message_stop\ndata: {"type":"message_stop"}`,
        ]),
      getApiKey: async () => secret,
    });
    await expect(
      unknownTool.complete(
        {
          modelId: "claude-sonnet-5",
          messages: [{ role: "user", content: "hello" }],
          tools: [],
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow(SAFE_ANTHROPIC_ERRORS.unknownTool);

    const truncated = new AnthropicProvider({
      fetchImpl: async () =>
        new Response('event: message_start\ndata: {"type":"message_start"', {
          status: 200,
        }),
      getApiKey: async () => secret,
    });
    await expect(
      truncated.complete(
        {
          modelId: "claude-sonnet-5",
          messages: [{ role: "user", content: "hello" }],
          tools: [],
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow(SAFE_ANTHROPIC_ERRORS.protocol);

    const malformed = new AnthropicProvider({
      fetchImpl: async () =>
        sseResponse(["event: message_start\ndata: {not-json}"]),
      getApiKey: async () => secret,
    });
    await expect(
      malformed.complete(
        {
          modelId: "claude-sonnet-5",
          messages: [{ role: "user", content: "hello" }],
          tools: [],
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow(SAFE_ANTHROPIC_ERRORS.protocol);
  });

  it("does not leak the API key in thrown errors", async () => {
    const secret = "sk-ant-should-never-appear";
    const provider = new AnthropicProvider({
      fetchImpl: async () =>
        new Response(`authorization ${secret}`, { status: 401 }),
      getApiKey: async () => secret,
    });
    await provider
      .complete(
        {
          modelId: "claude-sonnet-5",
          messages: [{ role: "user", content: "hello" }],
          tools: [],
        },
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
    const provider = new AnthropicProvider({
      fetchImpl,
      getApiKey: async () => "sk-ant-test",
    });
    await expect(
      provider.complete(
        {
          modelId: "claude-sonnet-5",
          messages: [{ role: "user", content: "hello" }],
          tools: [
            {
              id: `tool.${"x".repeat(ANTHROPIC_TOOL_NAME_MAX)}`,
              description: "Too long",
              inputSchema: { type: "object" },
            },
          ],
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow(SAFE_ANTHROPIC_ERRORS.unknownTool);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("times out with a safe message and does not leak secrets or bodies", async () => {
    const secret = "sk-ant-timeout-secret";
    const prompt = "secret prompt body that must not leak";
    const provider = new AnthropicProvider({
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
          modelId: "claude-sonnet-5",
          messages: [{ role: "user", content: prompt }],
          tools: [],
        },
        new AbortController().signal,
      )
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(SAFE_ANTHROPIC_ERRORS.timeout);
    const serialized = JSON.stringify(error, Object.getOwnPropertyNames(error));
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(prompt);
    expect(String(error)).not.toContain(secret);
    expect(String(error)).not.toContain(prompt);
  });

  it("fails as protocol when message_stop arrives with unfinished tool blocks", async () => {
    const provider = new AnthropicProvider({
      fetchImpl: async () =>
        sseResponse([
          `event: content_block_start\ndata: ${JSON.stringify({
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "tool_use",
              id: "call_trunc",
              name: "tools_echo",
              input: {},
            },
          })}`,
          `event: content_block_delta\ndata: ${JSON.stringify({
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: '{"text":' },
          })}`,
          `event: message_stop\ndata: {"type":"message_stop"}`,
        ]),
      getApiKey: async () => "sk-ant-test",
    });
    await expect(
      provider.complete(
        {
          modelId: "claude-sonnet-5",
          messages: [{ role: "user", content: "echo" }],
          tools: [
            {
              id: "tools.echo",
              description: "Echo",
              inputSchema: { type: "object" },
            },
          ],
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow(SAFE_ANTHROPIC_ERRORS.protocol);
  });
});

describe("borg.anthropic lifecycle", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("registers from a saved key without a network call and disposes on disconnect", async () => {
    const fetchImpl = vi.fn(async () => sseResponse(textStreamFrames()));
    const fixture = createAnthropicHarness({ hasKey: true, fetchImpl });
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
        `https://api.anthropic.com/v1/models/${ANTHROPIC_DEFAULT_MODEL}`,
      );
      expect(init?.body).toBeUndefined();
      return new Response(JSON.stringify({ id: ANTHROPIC_DEFAULT_MODEL }), {
        status: 200,
      });
    });
    const fixture = createAnthropicHarness({ fetchImpl });
    const harness = await fixture.activate();
    expect(fixture.providers).toHaveLength(0);
    fixture.secrets.set("apiKey", "sk-ant-test");
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
    const fixture = createAnthropicHarness({ hasKey: true, fetchImpl });
    const harness = await fixture.activate();
    expect(fixture.providers).toHaveLength(1);
    fixture.secrets.set("apiKey", "sk-ant-replaced");
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
    const fixture = createAnthropicHarness({ hasKey: true });
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
