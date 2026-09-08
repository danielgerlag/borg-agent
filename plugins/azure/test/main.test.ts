import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderDispatchPermit } from "@borg/plugin-sdk";
import {
  AZURE_IMDS_TOKEN_URL,
  AzureProvider,
  AzureToolMap,
  SAFE_AZURE_ERRORS,
  buildAzureRequest,
  createAzureTokenAcquirer,
  foundryResourceUrl,
  resolveAzureCompletionsUrl,
  resolveAzureModelsUrl,
} from "../src/runtime";
import { createAzureHarness } from "./harness";

const RESOURCE = "https://demo.openai.azure.com";

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

function textStreamFrames(text = "Hello from Azure"): string[] {
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
      usage: { prompt_tokens: 5, completion_tokens: 4 },
    })}`,
    "data: [DONE]",
  ];
}

describe("Azure Foundry URL", () => {
  it("strips /api/projects/ and rejects non-https endpoints", () => {
    expect(foundryResourceUrl(`${RESOURCE}/`)).toBe(RESOURCE);
    expect(
      foundryResourceUrl("https://ai.azure.com/api/projects/my-project"),
    ).toBe("https://ai.azure.com");
    expect(resolveAzureCompletionsUrl(RESOURCE)).toBe(
      `${RESOURCE}/openai/v1/chat/completions?api-version=2024-10-21`,
    );
    expect(
      resolveAzureModelsUrl("https://ai.azure.com/api/projects/foo"),
    ).toBe(
      "https://ai.azure.com/openai/v1/models?api-version=2024-10-21",
    );
    expect(() => resolveAzureCompletionsUrl("http://example.com")).toThrow(
      SAFE_AZURE_ERRORS.invalidEndpoint,
    );
  });
});

describe("Azure request conversion", () => {
  it("omits token caps", () => {
    const body = buildAzureRequest(
      {
        modelId: "gpt-4o",
        messages: [{ role: "user", content: "hello" }],
        tools: [],
      },
      new AzureToolMap(),
    );
    expect(Object.hasOwn(body, "max_tokens")).toBe(false);
    expect(Object.hasOwn(body, "max_completion_tokens")).toBe(false);
    expect(body.stream).toBe(true);
  });
});

describe("Azure token acquirer", () => {
  it("skips IMDS on laptops and falls through to az", async () => {
    const fetchImpl = vi.fn();
    const probeImds = vi.fn(async () => false);
    const execFile = vi.fn(async (file: string) => {
      expect(file).toBe("az");
      return JSON.stringify({
        accessToken: "az-token",
        expires_on: 2_000_000_000,
      });
    });
    const acquire = createAzureTokenAcquirer({
      env: {},
      fetchImpl,
      probeImds,
      execFile,
      now: () => 1_000_000_000_000,
    });
    const token = await acquire();
    expect(token.accessToken).toBe("az-token");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(probeImds).toHaveBeenCalledOnce();
  });

  it("does not probe IMDS when skip env is set", async () => {
    const probeImds = vi.fn(async () => true);
    const fetchImpl = vi.fn();
    const execFile = vi.fn(async () =>
      JSON.stringify({ accessToken: "az-token", expires_on: 2_000_000_000 }),
    );
    const acquire = createAzureTokenAcquirer({
      env: { BORG_AZURE_SKIP_MANAGED_IDENTITY: "1" },
      fetchImpl,
      probeImds,
      execFile,
      now: () => 1_000_000_000_000,
    });
    await acquire();
    expect(probeImds).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("uses IMDS when the probe succeeds", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(String(url)).toBe(AZURE_IMDS_TOKEN_URL);
      expect(new Headers(init?.headers).get("metadata")).toBe("true");
      return new Response(
        JSON.stringify({
          access_token: "imds-token",
          expires_on: "2000000000",
        }),
        { status: 200 },
      );
    });
    const execFile = vi.fn();
    const acquire = createAzureTokenAcquirer({
      env: {},
      fetchImpl,
      probeImds: async () => true,
      execFile,
      now: () => 1_000_000_000_000,
    });
    expect((await acquire()).accessToken).toBe("imds-token");
    expect(execFile).not.toHaveBeenCalled();
  });

  it("falls through to azd and caches until the 5 minute skew", async () => {
    let now = 1_000_000_000_000;
    const execFile = vi.fn(async (file: string) => {
      if (file === "az") {
        throw new Error("az missing");
      }
      expect(file).toBe("azd");
      return "azd-token\n";
    });
    const acquire = createAzureTokenAcquirer({
      env: { BORG_AZURE_SKIP_MANAGED_IDENTITY: "true" },
      fetchImpl: vi.fn(),
      probeImds: vi.fn(),
      execFile,
      now: () => now,
    });
    expect((await acquire()).accessToken).toBe("azd-token");
    expect((await acquire()).accessToken).toBe("azd-token");
    expect(execFile).toHaveBeenCalledTimes(2);
    now = 1_000_000_000_000 + 3_600_000 - 4 * 60_000;
    await acquire();
    expect(execFile).toHaveBeenCalledTimes(4);
  });

  it("fails with a login hint when az and azd are unavailable", async () => {
    const acquire = createAzureTokenAcquirer({
      env: { BORG_AZURE_SKIP_MANAGED_IDENTITY: "yes" },
      fetchImpl: vi.fn(),
      probeImds: vi.fn(),
      execFile: async () => {
        throw new Error("missing");
      },
    });
    await expect(acquire()).rejects.toThrow(SAFE_AZURE_ERRORS.missingCredential);
  });
});

describe("AzureProvider", () => {
  it("sends api-key and never Bearer in api-key mode", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("api-key")).toBe("azure-test-key");
      expect(headers.get("authorization")).toBeNull();
      expect(init?.redirect).toBe("error");
      return sseResponse(textStreamFrames());
    });
    const acquireAzureToken = vi.fn(async () => ({
      accessToken: "should-not-be-used",
      expiresAtMs: Date.now() + 60_000,
    }));
    const provider = new AzureProvider({
      fetchImpl,
      endpoint: RESOURCE,
      authMode: "api-key",
      models: ["gpt-4o"],
      acquireAzureToken,
      getApiKey: async () => "azure-test-key",
    });
    const result = await provider.complete(
      {
        modelId: "gpt-4o",
        messages: [{ role: "user", content: "hello" }],
        tools: [],
      },
      createProviderDispatchPermit(),
      new AbortController().signal,
    );
    expect(result.content).toBe("Hello from Azure");
    expect(acquireAzureToken).not.toHaveBeenCalled();
    expect(provider.egress.kind).toBe("remote");
    if (provider.egress.kind === "remote") {
      expect(provider.egress.destination).toContain(
        "/openai/v1/chat/completions",
      );
    }
  });

  it("sends Bearer for azure-default and never api-key", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe("Bearer azure-ad-token");
      expect(headers.get("api-key")).toBeNull();
      return sseResponse(textStreamFrames());
    });
    const provider = new AzureProvider({
      fetchImpl,
      endpoint: RESOURCE,
      authMode: "azure-default",
      models: ["gpt-4o"],
      acquireAzureToken: async () => ({
        accessToken: "azure-ad-token",
        expiresAtMs: Date.now() + 3_600_000,
      }),
      getApiKey: async () => "should-not-be-used",
    });
    await provider.complete(
      {
        modelId: "gpt-4o",
        messages: [{ role: "user", content: "hello" }],
        tools: [],
      },
      createProviderDispatchPermit(),
      new AbortController().signal,
    );
  });

  it("maps status codes without leaking secrets", async () => {
    const secret = "azure-secret-value";
    const provider = new AzureProvider({
      fetchImpl: async () =>
        new Response(`{"error":{"message":"${secret}"}}`, { status: 401 }),
      endpoint: RESOURCE,
      authMode: "api-key",
      getApiKey: async () => secret,
    });
    const error = await provider
      .complete(
        {
          modelId: "gpt-4o",
          messages: [{ role: "user", content: "hello" }],
          tools: [],
        },
        createProviderDispatchPermit(),
        new AbortController().signal,
      )
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) {
      throw error;
    }
    expect(error.message).toBe(SAFE_AZURE_ERRORS.rejectedKey);
    expect(String(error)).not.toContain(secret);
  });
});

describe("borg.azure lifecycle", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("restores api-key registration from a saved key and models without fetching", async () => {
    const fetchImpl = vi.fn();
    const fixture = createAzureHarness({
      hasKey: true,
      endpoint: RESOURCE,
      models: ["gpt-4o"],
      fetchImpl,
    });
    const harness = await fixture.activate();
    expect(fixture.providers).toHaveLength(1);
    expect(await fixture.invokeStatus()).toEqual({
      hasKey: true,
      connected: true,
      authMode: "api-key",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    await harness.deactivate();
    fixture.restoreFetch();
  });

  it("restores azure-default registration from models without fetching", async () => {
    const fetchImpl = vi.fn();
    const fixture = createAzureHarness({
      authMode: "azure-default",
      endpoint: RESOURCE,
      models: ["gpt-4o"],
      fetchImpl,
    });
    const harness = await fixture.activate();
    expect(fixture.providers).toHaveLength(1);
    expect(await fixture.invokeStatus()).toEqual({
      hasKey: false,
      connected: true,
      authMode: "azure-default",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    await harness.deactivate();
    fixture.restoreFetch();
  });

  it("verifies api-key connect against Foundry models and persists ids", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("GET");
      expect(String(url)).toBe(
        `${RESOURCE}/openai/v1/models?api-version=2024-10-21`,
      );
      const headers = new Headers(init?.headers);
      expect(headers.get("api-key")).toBe("azure-test-key");
      expect(headers.get("authorization")).toBeNull();
      return new Response(JSON.stringify({ data: [{ id: "gpt-4o" }] }), {
        status: 200,
      });
    });
    const fixture = createAzureHarness({
      endpoint: RESOURCE,
      fetchImpl,
    });
    const harness = await fixture.activate();
    fixture.secrets.set("apiKey", "azure-test-key");
    await fixture.invokeConnect();
    expect(fixture.getConfig().models).toEqual(["gpt-4o"]);
    expect(fixture.providers).toHaveLength(1);
    await harness.deactivate();
    fixture.restoreFetch();
  });
});
