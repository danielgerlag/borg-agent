import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WebSocketService,
  type WebSocketLike,
  type WebSocketServiceOptions,
} from "../src/websocket-service";

const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 3;

class FakeSocket implements WebSocketLike {
  readyState = CONNECTING;
  binaryType = "blob";
  readonly sent: string[] = [];
  readonly closes: { readonly code?: number | undefined; readonly reason?: string | undefined }[] =
    [];
  readonly refusedCodes = new Set<number>();
  failSend = false;
  readonly #listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(
    readonly url: string,
    readonly protocols?: readonly string[] | undefined,
  ) {}

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.#listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    if (this.failSend) {
      throw new Error("socket send failed");
    }
    if (this.readyState !== OPEN) {
      throw new Error("socket is not open");
    }
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    if (code !== undefined && this.refusedCodes.has(code)) {
      throw new Error("invalid code");
    }
    this.closes.push({ code, reason });
    this.readyState = CLOSED;
  }

  countListeners(type: string): number {
    return this.#listeners.get(type)?.size ?? 0;
  }

  open(): void {
    this.readyState = OPEN;
    this.#dispatch("open", {});
  }

  deliver(data: unknown): void {
    this.#dispatch("message", { data });
  }

  fail(message = "socket error"): void {
    this.#dispatch("error", { message });
  }

  remoteClose(code: number, reason = ""): void {
    this.readyState = CLOSED;
    this.#dispatch("close", { code, reason });
  }

  #dispatch(type: string, event: unknown): void {
    for (const listener of [...(this.#listeners.get(type) ?? [])]) {
      listener(event);
    }
  }
}

const activeServices: WebSocketService[] = [];

