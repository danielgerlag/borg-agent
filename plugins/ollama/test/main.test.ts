import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderDispatchPermit } from "@borg/plugin-sdk";
import { DEFAULT_OLLAMA_BASE_URL } from "../src/config";
import {
  OLLAMA_EGRESS,
  OllamaProvider,
  OllamaToolMap,
  SAFE_OLLAMA_ERRORS,
  buildOllamaRequest,
  resolveOllamaBaseUrl,
  resolveOllamaCompletionsUrl,
  resolveOllamaModelsUrl,
} from "../src/runtime";
import { createOllamaHarness } from "./harness";

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

function textStreamFrames(text = "Hello from Ollama"): string[] {
  return [
    `data: ${JSON.stringify({
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: text },
          finish_reason: null,
        },
      ],
    })}`,
    `data: ${JSON.stringify({
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    })}`,
    `data: ${JSON.stringify({
      choices: [],
      usage: { prompt_tokens: 4, completion_tokens: 3 },
    })}`,
    "data: [DONE]",
  ];
}

describe("Ollama request conversion", () => {
  it("omits token caps and keeps Chat Completions roles", () => {
    const tools = new OllamaToolMap();
    const body = buildOllamaRequest(
      {
        modelId: "llama3.2",
        messages: [
          { role: "system", content: "Be careful." },
          { role: "user", content: "hello" },
        ],
        tools: [],
      },
      tools,
    );
    expect(Object.hasOwn(body, "max_tokens")).toBe(false);
    expect(Object.hasOwn(body, "max_completion_tokens")).toBe(false);
    expect(body.stream).toBe(true);
    expect(body.messages).toEqual([
      { role: "system", content: "Be careful." },
      { role: "user", content: "hello" },
    ]);
  });
});

describe("Ollama endpoint gating", () => {
  it("rejects non-loopback hosts and gates the E2E override", () => {
    expect(resolveOllamaBaseUrl("", {})).toBe(DEFAULT_OLLAMA_BASE_URL);
    expect(() =>
      resolveOllamaBaseUrl("https://example.com/v1", {}),
    ).toThrow(SAFE_OLLAMA_ERRORS.invalidEndpoint);
    expect(() =>
      resolveOllamaBaseUrl(DEFAULT_OLLAMA_BASE_URL, {
        BORG_OLLAMA_ENDPOINT: "http://127.0.0.1:9/v1",
      }),
    ).toThrow(SAFE_OLLAMA_ERRORS.invalidEndpoint);
    expect(
      resolveOllamaBaseUrl(DEFAULT_OLLAMA_BASE_URL, {
        BORG_E2E: "1",
        BORG_OLLAMA_ENDPOINT: "http://127.0.0.1:9/v1",
      }),
    ).toBe("http://127.0.0.1:9/v1");
    expect(() =>
      resolveOllamaBaseUrl(DEFAULT_OLLAMA_BASE_URL, {
        BORG_E2E: "1",
        BORG_OLLAMA_ENDPOINT: "https://example.com/v1",
      }),
    ).toThrow(SAFE_OLLAMA_ERRORS.invalidEndpoint);
    expect(resolveOllamaCompletionsUrl(DEFAULT_OLLAMA_BASE_URL, {})).toBe(
      "http://localhost:11434/v1/chat/completions",
    );
    expect(resolveOllamaModelsUrl(DEFAULT_OLLAMA_BASE_URL, {})).toBe(
      "http://localhost:11434/v1/models",
    );
  });
});

describe("OllamaProvider", () => {
  it("commits immediately before fetch, sends no Authorization, and uses local egress", async () => {
    const dispatchOrder: string[] = [];
    const permit = createProviderDispatchPermit();
    permit.commit.mockImplementation(async () => {
      dispatchOrder.push("commit");
    });
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      dispatchOrder.push("fetch");
      expect(String(url)).toBe("http://localhost:11434/v1/chat/completions");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBeNull();
      expect(init?.redirect).toBe("error");
      return sseResponse(textStreamFrames());
    });
    const provider = new OllamaProvider({
      fetchImpl,
      env: {},
      models: ["llama3.2"],
    });
    expect(provider.egress).toEqual(OLLAMA_EGRESS);
    const result = await provider.complete(
      {
        modelId: "llama3.2",
        messages: [{ role: "user", content: "hello" }],
        tools: [],
      },
      permit,
      new AbortController().signal,
    );
    expect(dispatchOrder).toEqual(["commit", "fetch"]);
    expect(result.content).toBe("Hello from Ollama");
    expect(result.usage.amount).toBeUndefined();
  });

  it("maps 401/403/429/5xx without leaking bodies", async () => {
    const secret = "ollama-should-not-leak";
    for (const [status, message] of [
      [401, SAFE_OLLAMA_ERRORS.rejected],
      [403, SAFE_OLLAMA_ERRORS.rejected],
      [429, SAFE_OLLAMA_ERRORS.rateLimited],
      [500, SAFE_OLLAMA_ERRORS.unavailable],
    ] as const) {
      const provider = new OllamaProvider({
        fetchImpl: async () => new Response(`{"error":"${secret}"}`, { status }),
        env: {},
      });
      await expect(
        provider.complete(
          {
            modelId: "llama3.2",
            messages: [{ role: "user", content: "hello" }],
            tools: [],
          },
          createProviderDispatchPermit(),
          new AbortController().signal,
        ),
      ).rejects.toThrow(message);
    }
  });

  it("times out with a safe message", async () => {
    const provider = new OllamaProvider({
      timeoutMs: 20,
      env: {},
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
    });
    await expect(
      provider.complete(
        {
          modelId: "llama3.2",
          messages: [{ role: "user", content: "hello" }],
          tools: [],
        },
        createProviderDispatchPermit(),
        new AbortController().signal,
      ),
    ).rejects.toThrow(SAFE_OLLAMA_ERRORS.timeout);
  });
});

describe("borg.ollama lifecycle", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("registers from nonempty models without a network call", async () => {
    const fetchImpl = vi.fn(async () => sseResponse(textStreamFrames()));
    const fixture = createOllamaHarness({
      models: ["llama3.2"],
      fetchImpl,
    });
    const harness = await fixture.activate();
    expect(fixture.providers).toHaveLength(1);
    expect(await fixture.invokeStatus()).toEqual({
      connected: true,
      modelCount: 1,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    await fixture.invokeDisconnect();
    expect(fixture.providers).toHaveLength(0);
    await harness.deactivate();
    fixture.restoreFetch();
  });

  it("connects against /models, persists ids, and uses local egress", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("GET");
      expect(String(url)).toBe("http://localhost:11434/v1/models");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBeNull();
      return new Response(
        JSON.stringify({ data: [{ id: "llama3.2" }, { id: "mistral" }] }),
        { status: 200 },
      );
    });
    const fixture = createOllamaHarness({ fetchImpl });
    const harness = await fixture.activate();
    expect(fixture.providers).toHaveLength(0);
    await fixture.invokeConnect();
    expect(fixture.getConfig().models).toEqual(["llama3.2", "mistral"]);
    expect(fixture.providers).toHaveLength(1);
    expect(fixture.providers[0]?.egress).toEqual(OLLAMA_EGRESS);
    expect(await fixture.invokeStatus()).toEqual({
      connected: true,
      modelCount: 2,
    });
    await harness.deactivate();
    fixture.restoreFetch();
  });
});
