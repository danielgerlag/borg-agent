import { describe, expect, it } from "vitest";
import { McpClient, decorateDiscover, discoverHeaders } from "../src/client";
import {
  DISCOVER_PROTOCOL_VERSION,
  METHOD_NOT_FOUND,
  type JsonRpcMessage,
  type McpTransport,
  McpProtocolError,
} from "../src/protocol";

class ScriptedTransport implements McpTransport {
  readonly kind: McpTransport["kind"];
  readonly sent: JsonRpcMessage[] = [];
  readonly #handlers = new Set<(message: JsonRpcMessage) => void>();
  readonly #script: (message: JsonRpcMessage) => JsonRpcMessage | undefined;
  #closed = false;

  constructor(
    kind: McpTransport["kind"],
    script: (message: JsonRpcMessage) => JsonRpcMessage | undefined,
  ) {
    this.kind = kind;
    this.#script = script;
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (this.#closed) {
      throw new McpProtocolError(-32603, "MCP transport is closed");
    }
    this.sent.push(message);
    const response = this.#script(message);
    if (response) {
      queueMicrotask(() => {
        for (const handler of this.#handlers) {
          handler(response);
        }
      });
    }
  }

  subscribe(handler: (message: JsonRpcMessage) => void): () => void {
    this.#handlers.add(handler);
    return () => {
      this.#handlers.delete(handler);
    };
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#handlers.clear();
  }
}

describe("MCP protocol eras", () => {
  it("completes the legacy initialize handshake", async () => {
    const transport = new ScriptedTransport("stdio", (message) => {
      if ("method" in message && message.method === "initialize" && "id" in message) {
        return {
          jsonrpc: "2.0",
          id: message.id,
          result: { protocolVersion: "2025-11-25", capabilities: {} },
        };
      }
      return undefined;
    });
    const client = new McpClient({
      transport,
      clientInfo: { name: "borg.mcp", version: "0.1.0" },
    });
    await client.initialize();
    expect(client.era).toBe("legacy");
    expect(transport.sent.map((message) => ("method" in message ? message.method : ""))).toEqual([
      "initialize",
      "notifications/initialized",
    ]);
    await client.close();
  });

  it("rejects an unsupported negotiated protocol version", async () => {
    const transport = new ScriptedTransport("stdio", (message) => {
      if (
        "method" in message &&
        message.method === "initialize" &&
        "id" in message
      ) {
        return {
          jsonrpc: "2.0",
          id: message.id,
          result: { protocolVersion: "2099-01-01", capabilities: {} },
        };
      }
      return undefined;
    });
    const client = new McpClient({
      transport,
      clientInfo: { name: "borg.mcp", version: "0.1.0" },
    });
    await expect(client.initialize()).rejects.toThrow(
      /unsupported protocol version/,
    );
    await client.close();
  });

  it("falls back to server/discover on a fresh stdio transport", async () => {
    let opens = 0;
    const script = (message: JsonRpcMessage): JsonRpcMessage | undefined => {
      if (!("method" in message) || !("id" in message)) {
        return undefined;
      }
      if (message.method === "initialize") {
        return {
          jsonrpc: "2.0",
          id: message.id,
          error: { code: METHOD_NOT_FOUND, message: "Method not found: initialize" },
        };
      }
      if (message.method === "server/discover") {
        return {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersions: [DISCOVER_PROTOCOL_VERSION],
            capabilities: { tools: {} },
          },
        };
      }
      return undefined;
    };
    const first = new ScriptedTransport("stdio", script);
    const client = new McpClient({
      transport: first,
      clientInfo: { name: "borg.mcp", version: "0.1.0" },
      reopen: async () => {
        opens += 1;
        return new ScriptedTransport("stdio", script);
      },
    });
    await client.initialize();
    expect(client.era).toBe("discover");
    expect(opens).toBe(1);
    expect(first.sent.some((message) => "method" in message && message.method === "server/discover")).toBe(
      false,
    );
    await client.close();
  });

  it("attaches 2026 request metadata and headers", () => {
    const decorated = decorateDiscover(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "echo", arguments: { text: "hi" } },
      },
      { name: "borg.mcp", version: "0.1.0" },
    );
    expect(decorated).toMatchObject({
      method: "tools/call",
      params: {
        name: "echo",
        _meta: {
          "io.modelcontextprotocol/protocolVersion": DISCOVER_PROTOCOL_VERSION,
        },
      },
    });
    expect(discoverHeaders("tools/call", "echo")).toEqual({
      "MCP-Protocol-Version": DISCOVER_PROTOCOL_VERSION,
      "Mcp-Method": "tools/call",
      "Mcp-Name": "echo",
    });
  });

  it("advertises the official MCP Apps UI capability on legacy initialize", async () => {
    const transport = new ScriptedTransport("stdio", (message) => {
      if ("method" in message && message.method === "initialize" && "id" in message) {
        return {
          jsonrpc: "2.0",
          id: message.id,
          result: { protocolVersion: "2025-11-25", capabilities: {} },
        };
      }
      return undefined;
    });
    const client = new McpClient({
      transport,
      clientInfo: { name: "borg.mcp", version: "0.1.0" },
    });
    await client.initialize();
    const initialize = transport.sent[0];
    expect(initialize && "params" in initialize ? initialize.params : undefined).toEqual({
      protocolVersion: "2025-11-25",
      capabilities: {
        extensions: {
          "io.modelcontextprotocol/ui": {
            mimeTypes: ["text/html;profile=mcp-app"],
          },
        },
      },
      clientInfo: { name: "borg.mcp", version: "0.1.0" },
    });
    await client.close();
  });

  it("advertises the same MCP Apps UI capability on discover metadata", () => {
    const decorated = decorateDiscover(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "server/discover",
        params: {},
      },
      { name: "borg.mcp", version: "0.1.0" },
    );
    expect(decorated && "params" in decorated ? decorated.params : undefined).toEqual({
      _meta: {
        "io.modelcontextprotocol/protocolVersion": DISCOVER_PROTOCOL_VERSION,
        "io.modelcontextprotocol/clientInfo": {
          name: "borg.mcp",
          version: "0.1.0",
        },
        "io.modelcontextprotocol/clientCapabilities": {
          extensions: {
            "io.modelcontextprotocol/ui": {
              mimeTypes: ["text/html;profile=mcp-app"],
            },
          },
        },
      },
    });
  });
});

