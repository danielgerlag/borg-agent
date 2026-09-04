import {
  mcpAppDiscovered,
  mcpAppSnapshotSchema,
  mcpAppsInvokeTool,
} from "@borg/contracts";
import { describe, expect, it } from "vitest";
import {
  MCP_APP_BRIDGE_CHANNEL,
  SANDBOX_PROXY_READY_METHOD,
  SANDBOX_RESOURCE_READY_METHOD,
  bridgeEnvelope,
  createHostInitializeResult,
  createProxyUrl,
  hasEmptyParams,
  hardenAppHtml,
  isProxyReady,
  isSandboxReservedMessage,
  parseAppRpcRequest,
  parseBridgeEnvelope,
  parseCancelledParams,
  parseInitializeParams,
  parseToolCallParams,
  sandboxResourceReady,
} from "../src/proxy";

function appSnapshot() {
  return mcpAppSnapshotSchema.parse({
    version: 1,
    sessionId: "62d524e8-5a22-41a1-ac64-beb55f1e1183",
    personaId: "system/general",
    appInstanceId: "d0cc0266-2235-5fea-965b-dbabe70c3a66",
    serverId: "fixture",
    resourceUri: "ui://fixture/form",
    html: "<!DOCTYPE html><html><body></body></html>",
    csp: {},
    permissions: {},
    tools: [
      {
        name: "show-form",
        toolId: "mcp.fixture.show-form",
        description: "Show a form",
        inputSchema: { type: "object", properties: {} },
      },
    ],
    sourceToolId: "mcp.fixture.show-form",
    sourceToolName: "show-form",
    toolInput: {},
    callResult: {},
    startedAt: "2026-09-03T12:00:00.000Z",
    completedAt: "2026-09-03T12:00:00.000Z",
    discoveredAt: "2026-09-03T12:00:00.000Z",
  });
}

describe("MCP App bridge validation", () => {
  it("bounds command results and app HTML by encoded size", () => {
    expect(
      mcpAppsInvokeTool.output.safeParse({
        requestId: 1,
        result: "x".repeat(256 * 1024),
      }).success,
    ).toBe(false);
    expect(
      mcpAppDiscovered.payload.safeParse({
        sessionId: "62d524e8-5a22-41a1-ac64-beb55f1e1183",
        personaId: "system/general",
        appInstanceId: "d0cc0266-2235-5fea-965b-dbabe70c3a66",
        serverId: "fixture",
        resourceUri: "ui://fixture/form",
        html: "😀".repeat(600_000),
        csp: {},
        permissions: {},
        tools: [],
        sourceToolId: "mcp.fixture.form",
        sourceToolName: "form",
        toolInput: {},
        callResult: {},
        startedAt: "2026-09-03T12:00:00.000Z",
        completedAt: "2026-09-03T12:00:00.000Z",
        discoveredAt: "2026-09-03T12:00:00.000Z",
      }).success,
    ).toBe(false);
  });

  it("accepts only matching bounded envelopes", () => {
    const envelope = bridgeEnvelope("instance", "nonce", {
      jsonrpc: "2.0",
      method: "tools/list",
      id: 1,
    });
    expect(
      parseBridgeEnvelope(envelope, "instance", "nonce"),
    ).toEqual(envelope);
    expect(
      parseBridgeEnvelope(envelope, "other", "nonce"),
    ).toBeUndefined();
    expect(
      parseBridgeEnvelope(
        {
          ...envelope,
          channel: MCP_APP_BRIDGE_CHANNEL,
          extra: true,
        },
        "instance",
        "nonce",
      ),
    ).toBeUndefined();
    expect(
      parseBridgeEnvelope(
        bridgeEnvelope("instance", "nonce", "x".repeat(256 * 1024)),
        "instance",
        "nonce",
      ),
    ).toBeUndefined();
    let nested: unknown = "leaf";
    for (let depth = 0; depth < 34; depth += 1) {
      nested = { nested };
    }
    expect(
      parseBridgeEnvelope(
        bridgeEnvelope("instance", "nonce", nested),
        "instance",
        "nonce",
      ),
    ).toBeUndefined();
  });

  it("parses strict JSON-RPC requests and tool arguments", () => {
    expect(
      parseAppRpcRequest({
        jsonrpc: "2.0",
        id: "request-1",
        method: "tools/call",
        params: { name: "echo", arguments: { text: "hello" } },
      }),
    ).toEqual({
      jsonrpc: "2.0",
      id: "request-1",
      method: "tools/call",
      params: { name: "echo", arguments: { text: "hello" } },
    });
    expect(
      parseAppRpcRequest({
        jsonrpc: "2.0",
        id: null,
        method: "tools/list",
      }),
    ).toBeUndefined();
    expect(
      parseToolCallParams({
        name: "echo",
        arguments: { text: "hello" },
      }),
    ).toEqual({
      name: "echo",
      arguments: { text: "hello" },
    });
    expect(
      parseToolCallParams({
        name: "echo",
        arguments: { invalid: undefined },
      }),
    ).toBeUndefined();
    expect(
      parseInitializeParams({
        protocolVersion: "2026-01-26",
        appInfo: { name: "Fixture" },
        extra: true,
      }),
    ).toBeUndefined();
    expect(parseCancelledParams({ requestId: "request-1" })).toEqual({
      requestId: "request-1",
    });
    expect(
      parseCancelledParams({ requestId: null }),
    ).toBeUndefined();
    expect(hasEmptyParams(undefined)).toBe(true);
    expect(hasEmptyParams({})).toBe(true);
    expect(hasEmptyParams({ extra: true })).toBe(false);
  });

  it("builds the standard host initialization result", () => {
    const result = createHostInitializeResult(
      appSnapshot(),
      "2026-01-26",
    );
    expect(result).toMatchObject({
      protocolVersion: "2026-01-26",
      hostCapabilities: { serverTools: {} },
      hostContext: {
        displayMode: "inline",
        availableDisplayModes: ["inline"],
        toolInfo: {
          tool: {
            name: "show-form",
            description: "Show a form",
            inputSchema: { type: "object", properties: {} },
          },
        },
      },
    });
    expect(result).not.toHaveProperty("context");

    const withoutSafeTool = createHostInitializeResult(
      {
        ...appSnapshot(),
        tools: [
          {
            name: "show-form",
            toolId: "mcp.fixture.show-form",
            description: "Show a form",
            inputSchema: true,
          },
        ],
      },
      "unsupported",
    );
    expect(withoutSafeTool).toMatchObject({
      protocolVersion: "2026-01-26",
      hostContext: { displayMode: "inline" },
    });
    expect(withoutSafeTool).not.toHaveProperty("hostContext.toolInfo");
  });
});

