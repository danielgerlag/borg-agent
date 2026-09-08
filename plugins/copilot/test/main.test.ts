import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProviderDispatchPermit } from "@borg/plugin-sdk";
import {
  COPILOT_CLIENT_ID,
  COPILOT_COMPLETIONS_URL,
  COPILOT_MODELS_URL,
  COPILOT_SESSION_TOKEN_URL,
  CopilotProvider,
  CopilotToolMap,
  SAFE_COPILOT_ERRORS,
  buildCopilotRequest,
  resolveCopilotOauthToken,
} from "../src/runtime";
import { createCopilotHarness } from "./harness";

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

function textStreamFrames(text = "Hello from Copilot"): string[] {
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
      usage: { prompt_tokens: 6, completion_tokens: 4 },
    })}`,
    "data: [DONE]",
  ];
}

describe("Copilot request conversion", () => {
  it("omits token caps", () => {
    const body = buildCopilotRequest(
      {
        modelId: "gpt-4o",
        messages: [{ role: "user", content: "hello" }],
        tools: [],
      },
      new CopilotToolMap(),
    );
    expect(Object.hasOwn(body, "max_tokens")).toBe(false);
    expect(Object.hasOwn(body, "max_completion_tokens")).toBe(false);
  });
});

describe("Copilot oauth fallback", () => {
  it("uses secret, then GITHUB_TOKEN, then GH_TOKEN", async () => {
    expect(
      await resolveCopilotOauthToken({
        getSecret: async () => "secret-token",
        env: { GITHUB_TOKEN: "github", GH_TOKEN: "gh" },
      }),
    ).toBe("secret-token");
    expect(
      await resolveCopilotOauthToken({
        getSecret: async () => undefined,
        env: { GITHUB_TOKEN: "github", GH_TOKEN: "gh" },
      }),
    ).toBe("github");
    expect(
      await resolveCopilotOauthToken({
        getSecret: async () => undefined,
        env: { GH_TOKEN: "gh" },
      }),
    ).toBe("gh");
  });
});

describe("CopilotProvider", () => {
  it("exchanges a session token, caches with 60s skew, and sets Copilot headers", async () => {
    let now = 1_700_000_000_000;
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const target = String(url);
      if (target === COPILOT_SESSION_TOKEN_URL) {
        const headers = new Headers(init?.headers);
        expect(headers.get("authorization")).toBe("token gho-test-token");
        expect(headers.get("user-agent")).toBe("borg-desktop");
        return new Response(
          JSON.stringify({ token: "session-token", expires_at: 1_700_000_120 }),
          { status: 200 },
        );
      }
      if (target === COPILOT_COMPLETIONS_URL) {
        const headers = new Headers(init?.headers);
        expect(headers.get("authorization")).toBe("Bearer session-token");
        expect(headers.get("editor-version")).toBe("Borg/0.1.0");
        expect(headers.get("editor-plugin-version")).toBe("copilot/0.1.0");
        expect(headers.get("copilot-integration-id")).toBe("vscode-chat");
        expect(init?.redirect).toBe("error");
        return sseResponse(textStreamFrames());
      }
      throw new Error(`unexpected ${target}`);
    });
    const provider = new CopilotProvider({
      fetchImpl,
      env: {},
      now: () => now,
      models: ["gpt-4o"],
      getOauthToken: async () => "gho-test-token",
    });
    const permit = createProviderDispatchPermit();
    const result = await provider.complete(
      {
        modelId: "gpt-4o",
        messages: [{ role: "user", content: "hello" }],
        tools: [],
      },
      permit,
      new AbortController().signal,
    );
    expect(permit.commit).toHaveBeenCalledOnce();
    expect(result.content).toBe("Hello from Copilot");
    expect(
      fetchImpl.mock.calls.filter(([url]) => String(url) === COPILOT_SESSION_TOKEN_URL),
    ).toHaveLength(1);
  });

  it("reuses a session token when expires_at is more than 60s away", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url) === COPILOT_SESSION_TOKEN_URL) {
        return new Response(
          JSON.stringify({
            token: "session-token",
            expires_at: Math.floor(1_700_000_000_000 / 1000) + 120,
          }),
          { status: 200 },
        );
      }
      return sseResponse(textStreamFrames());
    });
    const provider = new CopilotProvider({
      fetchImpl,
      env: {},
      now: () => 1_700_000_000_000,
      getOauthToken: async () => "gho-test-token",
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
    await provider.complete(
      {
        modelId: "gpt-4o",
        messages: [{ role: "user", content: "hello" }],
        tools: [],
      },
      createProviderDispatchPermit(),
      new AbortController().signal,
    );
    expect(
      fetchImpl.mock.calls.filter(([url]) => String(url) === COPILOT_SESSION_TOKEN_URL),
    ).toHaveLength(1);
  });

  it("falls back to GITHUB_TOKEN when the secret is missing", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url) === COPILOT_SESSION_TOKEN_URL) {
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "token env-github",
        );
        return new Response(
          JSON.stringify({ token: "session-token", expires_at: 2_000_000_000 }),
          { status: 200 },
        );
      }
      return sseResponse(textStreamFrames());
    });
    const provider = new CopilotProvider({
      fetchImpl,
      env: { GITHUB_TOKEN: "env-github" },
      getOauthToken: async () => undefined,
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
});

describe("borg.copilot lifecycle and device flow", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("keeps device_code in main and writes the secret without returning tokens", async () => {
    vi.stubEnv("GITHUB_TOKEN", "");
    vi.stubEnv("GH_TOKEN", "");
    const deviceCode = "device-code-secret";
    const accessToken = "gho-access-secret";
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const target = String(url);
      if (target.includes("/login/device/code")) {
        const body = String(init?.body);
        expect(body).toContain(`client_id=${COPILOT_CLIENT_ID}`);
        expect(body).toContain("scope=copilot");
        return new Response(
          JSON.stringify({
            device_code: deviceCode,
            user_code: "ABCD-EFGH",
            verification_uri: "https://github.com/login/device",
            expires_in: 900,
            interval: 5,
          }),
          { status: 200 },
        );
      }
      if (target.includes("/login/oauth/access_token")) {
        expect(String(init?.body)).toContain(`device_code=${deviceCode}`);
        return new Response(
          JSON.stringify({ access_token: accessToken, token_type: "bearer" }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected ${target}`);
    });
    const fixture = createCopilotHarness({ fetchImpl });
    const harness = await fixture.activate();
    const started = await fixture.invokeStartDeviceFlow();
    const startedJson = JSON.stringify(started);
    expect(started).toEqual({
      userCode: "ABCD-EFGH",
      verificationUri: "https://github.com/login/device",
      interval: 5,
      expiresIn: 900,
    });
    expect(startedJson).not.toContain(deviceCode);
    expect(startedJson).not.toContain(accessToken);

    const polled = await fixture.invokePollDeviceFlow();
    const polledJson = JSON.stringify(polled);
    expect(polled).toEqual({ status: "complete" });
    expect(polledJson).not.toContain(deviceCode);
    expect(polledJson).not.toContain(accessToken);
    expect(fixture.secrets.get("githubOauthToken")).toBe(accessToken);
    await harness.deactivate();
    fixture.restoreFetch();
  });

  it("treats authorization_pending as pending and expired_token as failed", async () => {
    vi.stubEnv("GITHUB_TOKEN", "");
    vi.stubEnv("GH_TOKEN", "");
    let polls = 0;
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      const target = String(url);
      if (target.includes("/login/device/code")) {
        return new Response(
          JSON.stringify({
            device_code: "pending-device",
            user_code: "WXYZ-1234",
            verification_uri: "https://github.com/login/device",
            expires_in: 900,
            interval: 5,
          }),
          { status: 200 },
        );
      }
      polls += 1;
      if (polls === 1) {
        return new Response(
          JSON.stringify({ error: "authorization_pending" }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ error: "expired_token" }), {
        status: 200,
      });
    });
    const fixture = createCopilotHarness({ fetchImpl });
    const harness = await fixture.activate();
    await fixture.invokeStartDeviceFlow();
    expect(await fixture.invokePollDeviceFlow()).toEqual({ status: "pending" });
    expect(await fixture.invokePollDeviceFlow()).toEqual({
      status: "failed",
      error: SAFE_COPILOT_ERRORS.deviceFlowExpired,
    });
    expect(fixture.secrets.has("githubOauthToken")).toBe(false);
    await harness.deactivate();
    fixture.restoreFetch();
  });

  it("registers from a saved oauth token and models without fetching", async () => {
    vi.stubEnv("GITHUB_TOKEN", "");
    vi.stubEnv("GH_TOKEN", "");
    const fetchImpl = vi.fn();
    const fixture = createCopilotHarness({
      hasToken: true,
      models: ["gpt-4o"],
      fetchImpl,
    });
    const harness = await fixture.activate();
    expect(fixture.providers).toHaveLength(1);
    expect(await fixture.invokeStatus()).toEqual({
      hasToken: true,
      connected: true,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    await harness.deactivate();
    fixture.restoreFetch();
  });

  it("connects by exchanging a session token and listing models", async () => {
    vi.stubEnv("GITHUB_TOKEN", "");
    vi.stubEnv("GH_TOKEN", "");
    const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const target = String(url);
      if (target === COPILOT_SESSION_TOKEN_URL) {
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "token gho-test-token",
        );
        return new Response(
          JSON.stringify({ token: "session-token", expires_at: 2_000_000_000 }),
          { status: 200 },
        );
      }
      if (target === COPILOT_MODELS_URL) {
        expect(new Headers(init?.headers).get("copilot-integration-id")).toBe(
          "vscode-chat",
        );
        return new Response(JSON.stringify({ data: [{ id: "gpt-4o" }] }), {
          status: 200,
        });
      }
      throw new Error(`unexpected ${target}`);
    });
    const fixture = createCopilotHarness({ hasToken: true, fetchImpl });
    const harness = await fixture.activate();
    await fixture.invokeConnect();
    expect(fixture.getConfig().models).toEqual(["gpt-4o"]);
    expect(fixture.providers).toHaveLength(1);
    await harness.deactivate();
    fixture.restoreFetch();
  });
});
