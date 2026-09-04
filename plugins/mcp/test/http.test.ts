import { createServer, type IncomingMessage, type Server } from "node:http";
import { describe, expect, it } from "vitest";
import { MAX_JSONRPC_BYTES } from "../src/protocol";
import {
  LegacySseTransport,
  readSse,
  resolveSameOriginEndpoint,
} from "../src/sse";
import { StreamableHttpTransport } from "../src/streamable-http";
import { JsonRpcPeer } from "../src/json-rpc";

async function listen(handler: (req: IncomingMessage, res: import("node:http").ServerResponse) => void): Promise<{
  server: Server;
  url: string;
}> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("loopback server has no address");
  }
  return { server, url: `http://127.0.0.1:${address.port}/mcp` };
}

describe("Streamable HTTP transport", () => {
  it("accepts JSON responses and carries Mcp-Session-Id", async () => {
    const seen: string[] = [];
    const { server, url } = await listen((req, res) => {
      if (req.method === "DELETE") {
        res.statusCode = 200;
        res.end();
        return;
      }
      const sessionHeader = req.headers["mcp-session-id"];
      seen.push(
        Array.isArray(sessionHeader) ? sessionHeader[0] ?? "" : sessionHeader ?? "",
      );
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk as Buffer));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!raw) {
          res.statusCode = 204;
          res.end();
          return;
        }
        const body = JSON.parse(raw) as {
          id: number;
        };
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Mcp-Session-Id", "session-1");
        res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { ok: true } }));
      });
    });
    try {
      const transport = new StreamableHttpTransport({
        http: { fetch: globalThis.fetch.bind(globalThis) },
        url,
      });
      const peer = new JsonRpcPeer(transport);
      await expect(peer.request("tools/list", {})).resolves.toEqual({ ok: true });
      await expect(peer.request("tools/call", { name: "echo" })).resolves.toEqual({
        ok: true,
      });
      expect(transport.sessionId).toBe("session-1");
      expect(seen).toEqual(["", "session-1"]);
      await peer.close();
    } finally {
      server.close();
    }
  });

  it("parses request-scoped SSE responses and rejects id mismatch", async () => {
    const { server, url } = await listen((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk as Buffer));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          id: number;
          method?: string;
        };
        if (body.method === "bad") {
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id + 1, result: {} }));
          return;
        }
        if (body.method === "wrong-type") {
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: String(body.id),
              result: {},
            }),
          );
          return;
        }
        res.setHeader("Content-Type", "text/event-stream");
        res.write(
          `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { streamed: true } })}\n\n`,
        );
        if (body.method !== "open") {
          res.end();
        }
      });
    });
    try {
      const transport = new StreamableHttpTransport({
        http: { fetch: globalThis.fetch.bind(globalThis) },
        url,
      });
      const peer = new JsonRpcPeer(transport);
      await expect(peer.request("tools/list", {})).resolves.toEqual({
        streamed: true,
      });
      await expect(peer.request("open", {})).resolves.toEqual({
        streamed: true,
      });
      await expect(peer.request("bad", {})).rejects.toThrow(/id mismatch/);
      await expect(peer.request("wrong-type", {})).rejects.toThrow(/id mismatch/);
      await peer.close();
    } finally {
      server.close();
    }
  });

  it("rejects HTTP 202 for requests, multiple terminals, oversized JSON, and DELETEs the session", async () => {
    const methods: string[] = [];
    const sessionDeletes: string[] = [];
    const { server, url } = await listen((req, res) => {
      methods.push(`${req.method}`);
      if (req.method === "DELETE") {
        const session = req.headers["mcp-session-id"];
        sessionDeletes.push(Array.isArray(session) ? session[0] ?? "" : session ?? "");
        res.statusCode = 200;
        res.end();
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk as Buffer));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          id?: number;
          method?: string;
        };
        if (body.method === "notify") {
          res.statusCode = 202;
          res.end();
          return;
        }
        if (body.method === "bad-notify") {
          res.setHeader("Content-Type", "application/json");
          res.end(
            JSON.stringify({ jsonrpc: "2.0", id: 1, result: { forged: true } }),
          );
          return;
        }
        if (body.method === "accepted") {
          res.statusCode = 202;
          res.end();
          return;
        }
        if (body.method === "huge") {
          res.setHeader("Content-Type", "application/json");
          res.writeHead(200);
          res.write("x".repeat(MAX_JSONRPC_BYTES + 1));
          res.end();
          return;
        }
        if (body.method === "invalid-utf8") {
          res.setHeader("Content-Type", "application/json");
          res.end(Buffer.from([0xff]));
          return;
        }
        if (body.method === "rotated-session") {
          res.setHeader("Content-Type", "application/json");
          res.setHeader("Mcp-Session-Id", "session-other");
          res.end(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              result: { ok: true },
            }),
          );
          return;
        }
        if (body.method === "multi") {
          res.setHeader("Content-Type", "text/event-stream");
          const first = JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { a: 1 } });
          const second = JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { a: 2 } });
          res.end(`data: ${first}\n\ndata: ${second}\n\n`);
          return;
        }
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Mcp-Session-Id", "session-legacy");
        res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { ok: true } }));
      });
    });
    try {
      const transport = new StreamableHttpTransport({
        http: { fetch: globalThis.fetch.bind(globalThis) },
        url,
      });
      const peer = new JsonRpcPeer(transport);
      await expect(peer.request("initialize", {})).resolves.toEqual({ ok: true });
      await expect(peer.notify("notify", {})).resolves.toBeUndefined();
      await expect(peer.notify("bad-notify", {})).rejects.toThrow(
        /notification returned a response/,
      );
      await expect(peer.request("accepted", {})).rejects.toThrow(/notification-only/);
      await expect(peer.request("huge", {})).rejects.toThrow(/too large/);
      await expect(peer.request("invalid-utf8", {})).rejects.toThrow(
        /valid UTF-8/,
      );
      await expect(peer.request("rotated-session", {})).rejects.toThrow(
        /session id/,
      );
      await expect(peer.request("multi", {})).rejects.toThrow(/multiple responses/);
      await peer.close();
      expect(sessionDeletes).toEqual(["session-legacy"]);
      expect(methods).toContain("DELETE");
    } finally {
      server.close();
    }
  });

  it("sends the latest valid MCP-Protocol-Version on session DELETE", async () => {
    const deleteVersions: string[] = [];
    const { server, url } = await listen((req, res) => {
      if (req.method === "DELETE") {
        const version = req.headers["mcp-protocol-version"];
        deleteVersions.push(
          Array.isArray(version) ? version[0] ?? "" : version ?? "",
        );
        res.statusCode = 200;
        res.end();
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk as Buffer));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          id: number;
        };
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Mcp-Session-Id", "session-versioned");
        res.end(
          JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { ok: true } }),
        );
      });
    });
    try {
      const transport = new StreamableHttpTransport({
        http: { fetch: globalThis.fetch.bind(globalThis) },
        url,
      });
      const peer = new JsonRpcPeer(transport);
      await expect(
        peer.request("tools/list", {}, {
          headers: { "MCP-Protocol-Version": "2025-11-25" },
        }),
      ).resolves.toEqual({ ok: true });
      await expect(
        peer.request("tools/call", { name: "echo" }, {
          headers: { "mcp-protocol-version": "2026-07-28" },
        }),
      ).resolves.toEqual({ ok: true });
      await peer.close();
      expect(deleteVersions).toEqual(["2026-07-28"]);
    } finally {
      server.close();
    }
  });
});