describe("MCP App document isolation", () => {
  const appHtml =
    '<!DOCTYPE html><html><head></head><body><script>window.parent.postMessage({jsonrpc:"2.0"},"*")</script></body></html>';

  it("adds a deny-by-default policy to the inner document", () => {
    const hardened = hardenAppHtml(appHtml);
    expect(hardened).toContain("default-src 'none'");
    expect(hardened).toContain("connect-src 'none'");
    expect(hardened).toContain("frame-src 'none'");
    expect(hardened).toContain("base-uri 'none'");
    expect(hardened).toContain('name="referrer" content="no-referrer"');
  });

  it("injects policy before any untrusted document content", () => {
    const hostile =
      '<!DOCTYPE html><html data-value=">"><script>const fake = "<head>"</script><body></body></html>';
    const hardened = hardenAppHtml(hostile);
    expect(hardened.indexOf("Content-Security-Policy")).toBeLessThan(
      hardened.indexOf("<script>"),
    );
    expect(() =>
      hardenAppHtml('<!DOCTYPE html><!-- <html> --><body></body>'),
    ).toThrow(/document envelope/);
  });

  it("creates an encoded custom-protocol proxy URL", () => {
    const nonce = "</script><script>throw new Error()</script>";
    const candidate = createProxyUrl({
      instanceId: "instance",
      nonce,
      parentOrigin: "null",
    });
    const url = new URL(candidate);
    expect(url.origin).toBe("null");
    expect(url.protocol).toBe("borg-embedded:");
    expect(url.hostname).toBe("mcp-app");
    expect(url.pathname).toBe("/proxy.html");
    expect(url.searchParams.get("nonce")).toBe(nonce);
    expect(candidate).not.toContain("</script>");
    const ready = {
      jsonrpc: "2.0",
      method: SANDBOX_PROXY_READY_METHOD,
      params: {},
    };
    expect(isProxyReady(ready)).toBe(true);
    expect(isProxyReady({ ...ready, extra: true })).toBe(false);
    expect(sandboxResourceReady("<!DOCTYPE html>")).toEqual({
      jsonrpc: "2.0",
      method: SANDBOX_RESOURCE_READY_METHOD,
      params: { html: "<!DOCTYPE html>" },
    });
    expect(isSandboxReservedMessage(ready)).toBe(true);
    expect(
      isSandboxReservedMessage({
        jsonrpc: "2.0",
        method: "ui/notifications/initialized",
      }),
    ).toBe(false);
  });
});
