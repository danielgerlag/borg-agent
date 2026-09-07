import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  OAuthLoopbackRequest,
  OAuthLoopbackResponse,
  PluginOAuthConnectRequest,
  SecretStoreProvider,
} from "@borg/plugin-sdk";
import { PersistenceRegistry, SecretFacade } from "../src";
import {
  OAUTH_ACCESS_TOKEN_SKEW_MS,
  OAUTH_VAULT_NAMESPACE,
  OAuthError,
  OAuthService,
  type OAuthListen,
  type OAuthLoopbackServer,
} from "../src/oauth-service";

const PLUGIN_ID = "borg.channel.m365";
const AUTHORIZE = "https://login.example/oauth/authorize";
const TOKEN = "http://127.0.0.1:9/token";
const ACCESS = "ACCESS_TOKEN_SECRET_VALUE";
const REFRESH = "REFRESH_TOKEN_SECRET_VALUE";
const NEXT_ACCESS = "ACCESS_TOKEN_ROTATED_VALUE";
const NEXT_REFRESH = "REFRESH_TOKEN_ROTATED_VALUE";

class MemorySecretStore implements SecretStoreProvider {
  readonly kind = "development" as const;
  readonly values = new Map<string, string>();

  async get(namespace: string, key: string): Promise<string | undefined> {
    return this.values.get(`${namespace}:${key}`);
  }

  async set(namespace: string, key: string, value: string): Promise<void> {
    this.values.set(`${namespace}:${key}`, value);
  }

  async delete(namespace: string, key: string): Promise<void> {
    this.values.delete(`${namespace}:${key}`);
  }