describe("legacy SSE transport", () => {
  it("parses CRLF event boundaries split across chunks", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("event: message\r"));
        controller.enqueue(encoder.encode("\ndata: one\r"));
        controller.enqueue(encoder.encode("\r\n"));
        controller.close();
      },
    });
    const events: { readonly event: string; readonly data: string }[] = [];
    await readSse(stream, (event) => {
      events.push(event);
    });
    expect(events).toEqual([{ event: "message", data: "one" }]);
  });

  it("validates same-origin endpoints and POSTs JSON-RPC messages", async () => {
    expect(() =>
      resolveSameOriginEndpoint("http://127.0.0.1:9", "https://example.test/mcp"),
    ).toThrow(/cross-origin/);
    expect(() =>
      resolveSameOriginEndpoint("http://127.0.0.1:9", "http://user:secret@127.0.0.1:9/mcp"),
    ).toThrow(/invalid/);

    let posted = "";
    let stream: import("node:http").ServerResponse | undefined;
    const { server, url } = await listen((req, res) => {
      if (req.method === "GET") {
        stream = res;
        res.setHeader("Content-Type", "text/event-stream");
        res.write(`event: endpoint\ndata: /messages\n\n`);
        return;
      }
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk as Buffer));
      req.on("end", () => {
        posted = Buffer.concat(chunks).toString("utf8");
        const body = JSON.parse(posted) as { id: number };
        stream?.write(
          `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { via: "sse" } })}\n\n`,
        );
        res.statusCode = 202;
        res.end();
      });
    });
    try {
      const transport = await LegacySseTransport.open({
        http: { fetch: globalThis.fetch.bind(globalThis) },
        url,
      });
      const peer = new JsonRpcPeer(transport);
      await expect(
        peer.request("initialize", { protocolVersion: "2025-11-25" }),
      ).resolves.toEqual({ via: "sse" });
      expect(posted).toContain("initialize");
      expect(posted).not.toContain("secret");
      await peer.close();
    } finally {
      server.close();
    }
  });

  it("closes the GET stream on timeout and open failure", async () => {
    let getClosed = 0;
    const { server, url } = await listen((req, res) => {
      req.on("close", () => {
        getClosed += 1;
      });
      if (req.url === "/mcp") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(": keepalive\n\n");
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    try {
      await expect(
        LegacySseTransport.open({
          http: { fetch: globalThis.fetch.bind(globalThis) },
          url,
          endpointTimeoutMs: 50,
        }),
      ).rejects.toThrow(/timed out/);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(getClosed).toBeGreaterThan(0);
    } finally {
      server.close();
    }

    const failed = await listen((_req, res) => {
      res.statusCode = 500;
      res.end("nope");
    });
    try {
      await expect(
        LegacySseTransport.open({
          http: { fetch: globalThis.fetch.bind(globalThis) },
          url: failed.url,
        }),
      ).rejects.toThrow(/handshake failed/);
    } finally {
      failed.server.close();
    }
  });

  it("rejects pending calls when the established SSE stream ends", async () => {
    let stream: import("node:http").ServerResponse | undefined;
    const { server, url } = await listen((req, res) => {
      if (req.method === "GET") {
        stream = res;
        res.setHeader("Content-Type", "text/event-stream");
        res.write(`event: endpoint\ndata: /messages\n\n`);
        return;
      }
      res.statusCode = 202;
      res.end();
      stream?.end();
    });
    try {
      const transport = await LegacySseTransport.open({
        http: { fetch: globalThis.fetch.bind(globalThis) },
        url,
      });
      const peer = new JsonRpcPeer(transport);
      await expect(peer.request("tools/list", {})).rejects.toThrow(/closed/);
    } finally {
      server.close();
    }
  });

  it("closes an established SSE stream after a malformed message", async () => {
    let stream: import("node:http").ServerResponse | undefined;
    const { server, url } = await listen((req, res) => {
      if (req.method === "GET") {
        stream = res;
        res.setHeader("Content-Type", "text/event-stream");
        res.write(`event: endpoint\ndata: /messages\n\n`);
        return;
      }
      res.statusCode = 202;
      res.end();
      stream?.write("event: message\ndata: not-json\n\n");
    });
    try {
      const transport = await LegacySseTransport.open({
        http: { fetch: globalThis.fetch.bind(globalThis) },
        url,
      });
      const peer = new JsonRpcPeer(transport);
      await expect(peer.request("tools/list", {})).rejects.toThrow(/closed/);
    } finally {
      server.close();
    }
  });

  it("rejects oversized SSE frames and closes the GET stream", async () => {
    let getClosed = false;
    const { server, url } = await listen((req, res) => {
      req.on("close", () => {
        getClosed = true;
      });
      res.setHeader("Content-Type", "text/event-stream");
      res.write("data: ");
      res.write("x".repeat(MAX_JSONRPC_BYTES + 1));
    });
    try {
      await expect(
        LegacySseTransport.open({
          http: { fetch: globalThis.fetch.bind(globalThis) },
          url,
          endpointTimeoutMs: 1_000,
        }),
      ).rejects.toThrow(/too large/);
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(getClosed).toBe(true);
    } finally {
      server.close();
    }
  });
});
