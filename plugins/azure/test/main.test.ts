import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderDispatchPermit } from "@borg/plugin-sdk";
import {
  AZURE_IMDS_TOKEN_URL,
  AzureProvider,
  AzureToolMap,
  AzureUserError,
  SAFE_AZURE_ERRORS,
  buildAzureRequest,
  classifyAzureStatus,
  createAzureTokenAcquirer,
  azureTokenResource,
  formatAzureUserError,
  foundryProjectBase,
  foundryResourceUrl,
  parseAzureErrorBody,
  parseAzureUserError,
  parseFoundryDeployments,
  resolveAzureCompletionsUrl,
  resolveAzureModelsUrl,
} from "../src/runtime";
import { createAzureHarness } from "./harness";

function azureMessage(key: keyof typeof SAFE_AZURE_ERRORS): string {
  return formatAzureUserError(SAFE_AZURE_ERRORS[key]);
}

function expectAzureUserError(
  error: unknown,
  key: keyof typeof SAFE_AZURE_ERRORS,
): void {
  expect(error).toBeInstanceOf(AzureUserError);
  expect(error).toMatchObject(SAFE_AZURE_ERRORS[key]);
  expect(String(error)).not.toMatch(/borg\.azure\./);
}

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
              { index: 0, function: { arguments: '{"text":"hi"}' } },
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
  const foundry =
    "https://demo.services.ai.azure.com/api/projects/foo";

  it("keeps the project path and lists deployments, not the catalog", () => {
    expect(foundryResourceUrl(`${RESOURCE}/`)).toBe(RESOURCE);
    expect(foundryProjectBase(foundry)).toBe(foundry);
    expect(foundryResourceUrl(foundry)).toBe(foundry);
    expect(azureTokenResource(foundry)).toBe("https://ai.azure.com");
    expect(azureTokenResource(RESOURCE)).toBe(
      "https://cognitiveservices.azure.com",
    );
    expect(resolveAzureCompletionsUrl(RESOURCE)).toBe(
      `${RESOURCE}/openai/v1/chat/completions`,
    );
    expect(resolveAzureCompletionsUrl(foundry)).toBe(
      `${foundry}/openai/v1/chat/completions`,
    );
    expect(resolveAzureModelsUrl(foundry)).toBe(
      `${foundry}/deployments?api-version=v1`,
    );
    expect(resolveAzureModelsUrl(RESOURCE, "v1")).toBe(
      `${RESOURCE}/openai/v1/models?api-version=v1`,
    );
    expect(() => resolveAzureCompletionsUrl("http://example.com")).toThrow(
      azureMessage("invalidEndpoint"),
    );
  });

  it("parses project deployments and skips non-chat rows", () => {
    expect(
      parseFoundryDeployments({
        value: [
          {
            name: "gpt-4o",
            type: "ModelDeployment",
            capabilities: { chat_completion: "true" },
          },
          {
            name: "dall-e-3",
            type: "ModelDeployment",
            capabilities: { chat_completion: "false" },
          },
          {
            name: "embedding",
            type: "Connection",
          },
        ],
      }),
    ).toEqual(["gpt-4o"]);
  });
});