function createService(options: WebSocketServiceOptions = {}): {
  readonly service: WebSocketService;
  readonly sockets: FakeSocket[];
} {
  const sockets: FakeSocket[] = [];
  const service = new WebSocketService({
    webSocketFactory: (url, protocols) => {
      const socket = new FakeSocket(url, protocols);
      sockets.push(socket);
      return socket;
    },
    ...options,
  });
  activeServices.push(service);
  return { service, sockets };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("WebSocketService", () => {
  afterEach(() => {
    for (const service of activeServices.splice(0)) {
      service.shutdown();
    }
  });

  it("rejects unsupported protocols and URL credentials without creating a socket", async () => {
    const { service, sockets } = createService();
    await expect(
      service.connect("test.socket", "https://example.com/socket"),
    ).rejects.toThrow(/ws and wss/);
    await expect(
      service.connect("test.socket", "wss://user:hunter2@example.com/socket"),
    ).rejects.toThrow(/credentials/);
    await expect(service.connect("test.socket", "not a url")).rejects.toThrow(
      /URL is invalid/,
    );
    expect(sockets).toHaveLength(0);

    const audit = service.listAudit();
    expect(audit).toEqual([
      {
        pluginId: "test.socket",
        origin: "https://example.com",
        outcome: "rejected",
        failure: "unsupported-protocol",
      },
      {
        pluginId: "test.socket",
        origin: "wss://example.com",
        outcome: "rejected",
        failure: "url-credentials",
      },
      {
        pluginId: "test.socket",
        origin: "null",
        outcome: "rejected",
        failure: "invalid-url",
      },
    ]);
    expect(JSON.stringify(audit)).not.toContain("hunter2");
  });

  it("validates subprotocols and forwards accepted ones", async () => {
    const { service, sockets } = createService();
    await expect(
      service.connect("test.socket", "wss://example.com/socket", {
        protocols: ["bad protocol"],
      }),
    ).rejects.toThrow(/subprotocols are invalid/);
    await expect(
      service.connect("test.socket", "wss://example.com/socket", {
        protocols: ["a", "a"],
      }),
    ).rejects.toThrow(/subprotocols are invalid/);

    await service.connect("test.socket", "wss://example.com/socket", {
      protocols: ["graphql-ws"],
    });
    expect(sockets[0]?.protocols).toEqual(["graphql-ws"]);
    expect(sockets[0]?.binaryType).toBe("arraybuffer");
  });

  it("caps live sockets per plugin and frees slots when they close", async () => {
    const { service, sockets } = createService();
    for (let index = 0; index < 4; index += 1) {
      await service.connect("test.socket", "wss://example.com/socket");
    }
    expect(service.countOwned("test.socket")).toBe(4);
    await expect(
      service.connect("test.socket", "wss://example.com/socket"),
    ).rejects.toThrow(/already holds 4 sockets/);
    await service.connect("other.socket", "wss://example.com/socket");

    sockets[0]?.open();
    sockets[0]?.remoteClose(1000, "done");
    expect(service.countOwned("test.socket")).toBe(3);
    await expect(
      service.connect("test.socket", "wss://example.com/socket"),
    ).resolves.toBeDefined();
  });

  it("resolves ready on open and rejects when the socket closes or fails first", async () => {
    const { service, sockets } = createService();
    const opened = await service.connect("test.socket", "wss://example.com/socket");
    sockets[0]?.open();
    await expect(opened.ready).resolves.toBeUndefined();

    const closedEarly = await service.connect(
      "test.socket",
      "wss://example.com/socket",
    );
    sockets[1]?.remoteClose(1006);
    await expect(closedEarly.ready).rejects.toThrow(/closed before it opened/);

    const failedEarly = await service.connect(
      "test.socket",
      "wss://example.com/socket",
    );
    sockets[2]?.fail("handshake rejected");
    await expect(failedEarly.ready).rejects.toThrow(/handshake rejected/);
    expect(service.listAudit()).toEqual([
      expect.objectContaining({ outcome: "opened" }),
      expect.objectContaining({ outcome: "failed", failure: "closed-before-open" }),
      expect.objectContaining({ outcome: "failed", failure: "handshake-failed" }),
    ]);
  });

  it("rejects ready when the handshake exceeds the open timeout", async () => {
    const { service, sockets } = createService({ openTimeoutMs: 5 });
    const connection = await service.connect(
      "test.socket",
      "wss://example.com/socket",
    );
    await expect(connection.ready).rejects.toThrow(/did not open in time/);
    expect(sockets[0]?.closes).toEqual([{ code: 1000, reason: undefined }]);
    expect(service.listAudit()).toEqual([
      expect.objectContaining({ outcome: "failed", failure: "open-timeout" }),
    ]);
  });

  it("does not surface an unawaited ready rejection as an unhandled rejection", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onRejection);
    try {
      const { service, sockets } = createService();
      await service.connect("test.socket", "wss://example.com/socket");
      sockets[0]?.remoteClose(1006);
      await flush();
    } finally {
      process.off("unhandledRejection", onRejection);
    }
    expect(rejections).toEqual([]);
  });

  it("validates outbound payloads before they reach the socket", async () => {
    const { service, sockets } = createService();
    const connection = await service.connect(
      "test.socket",
      "wss://example.com/socket",
      { maxMessageBytes: 8 },
    );
    expect(() => connection.send("too early")).toThrow(/not open/);
    sockets[0]?.open();
    await connection.ready;

    expect(() => connection.send("Ω".repeat(5))).toThrow(/exceeds the 8 byte limit/);
    expect(() => connection.send(42 as unknown as string)).toThrow(/must be strings/);
    connection.send("ok");
    expect(sockets[0]?.sent).toEqual(["ok"]);
  });

  it("closes with 1009 when an inbound frame is oversized", async () => {
    const { service, sockets } = createService();
    const connection = await service.connect(
      "test.socket",
      "wss://example.com/socket",
      { maxMessageBytes: 4 },
    );
    const received: string[] = [];
    connection.onMessage((data) => {
      received.push(data);
    });
    sockets[0]?.open();
    await connection.ready;
    sockets[0]?.deliver("way too long for the bound");
    await flush();

    expect(received).toEqual([]);
    expect(sockets[0]?.closes).toEqual([{ code: 1009, reason: undefined }]);
    expect(service.listAudit()).toEqual([
      expect.objectContaining({ outcome: "opened" }),
      expect.objectContaining({
        outcome: "failed",
        code: 1009,
        failure: "message-too-large",
      }),
    ]);
  });

  it("closes with 1009 when the inbound queue overflows", async () => {
    const { service, sockets } = createService();
    const connection = await service.connect(
      "test.socket",
      "wss://example.com/socket",
      { maxQueuedMessages: 1 },
    );
    const received: string[] = [];
    connection.onMessage(async (data) => {
      received.push(data);
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    sockets[0]?.open();
    await connection.ready;
    sockets[0]?.deliver("first");
    sockets[0]?.deliver("second");
    await flush();

    expect(sockets[0]?.closes).toEqual([{ code: 1009, reason: undefined }]);
    expect(service.listAudit()[1]).toMatchObject({
      code: 1009,
      failure: "queue-overflow",
    });
  });

  it("falls back to a normal closure when a reserved code is refused", async () => {
    const { service, sockets } = createService();
    const connection = await service.connect(
      "test.socket",
      "wss://example.com/socket",
      { maxMessageBytes: 4 },
    );
    sockets[0]?.refusedCodes.add(1009);
    sockets[0]?.open();
    await connection.ready;
    sockets[0]?.deliver("oversized frame");
    await flush();

    expect(sockets[0]?.closes).toEqual([{ code: 1000, reason: undefined }]);
    expect(service.listAudit()[1]).toMatchObject({
      code: 1009,
      failure: "message-too-large",
    });
  });

  it("decodes string, arraybuffer, and blob frames in order", async () => {
    const { service, sockets } = createService();
    const connection = await service.connect(
      "test.socket",
      "wss://example.com/socket",
    );
    const received: string[] = [];
    connection.onMessage((data) => {
      received.push(data);
    });
    sockets[0]?.open();
    await connection.ready;
    sockets[0]?.deliver("first");
    sockets[0]?.deliver(new TextEncoder().encode("second").buffer);
    sockets[0]?.deliver(new Blob(["third"]));
    await vi.waitFor(() => expect(received).toHaveLength(3));

    expect(received).toEqual(["first", "second", "third"]);
  });

  it("isolates handler failures across message, close, and error handlers", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onRejection);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { service, sockets } = createService();
      const connection = await service.connect(
        "test.socket",
        "wss://example.com/socket",
      );
      const seen: string[] = [];
      connection.onMessage(() => {
        throw new Error("sync handler failed");
      });
      connection.onMessage(async () => {
        await Promise.resolve();
        throw new Error("async handler failed");
      });
      connection.onMessage((data) => {
        seen.push(data);
      });
      connection.onClose(() => {
        throw new Error("close handler failed");
      });
      sockets[0]?.open();
      await connection.ready;
      sockets[0]?.deliver("payload");
      await vi.waitFor(() => expect(seen).toEqual(["payload"]));
      sockets[0]?.remoteClose(1000, "bye");
      await flush();
    } finally {
      errors.mockRestore();
      process.off("unhandledRejection", onRejection);
    }
    expect(rejections).toEqual([]);
  });

  it("delivers remote close details once and then stops", async () => {
    const { service, sockets } = createService();
    const connection = await service.connect(
      "test.socket",
      "wss://example.com/socket",
    );
    const closes: { readonly code: number; readonly reason: string }[] = [];
    connection.onClose((code, reason) => {
      closes.push({ code, reason });
    });
    sockets[0]?.open();
    await connection.ready;
    sockets[0]?.remoteClose(3001, "server restart");
    sockets[0]?.remoteClose(3001, "server restart");
    await flush();

    expect(closes).toEqual([{ code: 3001, reason: "server restart" }]);
    expect(service.countOwned("test.socket")).toBe(0);
  });

  it("keeps plugin close codes and reasons inside safe bounds", async () => {
    const { service, sockets } = createService();
    const connection = await service.connect(
      "test.socket",
      "wss://example.com/socket",
    );
    sockets[0]?.open();
    await connection.ready;

    expect(() => connection.close(1009)).toThrow(/1000 or between 3000 and 4999/);
    expect(() => connection.close(2999)).toThrow(/1000 or between 3000 and 4999/);
    expect(() => connection.close(3000, "x".repeat(124))).toThrow(/123 bytes/);
    connection.close(3001, "done");
    expect(sockets[0]?.closes).toEqual([{ code: 3001, reason: "done" }]);
  });

  it("closes sockets and suppresses stale callbacks when a plugin is deactivated", async () => {
    const { service, sockets } = createService();
    const connection = await service.connect(
      "test.socket",
      "wss://example.com/socket",
    );
    const received: string[] = [];
    const closes: number[] = [];
    connection.onMessage((data) => {
      received.push(data);
    });
    connection.onClose((code) => {
      closes.push(code);
    });
    sockets[0]?.open();
    await connection.ready;

    service.abortOwned("test.socket");
    expect(sockets[0]?.closes).toEqual([{ code: 1001, reason: undefined }]);
    expect(sockets[0]?.countListeners("message")).toBe(0);
    sockets[0]?.deliver("after teardown");
    sockets[0]?.remoteClose(1001);
    await flush();

    expect(received).toEqual([]);
    expect(closes).toEqual([]);
    expect(service.countOwned("test.socket")).toBe(0);
    expect(() => connection.send("nope")).toThrow(/no longer usable/);
  });

  it("closes sockets when the caller aborts and when the service shuts down", async () => {
    const { service, sockets } = createService();
    const controller = new AbortController();
    const aborted = await service.connect(
      "test.socket",
      "wss://example.com/socket",
      { signal: controller.signal },
    );
    sockets[0]?.open();
    await aborted.ready;
    controller.abort(new Error("caller stopped"));
    expect(sockets[0]?.closes).toEqual([{ code: 1001, reason: undefined }]);

    const remaining = await service.connect(
      "test.socket",
      "wss://example.com/socket",
    );
    sockets[1]?.open();
    await remaining.ready;
    service.shutdown();
    expect(sockets[1]?.closes).toEqual([{ code: 1001, reason: undefined }]);
    await expect(
      service.connect("test.socket", "wss://example.com/socket"),
    ).rejects.toThrow(/shut down/);

    controller.abort();
    await expect(
      service.connect("test.socket", "wss://example.com/socket", {
        signal: controller.signal,
      }),
    ).rejects.toThrow(/shut down/);
  });

  it("rejects a connect whose signal is already aborted", async () => {
    const { service, sockets } = createService();
    const controller = new AbortController();
    controller.abort(new Error("stale"));
    await expect(
      service.connect("test.socket", "wss://example.com/socket", {
        signal: controller.signal,
      }),
    ).rejects.toThrow(/aborted/);
    expect(sockets).toHaveLength(0);
    expect(service.listAudit()).toEqual([
      expect.objectContaining({ outcome: "rejected", failure: "aborted" }),
    ]);
  });

  it("audits only the plugin, origin, and outcome", async () => {
    const { service, sockets } = createService({ auditCapacity: 2 });
    const connection = await service.connect(
      "test.socket",
      "wss://example.com/tenant/secret-path?token=hunter2",
    );
    sockets[0]?.open();
    await connection.ready;
    connection.send("secret payload");
    sockets[0]?.deliver("secret response");
    await flush();
    sockets[0]?.remoteClose(1000, "secret reason");
    await flush();

    const audit = service.listAudit();
    expect(audit).toHaveLength(2);
    expect(Object.isFrozen(audit[0])).toBe(true);
    const serialized = JSON.stringify(audit);
    expect(serialized).not.toContain("secret-path");
    expect(serialized).not.toContain("token=hunter2");
    expect(serialized).not.toContain("secret payload");
    expect(serialized).not.toContain("secret response");
    expect(serialized).not.toContain("secret reason");
    expect(audit[1]).toEqual({
      pluginId: "test.socket",
      origin: "wss://example.com",
      outcome: "closed",
      code: 1000,
    });
  });

  it("clamps message and queue bounds to the kernel maximums", async () => {
    const { service, sockets } = createService();
    const connection = await service.connect(
      "test.socket",
      "wss://example.com/socket",
      { maxMessageBytes: 8_000_000, maxQueuedMessages: 100_000 },
    );
    sockets[0]?.open();
    await connection.ready;

    expect(() => connection.send("x".repeat(1_048_577))).toThrow(
      /exceeds the 1048576 byte limit/,
    );
    connection.send("x".repeat(1_048_576));
    expect(sockets[0]?.sent).toHaveLength(1);
    await expect(
      service.connect("test.socket", "wss://example.com/socket", {
        maxMessageBytes: Number.NaN,
      }),
    ).rejects.toThrow(/message bound is invalid/);
  });
});
