import { describe, expect, it } from "vitest";
import { JsonRpcPeer } from "../src/json-rpc";
import {
  MAX_JSONRPC_BYTES,
  asJsonRpcMessage,
  encodeNdjson,
  type JsonRpcMessage,
  type McpTransport,
  McpProtocolError,
} from "../src/protocol";

class MemoryTransport implements McpTransport {
  readonly kind = "stdio" as const;
  readonly #handlers = new Set<(message: JsonRpcMessage) => void>();
  readonly sent: JsonRpcMessage[] = [];
  readonly sentHeaders: Array<Readonly<Record<string, string>> | undefined> = [];
  #closed = false;

  async send(
    message: JsonRpcMessage,
    options?: { readonly headers?: Readonly<Record<string, string>> },
  ): Promise<void> {
    if (this.#closed) {
      throw new McpProtocolError(-32603, "MCP transport is closed");
    }
    encodeNdjson(message);
    this.sent.push(message);
    this.sentHeaders.push(options?.headers);
  }

  subscribe(handler: (message: JsonRpcMessage) => void): () => void {
    this.#handlers.add(handler);
    return () => {
      this.#handlers.delete(handler);
    };
  }

  push(message: JsonRpcMessage): void {
    for (const handler of this.#handlers) {
      handler(message);
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#handlers.clear();
  }
}

describe("JsonRpcPeer", () => {
  it("correlates responses by request id", async () => {
    const transport = new MemoryTransport();
    const peer = new JsonRpcPeer(transport);
    const pending = peer.request("tools/list", {});
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    expect(transport.sent).toEqual([
      expect.objectContaining({ id: 1, method: "tools/list" }),
    ]);
    transport.push({ jsonrpc: "2.0", id: 99, result: { ignored: true } });
    transport.push({ jsonrpc: "2.0", id: "1", result: { ignored: true } });
    await Promise.resolve();
    expect(settled).toBe(false);
    transport.push({ jsonrpc: "2.0", id: 1, result: { tools: [] } });
    await expect(pending).resolves.toEqual({ tools: [] });
    await peer.close();
  });

  it("rejects malformed and oversized outbound messages", () => {
    expect(() =>
      encodeNdjson({
        jsonrpc: "2.0",
        method: "tools/call",
        params: { blob: "x".repeat(MAX_JSONRPC_BYTES) },
      }),
    ).toThrow(/too large/);
    expect(() => JSON.parse("{")).toThrow();
    expect(
      asJsonRpcMessage({
        jsonrpc: "2.0",
        id: null,
        method: "tools/list",
      }),
    ).toBeUndefined();
    expect(
      asJsonRpcMessage({
        jsonrpc: "2.0",
        id: 1,
        result: {},
        error: { code: -32603, message: "ambiguous" },
      }),
    ).toBeUndefined();
    expect(
      asJsonRpcMessage({
        jsonrpc: "2.0",
        id: 1.5,
        result: {},
      }),
    ).toBeUndefined();
    expect(
      asJsonRpcMessage({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32_603.5, message: "invalid code" },
      }),
    ).toBeUndefined();
  });

  it("rejects pending calls on abort and close", async () => {
    const transport = new MemoryTransport();
    const peer = new JsonRpcPeer(transport);
    const controller = new AbortController();
    const aborted = peer.request("tools/call", { name: "echo" }, {
      signal: controller.signal,
      headers: { "MCP-Protocol-Version": "2026-07-28" },
      decorate: (message) =>
        "method" in message
          ? {
              ...message,
              params: {
                ...(typeof message.params === "object" && message.params
                  ? message.params
                  : {}),
                decorated: true,
              },
            }
          : message,
    });
    controller.abort();
    await expect(aborted).rejects.toThrow(/aborted/);
    expect(transport.sent.some((message) => "method" in message && message.method === "notifications/cancelled")).toBe(
      true,
    );
    expect(transport.sent.at(-1)).toMatchObject({
      method: "notifications/cancelled",
      params: { requestId: 1, decorated: true },
    });
    expect(transport.sentHeaders.at(-1)).toEqual({
      "MCP-Protocol-Version": "2026-07-28",
    });

    const hanging = peer.request("tools/list", {});
    await peer.close();
    await expect(hanging).rejects.toThrow(/closed/);
    await expect(peer.request("tools/list", {})).rejects.toThrow(/closed/);
  });
});