describe("Azure request conversion", () => {
  it("omits token caps and maps tool roles reversibly", () => {
    const tools = new AzureToolMap();
    const body = buildAzureRequest(
      {
        modelId: "gpt-4o",
        messages: [
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
    expect(Object.hasOwn(body, "max_tokens")).toBe(false);
    expect(Object.hasOwn(body, "max_completion_tokens")).toBe(false);
    expect(body.stream).toBe(true);
    expect(tools.resolve("tools_echo")).toBe("tools.echo");
    expect(() => tools.alias("tools_echo")).toThrow(azureMessage("unknownTool"));
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

  it("requests a Foundry token for project endpoints", async () => {
    const execFile = vi.fn(async (file: string, args: readonly string[]) => {
      expect(file).toBe("az");
      expect(args).toEqual([
        "account",
        "get-access-token",
        "--resource",
        "https://ai.azure.com",
        "--output",
        "json",
      ]);
      return JSON.stringify({
        accessToken: "foundry-token",
        expires_on: 2_000_000_000,
      });
    });
    const acquire = createAzureTokenAcquirer({
      env: { BORG_AZURE_SKIP_MANAGED_IDENTITY: "1" },
      resource: "https://ai.azure.com",
      fetchImpl: vi.fn(),
      execFile,
      now: () => 1_000_000_000_000,
    });
    expect((await acquire()).accessToken).toBe("foundry-token");
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

  it("treats IDENTITY_ENDPOINT as hosted and skips the IMDS probe", async () => {
    const probeImds = vi.fn(async () => false);
    const fetchImpl = vi.fn(async () =>
      new Response(
        JSON.stringify({ access_token: "hosted-imds", expires_on: 2_000_000_000 }),
        { status: 200 },
      ),
    );
    const acquire = createAzureTokenAcquirer({
      env: { IDENTITY_ENDPOINT: "http://169.254.169.254/metadata" },
      fetchImpl,
      probeImds,
      execFile: vi.fn(),
      now: () => 1_000_000_000_000,
    });
    expect((await acquire()).accessToken).toBe("hosted-imds");
    expect(probeImds).not.toHaveBeenCalled();
  });

  it("falls through to az when IMDS returns a non-success status", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 }));
    const execFile = vi.fn(async () =>
      JSON.stringify({ accessToken: "az-after-imds", expiresOn: "2000000000" }),
    );
    const acquire = createAzureTokenAcquirer({
      env: {},
      fetchImpl,
      probeImds: async () => true,
      execFile,
      now: () => 1_000_000_000_000,
    });
    expect((await acquire()).accessToken).toBe("az-after-imds");
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
    const error = await acquire().catch((failure: unknown) => failure);
    expectAzureUserError(error, "missingCredential");
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
    expectAzureUserError(error, "rejectedKey");
    expect(error.message).toBe(azureMessage("rejectedKey"));
    expect(String(error)).not.toContain(secret);
  });

  it("maps 400/403/429/5xx, abort, timeout, and protocol failures", async () => {
    const secret = "azure-secret-value";
    for (const [status, key] of [
      [400, "rejected"],
      [403, "rejectedKey"],
      [429, "rateLimited"],
      [500, "unavailable"],
      [529, "unavailable"],
    ] as const) {
      const provider = new AzureProvider({
        fetchImpl: async () =>
          new Response(`{"error":{"message":"${secret}"}}`, { status }),
        endpoint: RESOURCE,
        authMode: "api-key",
        getApiKey: async () => secret,
      });
      await expect(
        provider.complete(
          {
            modelId: "gpt-4o",
            messages: [{ role: "user", content: "hello" }],
            tools: [],
          },
          createProviderDispatchPermit(),
          new AbortController().signal,
        ),
      ).rejects.toThrow(azureMessage(key));
    }

    const aborted = new AbortController();
    aborted.abort();
    const aborting = new AzureProvider({
      fetchImpl: vi.fn(),
      endpoint: RESOURCE,
      authMode: "api-key",
      getApiKey: async () => secret,
    });
    await expect(
      aborting.complete(
        {
          modelId: "gpt-4o",
          messages: [{ role: "user", content: "hello" }],
          tools: [],
        },
        createProviderDispatchPermit(),
        aborted.signal,
      ),
    ).rejects.toThrow(azureMessage("cancelled"));

    const timingOut = new AzureProvider({
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
      endpoint: RESOURCE,
      authMode: "api-key",
      getApiKey: async () => secret,
    });
    await expect(
      timingOut.complete(
        {
          modelId: "gpt-4o",
          messages: [{ role: "user", content: "hello" }],
          tools: [],
        },
        createProviderDispatchPermit(),
        new AbortController().signal,
      ),
    ).rejects.toThrow(azureMessage("timeout"));

    const malformed = new AzureProvider({
      fetchImpl: async () => sseResponse(["data: {not-json}"]),
      endpoint: RESOURCE,
      authMode: "api-key",
      getApiKey: async () => secret,
    });
    await expect(
      malformed.complete(
        {
          modelId: "gpt-4o",
          messages: [{ role: "user", content: "hello" }],
          tools: [],
        },
        createProviderDispatchPermit(),
        new AbortController().signal,
      ),
    ).rejects.toThrow(azureMessage("protocol"));
  });

  it("maps streamed tool calls", async () => {
    const fetchImpl = vi.fn(async () => sseResponse(toolStreamFrames()));
    const provider = new AzureProvider({
      fetchImpl,
      endpoint: RESOURCE,
      authMode: "api-key",
      models: ["gpt-4o"],
      getApiKey: async () => "azure-test-key",
    });
    const first = await provider.complete(
      {
        modelId: "gpt-4o",
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

  it("throws missingKey before fetch when the vault is empty", async () => {
    const fetchImpl = vi.fn();
    const provider = new AzureProvider({
      fetchImpl,
      endpoint: RESOURCE,
      authMode: "api-key",
      getApiKey: async () => undefined,
    });
    await expect(
      provider.complete(
        {
          modelId: "gpt-4o",
          messages: [{ role: "user", content: "hello" }],
          tools: [],
        },
        createProviderDispatchPermit(),
        new AbortController().signal,
      ),
    ).rejects.toThrow(azureMessage("missingKey"));
    expect(fetchImpl).not.toHaveBeenCalled();
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
      expect(String(url)).toBe(`${RESOURCE}/openai/v1/models`);
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

describe("AzureUserError", () => {
  it("encodes headline and next step for IPC and parses them back", () => {
    for (const parts of Object.values(SAFE_AZURE_ERRORS)) {
      const encoded = formatAzureUserError(parts);
      expect(encoded).toBe(`${parts.headline}\n${parts.nextStep}`);
      expect(encoded).not.toMatch(/borg\.azure\./);
      expect(parseAzureUserError(encoded)).toEqual(parts);
    }
  });

  it("hides kernel command wrapping from the settings UI", () => {
    expect(parseAzureUserError("Command borg.azure.connect failed")).toEqual({
      headline: "Azure could not connect.",
      nextStep:
        "Check the endpoint, API version, and credentials, then try Verify and connect again.",
    });
  });

  it("classifies 400 API version bodies without echoing them", () => {
    const secret = "azure-secret-value";
    const payload = {
      error: {
        code: "InvalidApiVersionParameter",
        message: `The API version '2024-10-21' is not supported. ${secret}`,
      },
    };
    expect(parseAzureErrorBody(payload)).toEqual({
      code: "InvalidApiVersionParameter",
      message: `The API version '2024-10-21' is not supported. ${secret}`,
    });
    const error = classifyAzureStatus(400, payload);
    expectAzureUserError(error, "rejectedApiVersion");
    expect(String(error)).not.toContain(secret);
    expect(classifyAzureStatus(400, { error: { message: secret } })).toMatchObject(
      SAFE_AZURE_ERRORS.rejected,
    );
    expect(classifyAzureStatus(401)).toMatchObject(SAFE_AZURE_ERRORS.rejectedKey);
  });
});

describe("Azure verify user errors", () => {
  it("maps missing Azure Identity credentials to a headline and next step", async () => {
    const fetchImpl = vi.fn();
    const provider = new AzureProvider({
      fetchImpl,
      endpoint: RESOURCE,
      authMode: "azure-default",
      acquireAzureToken: createAzureTokenAcquirer({
        env: { BORG_AZURE_SKIP_MANAGED_IDENTITY: "yes" },
        fetchImpl,
        probeImds: vi.fn(),
        execFile: async () => {
          throw new Error("missing");
        },
      }),
      getApiKey: async () => undefined,
    });
    const error = await provider.verify().catch((failure: unknown) => failure);
    expectAzureUserError(error, "missingCredential");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("maps 401 verify to a credentials headline without leaking the body", async () => {
    const secret = "azure-secret-value";
    const provider = new AzureProvider({
      fetchImpl: async () =>
        new Response(`{"error":{"message":"${secret}"}}`, { status: 401 }),
      endpoint: RESOURCE,
      authMode: "api-key",
      getApiKey: async () => secret,
    });
    const error = await provider.verify().catch((failure: unknown) => failure);
    expectAzureUserError(error, "rejectedKey");
    expect(String(error)).not.toContain(secret);
  });

  it("maps a 400 API version body to a two-line API version error", async () => {
    const secret = "azure-secret-value";
    const provider = new AzureProvider({
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            error: {
              code: "InvalidApiVersionParameter",
              message: `The API version '2024-10-21' is not supported. ${secret}`,
            },
          }),
          { status: 400 },
        ),
      endpoint: RESOURCE,
      authMode: "api-key",
      getApiKey: async () => secret,
    });
    const error = await provider.verify().catch((failure: unknown) => failure);
    expectAzureUserError(error, "rejectedApiVersion");
    expect(String(error)).not.toContain(secret);
  });

  it("maps an empty catalog to a deploy-a-model next step", async () => {
    const provider = new AzureProvider({
      fetchImpl: async () =>
        new Response(JSON.stringify({ data: [] }), { status: 200 }),
      endpoint: RESOURCE,
      authMode: "api-key",
      getApiKey: async () => "azure-test-key",
    });
    const error = await provider.verify().catch((failure: unknown) => failure);
    expectAzureUserError(error, "emptyCatalog");
  });

  it("lists Foundry project deployments instead of the account catalog", async () => {
    const foundry = "https://demo.services.ai.azure.com/api/projects/foo";
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      expect(String(url)).toBe(`${foundry}/deployments?api-version=v1`);
      return new Response(
        JSON.stringify({
          value: [
            {
              name: "gpt-4o",
              type: "ModelDeployment",
              capabilities: { chat_completion: "true" },
            },
            {
              name: "dall-e-3",
              type: "ModelDeployment",
              capabilities: { chat_completion: "false" },
            },
          ],
        }),
        { status: 200 },
      );
    });
    const provider = new AzureProvider({
      fetchImpl,
      endpoint: foundry,
      authMode: "api-key",
      getApiKey: async () => "azure-test-key",
    });
    await expect(provider.verify()).resolves.toEqual(["gpt-4o"]);
  });
});

describe("azureConnect user errors", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects Verify and connect when the API key is missing", async () => {
    const fixture = createAzureHarness({ endpoint: RESOURCE });
    const harness = await fixture.activate();
    const error = await fixture.invokeConnect().catch((failure: unknown) => failure);
    expectAzureUserError(error, "missingKey");
    await harness.deactivate();
    fixture.restoreFetch();
  });

  it("surfaces 401 from Verify and connect", async () => {
    const secret = "azure-secret-value";
    const fetchImpl = vi.fn(
      async () =>
        new Response(`{"error":{"message":"${secret}"}}`, { status: 401 }),
    );
    const fixture = createAzureHarness({ endpoint: RESOURCE, fetchImpl });
    const harness = await fixture.activate();
    fixture.secrets.set("apiKey", secret);
    const error = await fixture.invokeConnect().catch((failure: unknown) => failure);
    expectAzureUserError(error, "rejectedKey");
    expect(String(error)).not.toContain(secret);
    await harness.deactivate();
    fixture.restoreFetch();
  });

  it("surfaces a 400 API version body from Verify and connect", async () => {
    const secret = "azure-secret-value";
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              innererror: { code: "UnsupportedApiVersion" },
              message: `Unrecognized api-version. ${secret}`,
            },
          }),
          { status: 400 },
        ),
    );
    const fixture = createAzureHarness({ endpoint: RESOURCE, fetchImpl });
    const harness = await fixture.activate();
    fixture.secrets.set("apiKey", secret);
    const error = await fixture.invokeConnect().catch((failure: unknown) => failure);
    expectAzureUserError(error, "rejectedApiVersion");
    expect(String(error)).not.toContain(secret);
    await harness.deactivate();
    fixture.restoreFetch();
  });

  it("surfaces an empty catalog from Verify and connect", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );
    const fixture = createAzureHarness({ endpoint: RESOURCE, fetchImpl });
    const harness = await fixture.activate();
    fixture.secrets.set("apiKey", "azure-test-key");
    const error = await fixture.invokeConnect().catch((failure: unknown) => failure);
    expectAzureUserError(error, "emptyCatalog");
    await harness.deactivate();
    fixture.restoreFetch();
  });
});

describe("Azure settings error UI", () => {
  it("declares a distinct headline and next-step alert", async () => {
    const source = await readFile(new URL("../src/ui.tsx", import.meta.url), "utf8");
    expect(source).toContain('data-testid="azure-error"');
    expect(source).toContain('data-testid="azure-error-headline"');
    expect(source).toContain('data-testid="azure-error-next-step"');
    expect(source).toContain("parseAzureUserError");
    expect(source).not.toMatch(/error\(\)\s*\?\?/);
  });
});