describe("MCP response bounds", () => {
  it("rejects a repeated tools cursor", async () => {
    const transport = new ScriptedTransport("stdio", (message) => {
      if (
        "method" in message &&
        message.method === "tools/list" &&
        "id" in message
      ) {
        return {
          jsonrpc: "2.0",
          id: message.id,
          result: { tools: [], nextCursor: "same" },
        };
      }
      return undefined;
    });
    const client = new McpClient({
      transport,
      clientInfo: { name: "borg.mcp", version: "0.1.0" },
    });

    await expect(client.listTools()).rejects.toThrow(
      /pagination did not terminate/,
    );
    await client.close();
  });

  it("rejects resource items without an explicit URI", async () => {
    const transport = new ScriptedTransport("stdio", (message) => {
      if (
        "method" in message &&
        message.method === "resources/read" &&
        "id" in message
      ) {
        return {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            contents: [
              {
                mimeType: "text/html;profile=mcp-app",
                text: "<!DOCTYPE html><html></html>",
              },
            ],
          },
        };
      }
      return undefined;
    });
    const client = new McpClient({
      transport,
      clientInfo: { name: "borg.mcp", version: "0.1.0" },
    });

    await expect(client.readResource("ui://mock/form")).rejects.toThrow(
      /invalid resource/,
    );
    await client.close();
  });
});

describe("MCP tools/list visibility", () => {
  async function listToolsOf(tools: unknown[]): Promise<unknown> {
    const transport = new ScriptedTransport("stdio", (message) => {
      if (
        "method" in message &&
        message.method === "tools/list" &&
        "id" in message
      ) {
        return {
          jsonrpc: "2.0",
          id: message.id,
          result: { tools },
        };
      }
      return undefined;
    });
    const client = new McpClient({
      transport,
      clientInfo: { name: "borg.mcp", version: "0.1.0" },
    });
    try {
      return await client.listTools();
    } finally {
      await client.close();
    }
  }

  it("omits visibility when _meta.ui.visibility is absent", async () => {
    await expect(listToolsOf([{ name: "echo" }])).resolves.toEqual([
      { name: "echo" },
    ]);
  });

  it("preserves an empty visibility array as neither audience", async () => {
    await expect(
      listToolsOf([{ name: "echo", _meta: { ui: { visibility: [] } } }]),
    ).resolves.toEqual([
      { name: "echo", _meta: { ui: { visibility: [] } } },
    ]);
  });

  it("accepts model, app, or both without duplicates", async () => {
    await expect(
      listToolsOf([
        { name: "model-only", _meta: { ui: { visibility: ["model"] } } },
        { name: "app-only", _meta: { ui: { visibility: ["app"] } } },
        { name: "both", _meta: { ui: { visibility: ["model", "app"] } } },
        { name: "app-then-model", _meta: { ui: { visibility: ["app", "model"] } } },
      ]),
    ).resolves.toEqual([
      { name: "model-only", _meta: { ui: { visibility: ["model"] } } },
      { name: "app-only", _meta: { ui: { visibility: ["app"] } } },
      { name: "both", _meta: { ui: { visibility: ["model", "app"] } } },
      { name: "app-then-model", _meta: { ui: { visibility: ["app", "model"] } } },
    ]);
  });

  it("rejects non-arrays, unknown values, duplicates, and oversized visibility", async () => {
    await expect(
      listToolsOf([{ name: "echo", _meta: { ui: { visibility: "model" } } }]),
    ).rejects.toThrow(/invalid UI visibility/);
    await expect(
      listToolsOf([{ name: "echo", _meta: { ui: { visibility: ["web"] } } }]),
    ).rejects.toThrow(/invalid UI visibility/);
    await expect(
      listToolsOf([
        { name: "echo", _meta: { ui: { visibility: ["model", "model"] } } },
      ]),
    ).rejects.toThrow(/invalid UI visibility/);
    await expect(
      listToolsOf([
        {
          name: "echo",
          _meta: { ui: { visibility: ["model", "app", "model"] } },
        },
      ]),
    ).rejects.toThrow(/invalid UI visibility/);
  });

  it("rejects malformed UI metadata and non-ui resource URIs", async () => {
    await expect(
      listToolsOf([{ name: "echo", _meta: "invalid" }]),
    ).rejects.toThrow(/invalid metadata/);
    await expect(
      listToolsOf([{ name: "echo", _meta: { ui: "invalid" } }]),
    ).rejects.toThrow(/invalid UI metadata/);
    await expect(
      listToolsOf([
        {
          name: "echo",
          _meta: { ui: { resourceUri: "https://example.test/app" } },
        },
      ]),
    ).rejects.toThrow(/invalid app resource URI/);
  });
});