  async has(namespace: string, key: string): Promise<boolean> {
    return this.values.has(`${namespace}:${key}`);
  }
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256")
    .update(verifier)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function createSecrets(): {
  readonly secrets: SecretFacade;
  readonly store: MemorySecretStore;
} {
  const store = new MemorySecretStore();
  const persistence = new PersistenceRegistry();
  persistence.registerSecretStore("test.secrets", store);
  return { secrets: new SecretFacade(persistence), store };
}

interface LoopbackHandle {
  handler:
    | ((request: OAuthLoopbackRequest, response: OAuthLoopbackResponse) => void)
    | undefined;
  readonly port: number;
  readonly responses: { readonly status: number; readonly body?: string }[];
}

function createLoopback(port = 41_000): {
  readonly listen: OAuthListen;
  readonly loopback: LoopbackHandle;
} {
  const loopback: LoopbackHandle = {
    handler: undefined,
    port,
    responses: [],
  };
  const listen: OAuthListen = async ({ handler, signal }) => {
    loopback.handler = handler;
    const server: OAuthLoopbackServer = {
      port,
      close: async () => {
        loopback.handler = undefined;
      },
    };
    signal.addEventListener(
      "abort",
      () => {
        loopback.handler = undefined;
      },
      { once: true },
    );
    return server;
  };
  return { listen, loopback };
}

function dispatch(
  loopback: LoopbackHandle,
  request: OAuthLoopbackRequest,
): { readonly status: number; readonly body?: string } {
  if (!loopback.handler) {
    throw new Error("OAuth loopback is not listening");
  }
  let status = 0;
  let body: string | undefined;
  const response: OAuthLoopbackResponse = {
    writeHead(nextStatus) {
      status = nextStatus;
    },
    end(nextBody) {
      body = nextBody;
    },
  };
  loopback.handler(request, response);
  const recorded = { status, ...(body !== undefined ? { body } : {}) };
  loopback.responses.push(recorded);
  return recorded;
}

function callbackRequest(
  loopback: LoopbackHandle,
  authorizeUrl: string,
  options: {
    readonly host?: string | undefined;
    readonly path?: string | undefined;
    readonly code?: string | undefined;
    readonly error?: string | undefined;
    readonly state?: string | undefined;
  } = {},
): OAuthLoopbackRequest {
  const parsed = new URL(authorizeUrl);
  const redirect = new URL(parsed.searchParams.get("redirect_uri") ?? "http://127.0.0.1/");
  const state = options.state ?? parsed.searchParams.get("state") ?? "";
  const params = new URLSearchParams();
  if (options.error) {
    params.set("error", options.error);
    params.set("state", state);
  } else {
    params.set("code", options.code ?? "auth-code");
    params.set("state", state);
  }
  return {
    method: "GET",
    url: options.path ?? `/?${params.toString()}`,
    headers: {
      host: options.host ?? `${redirect.hostname}:${loopback.port}`,
    },
  };
}

async function completeConnect(
  connect: Promise<unknown>,
  loopback: LoopbackHandle,
  opened: string[],
): Promise<void> {
  await vi.waitFor(() => expect(opened.length).toBeGreaterThan(0));
  const authorizeUrl = opened[opened.length - 1];
  if (!authorizeUrl) {
    throw new Error("Authorization URL was not opened");
  }
  dispatch(loopback, callbackRequest(loopback, authorizeUrl));
  await connect;
}

function baseRequest(
  overrides: Partial<PluginOAuthConnectRequest> = {},
): PluginOAuthConnectRequest {
  return {
    clientId: "public-native-client",
    authorizationEndpoint: AUTHORIZE,
    tokenEndpoint: TOKEN,
    scopes: ["offline_access", "Mail.Read"],
    ...overrides,
  };
}

describe("OAuthService", () => {
  it("completes a PKCE loopback grant and stores the refresh token in the vault", async () => {
    const { secrets, store } = createSecrets();
    const { listen, loopback } = createLoopback();
    const opened: string[] = [];
    const tokenBodies: string[] = [];
    const service = new OAuthService({
      secrets,
      allowLoopbackHttp: true,
      listen,
      openExternal: async (url) => {
        opened.push(url);
      },
      fetch: async (_input, init) => {
        tokenBodies.push(typeof init?.body === "string" ? init.body : "");
        expect(init?.redirect).toBe("error");
        return jsonResponse({
          access_token: ACCESS,
          refresh_token: REFRESH,
          expires_in: 3_600,
          token_type: "Bearer",
        });
      },
    });

    const pending = service.connect(PLUGIN_ID, baseRequest());
    await completeConnect(pending, loopback, opened);

    const authorizeUrl = new URL(opened[0] ?? "");
    expect(authorizeUrl.protocol).toBe("https:");
    expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizeUrl.searchParams.get("response_type")).toBe("code");
    expect(authorizeUrl.searchParams.get("client_id")).toBe("public-native-client");
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(
      `http://127.0.0.1:${loopback.port}/`,
    );
    const challenge = authorizeUrl.searchParams.get("code_challenge");
    expect(challenge).toEqual(expect.any(String));
    const body = new URLSearchParams(tokenBodies[0]);
    expect(body.get("code_verifier")).toEqual(expect.any(String));
    expect(pkceChallenge(body.get("code_verifier") ?? "")).toBe(challenge);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("auth-code");

    await expect(service.snapshot(PLUGIN_ID)).resolves.toEqual({
      connected: true,
      expiresAt: expect.any(String),
    });
    await expect(service.accessToken(PLUGIN_ID)).resolves.toBe(ACCESS);
    const vault = store.values.get(`${OAUTH_VAULT_NAMESPACE}:${PLUGIN_ID}`);
    expect(vault).toContain(REFRESH);
    expect(await secrets.get(PLUGIN_ID, PLUGIN_ID)).toBeUndefined();
    expect(await secrets.get(PLUGIN_ID, OAUTH_VAULT_NAMESPACE)).toBeUndefined();
    service.shutdown();
  });

  it("ignores a host-mismatched GET and still completes the real callback", async () => {
    const { secrets } = createSecrets();
    const { listen, loopback } = createLoopback();
    const opened: string[] = [];
    const service = new OAuthService({
      secrets,
      allowLoopbackHttp: true,
      listen,
      openExternal: async (url) => {
        opened.push(url);
      },
      fetch: async () =>
        jsonResponse({
          access_token: ACCESS,
          refresh_token: REFRESH,
          expires_in: 3_600,
        }),
    });

    const pending = service.connect(PLUGIN_ID, baseRequest());
    await vi.waitFor(() => expect(opened.length).toBeGreaterThan(0));
    const authorizeUrl = opened[0];
    if (!authorizeUrl) {
      throw new Error("Authorization URL was not opened");
    }
    const probe = dispatch(
      loopback,
      callbackRequest(loopback, authorizeUrl, { host: "evil.example:80" }),
    );
    expect(probe.status).toBe(400);
    dispatch(loopback, callbackRequest(loopback, authorizeUrl));
    await pending;
    await expect(service.snapshot(PLUGIN_ID)).resolves.toMatchObject({
      connected: true,
    });
    service.shutdown();
  });

  it("fails closed when the token JSON has no refresh_token", async () => {
    const { secrets, store } = createSecrets();
    const { listen, loopback } = createLoopback();
    const opened: string[] = [];
    const service = new OAuthService({
      secrets,
      allowLoopbackHttp: true,
      listen,
      openExternal: async (url) => {
        opened.push(url);
      },
      fetch: async () =>
        jsonResponse({
          access_token: ACCESS,
          expires_in: 3_600,
        }),
    });

    const pending = service.connect(PLUGIN_ID, baseRequest());
    const expected = expect(pending).rejects.toMatchObject({
      name: "OAuthError",
      code: "failed",
    });
    await completeConnect(pending.catch(() => undefined), loopback, opened);
    await expected;
    expect(store.values.size).toBe(0);
    await expect(service.snapshot(PLUGIN_ID)).resolves.toEqual({ connected: false });
    service.shutdown();
  });

  it("refreshes a stale access token on a single flight", async () => {
    const { secrets } = createSecrets();
    const { listen, loopback } = createLoopback();
    const opened: string[] = [];
    let now = 1_000_000;
    const grants: string[] = [];
    const service = new OAuthService({
      secrets,
      allowLoopbackHttp: true,
      listen,
      now: () => now,
      openExternal: async (url) => {
        opened.push(url);
      },
      fetch: async (_input, init) => {
        const body = new URLSearchParams(
          typeof init?.body === "string" ? init.body : "",
        );
        grants.push(body.get("grant_type") ?? "");
        if (body.get("grant_type") === "refresh_token") {
          expect(body.get("refresh_token")).toBe(REFRESH);
          return jsonResponse({
            access_token: NEXT_ACCESS,
            refresh_token: NEXT_REFRESH,
            expires_in: 3_600,
          });
        }
        return jsonResponse({
          access_token: ACCESS,
          refresh_token: REFRESH,
          expires_in: 3_600,
        });
      },
    });

    const pending = service.connect(PLUGIN_ID, baseRequest());
    await completeConnect(pending, loopback, opened);
    now += 3_600_000 - OAUTH_ACCESS_TOKEN_SKEW_MS + 1;
    const [first, second] = await Promise.all([
      service.accessToken(PLUGIN_ID),
      service.accessToken(PLUGIN_ID),
    ]);
    expect(first).toBe(NEXT_ACCESS);
    expect(second).toBe(NEXT_ACCESS);
    expect(grants.filter((grant) => grant === "refresh_token")).toHaveLength(1);
    await expect(service.accessToken(PLUGIN_ID)).resolves.toBe(NEXT_ACCESS);
    expect(grants.filter((grant) => grant === "refresh_token")).toHaveLength(1);
    service.shutdown();
  });

  it("abortOwned cancels an in-flight connect and leaves a landed grant", async () => {
    const { secrets, store } = createSecrets();
    const { listen, loopback } = createLoopback();
    const opened: string[] = [];
    const service = new OAuthService({
      secrets,
      allowLoopbackHttp: true,
      listen,
      openExternal: async (url) => {
        opened.push(url);
      },
      fetch: async () =>
        jsonResponse({
          access_token: ACCESS,
          refresh_token: REFRESH,
          expires_in: 3_600,
        }),
    });

    const hanging = service.connect(PLUGIN_ID, baseRequest());
    await vi.waitFor(() => expect(opened.length).toBeGreaterThan(0));
    expect(service.countOwned(PLUGIN_ID)).toBe(1);
    service.abortOwned(PLUGIN_ID);
    await expect(hanging).rejects.toMatchObject({
      name: "OAuthError",
      code: "unavailable",
    });
    expect(service.countOwned(PLUGIN_ID)).toBe(0);
    expect(store.values.size).toBe(0);

    opened.length = 0;
    const landed = service.connect(PLUGIN_ID, baseRequest());
    await completeConnect(landed, loopback, opened);
    expect(store.values.has(`${OAUTH_VAULT_NAMESPACE}:${PLUGIN_ID}`)).toBe(true);
    service.abortOwned(PLUGIN_ID);
    expect(store.values.has(`${OAUTH_VAULT_NAMESPACE}:${PLUGIN_ID}`)).toBe(true);
    await expect(service.snapshot(PLUGIN_ID)).resolves.toMatchObject({
      connected: true,
    });
    service.shutdown();
  });

  it("rejects a Host header that does not match the advertised loopback host", async () => {
    const { secrets, store } = createSecrets();
    const { listen, loopback } = createLoopback();
    const opened: string[] = [];
    const service = new OAuthService({
      secrets,
      allowLoopbackHttp: true,
      listen,
      openExternal: async (url) => {
        opened.push(url);
      },
      fetch: async () => {
        throw new Error("token endpoint must not be called");
      },
    });

    const pending = service.connect(
      PLUGIN_ID,
      baseRequest({ loopbackHost: "localhost" }),
    );
    await vi.waitFor(() => expect(opened.length).toBeGreaterThan(0));
    const authorizeUrl = opened[0];
    if (!authorizeUrl) {
      throw new Error("Authorization URL was not opened");
    }
    expect(new URL(authorizeUrl).searchParams.get("redirect_uri")).toBe(
      `http://localhost:${loopback.port}/`,
    );
    const probe = dispatch(
      loopback,
      callbackRequest(loopback, authorizeUrl, {
        host: `127.0.0.1:${loopback.port}`,
      }),
    );
    expect(probe.status).toBe(400);
    const expected = expect(pending).rejects.toMatchObject({
      name: "OAuthError",
      code: "unavailable",
    });
    service.abortOwned(PLUGIN_ID);
    await expected;
    expect(store.values.size).toBe(0);
    service.shutdown();
  });

  it("ignores favicon and rejects a second GET so the code cannot be stolen", async () => {
    const { secrets } = createSecrets();
    const { listen, loopback } = createLoopback();
    const opened: string[] = [];
    let tokenCalls = 0;
    const service = new OAuthService({
      secrets,
      allowLoopbackHttp: true,
      listen,
      openExternal: async (url) => {
        opened.push(url);
      },
      fetch: async () => {
        tokenCalls += 1;
        return jsonResponse({
          access_token: ACCESS,
          refresh_token: REFRESH,
          expires_in: 3_600,
        });
      },
    });

    const pending = service.connect(PLUGIN_ID, baseRequest());
    await vi.waitFor(() => expect(opened.length).toBeGreaterThan(0));
    const authorizeUrl = opened[0];
    if (!authorizeUrl) {
      throw new Error("Authorization URL was not opened");
    }
    expect(
      dispatch(loopback, {
        method: "GET",
        url: "/favicon.ico",
        headers: { host: `127.0.0.1:${loopback.port}` },
      }).status,
    ).toBe(204);
    dispatch(loopback, callbackRequest(loopback, authorizeUrl));
    expect(
      dispatch(loopback, callbackRequest(loopback, authorizeUrl, { code: "stolen" }))
        .status,
    ).toBe(400);
    await pending;
    expect(tokenCalls).toBe(1);
    service.shutdown();
  });

  it("records origins and outcomes without token strings", async () => {
    const { secrets } = createSecrets();
    const { listen, loopback } = createLoopback();
    const opened: string[] = [];
    const service = new OAuthService({
      secrets,
      allowLoopbackHttp: true,
      listen,
      openExternal: async (url) => {
        opened.push(url);
      },
      fetch: async () =>
        jsonResponse({
          access_token: ACCESS,
          refresh_token: REFRESH,
          expires_in: 3_600,
        }),
    });

    const pending = service.connect(PLUGIN_ID, baseRequest());
    await completeConnect(pending, loopback, opened);
    const audit = JSON.stringify(service.listAudit());
    expect(audit).toContain("login.example");
    expect(audit).toContain("127.0.0.1");
    expect(audit).toContain("\"connected\"");
    expect(audit).not.toContain(ACCESS);
    expect(audit).not.toContain(REFRESH);
    expect(audit).not.toContain("auth-code");
    expect(audit.toLowerCase()).not.toContain("access_token");
    expect(audit.toLowerCase()).not.toContain("refresh_token");
    service.shutdown();
  });

  it("rejects reserved extra authorization parameters", async () => {
    const { secrets } = createSecrets();
    const service = new OAuthService({
      secrets,
      allowLoopbackHttp: true,
      openExternal: async () => undefined,
      listen: async () => ({
        port: 1,
        close: async () => undefined,
      }),
    });
    await expect(
      service.connect(
        PLUGIN_ID,
        baseRequest({
          extraAuthorizationParams: { client_id: "stolen" },
        }),
      ),
    ).rejects.toMatchObject({ name: "OAuthError", code: "invalid" });
    expect(JSON.stringify(service.listAudit())).toContain("reserved-param");
    service.shutdown();
  });

  it("revokes then deletes on disconnect and treats a missing grant as success", async () => {
    const { secrets, store } = createSecrets();
    const { listen, loopback } = createLoopback();
    const opened: string[] = [];
    const revoked: string[] = [];
    const service = new OAuthService({
      secrets,
      allowLoopbackHttp: true,
      listen,
      openExternal: async (url) => {
        opened.push(url);
      },
      fetch: async (input, init) => {
        const url = String(input);
        if (url.includes("revoke")) {
          revoked.push(typeof init?.body === "string" ? init.body : "");
          return new Response(null, { status: 200 });
        }
        return jsonResponse({
          access_token: ACCESS,
          refresh_token: REFRESH,
          expires_in: 3_600,
        });
      },
    });

    const pending = service.connect(
      PLUGIN_ID,
      baseRequest({
        revocationEndpoint: "http://127.0.0.1:9/revoke",
      }),
    );
    await completeConnect(pending, loopback, opened);
    await service.disconnect(PLUGIN_ID);
    expect(revoked).toHaveLength(1);
    expect(revoked[0]).toContain("token_type_hint=refresh_token");
    expect(revoked[0]).not.toContain(ACCESS);
    expect(store.values.has(`${OAUTH_VAULT_NAMESPACE}:${PLUGIN_ID}`)).toBe(
      false,
    );
    await expect(service.disconnect(PLUGIN_ID)).resolves.toBeUndefined();
    service.shutdown();
  });
});

describe("OAuthError", () => {
  it("exposes the closed error codes", () => {
    expect(new OAuthError("denied", "nope").code).toBe("denied");
  });
});
