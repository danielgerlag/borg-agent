import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Duplex } from "node:stream";
import { createServer, connect as tlsConnect, type Server } from "node:tls";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TlsError,
  TlsService,
  parseTlsAuthority,
  type TlsConnectFactory,
  type TlsServiceOptions,
  type TlsTransport,
} from "../src/tls-service";

const PLUGIN_ID = "borg.channel.imap";

function fixturePem(commonName = "imap.test"): {
  readonly cert: string;
  readonly key: string;
} {
  const directory = mkdtempSync(path.join(tmpdir(), "borg-tls-"));
  const keyPath = path.join(directory, "key.pem");
  const certPath = path.join(directory, "cert.pem");
  const configPath = path.join(directory, "openssl.cnf");
  writeFileSync(
    configPath,
    `[req]
distinguished_name = req_distinguished_name
x509_extensions = v3_req
prompt = no
[req_distinguished_name]
CN = ${commonName}
[v3_req]
subjectAltName = DNS:${commonName}
`,
  );
  try {
    const result = spawnSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-sha256",
        "-nodes",
        "-keyout",
        keyPath,
        "-out",
        certPath,
        "-days",
        "1",
        "-config",
        configPath,
      ],
      { encoding: "utf8" },
    );
    if (result.status !== 0) {
      throw new Error(result.stderr || "openssl failed to create a test certificate");
    }
    return {
      cert: readFileSync(certPath, "utf8"),
      key: readFileSync(keyPath, "utf8"),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function wrapSocket(
  socket: import("node:tls").TLSSocket,
  signal: AbortSignal,
): Promise<TlsTransport> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, transport?: TlsTransport): void => {
      if (settled) {
        if (error) {
          socket.destroy();
        }
        return;
      }
      settled = true;
      signal.removeEventListener("abort", onAbort);
      if (error) {
        socket.destroy();
        reject(error);
        return;
      }
      if (!transport) {
        reject(new Error("TLS transport is unavailable"));
        return;
      }
      resolve(transport);
    };
    const onAbort = (): void => {
      finish(new TlsError("unavailable", "TLS connect was aborted"));
    };
    const onSecure = (): void => {
      const web = Duplex.toWeb(socket) as {
        readable: ReadableStream<Uint8Array>;
        writable: WritableStream<Uint8Array>;
      };
      finish(undefined, {
        readable: web.readable,
        writable: web.writable,
        destroy(error) {
          socket.destroy(error);
        },
      });
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    socket.once("secureConnect", onSecure);
    socket.once("error", (error) => finish(error));
  });
}

function connectWithTestCa(ca: string): TlsConnectFactory {
  return ({ host, port, servername, signal }) =>
    wrapSocket(
      tlsConnect({
        host,
        port,
        servername,
        ca: [ca],
        rejectUnauthorized: true,
        minVersion: "TLSv1.2",
      }),
      signal,
    );
}

async function listenTls(
  cert: string,
  key: string,
  handler?: (socket: import("node:tls").TLSSocket) => void,
): Promise<{ readonly server: Server; readonly port: number }> {
  const server = createServer({ cert, key }, (socket) => {
    handler?.(socket);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("TLS test server did not bind a port");
  }
  return { server, port: address.port };
}

async function readLine(
  readable: ReadableStream<Uint8Array>,
): Promise<string> {
  const reader = readable.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!buffer.includes("\n")) {
      const result = await reader.read();
      if (result.done) {
        throw new Error("TLS stream closed before a line arrived");
      }
      buffer += decoder.decode(result.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  return buffer.replace(/\r?\n[\s\S]*$/, "").replace(/\r$/, "");
}

const activeServices: TlsService[] = [];
const activeServers: Server[] = [];

function createService(options: TlsServiceOptions = {}): TlsService {
  const service = new TlsService(options);
  activeServices.push(service);
  return service;
}

describe("TlsService", () => {
  afterEach(async () => {
    for (const service of activeServices.splice(0)) {
      service.shutdown();
    }
    await Promise.all(
      activeServers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
          }),
      ),
    );
  });

  it("parses host and port and rejects credential-shaped authority", () => {
    expect(parseTlsAuthority({ host: "imap.example.com", port: 993 })).toEqual({
      host: "imap.example.com",
      port: 993,
      servername: "imap.example.com",
    });
    expect(parseTlsAuthority({ host: "[::1]", port: 993 })).toEqual({
      host: "::1",
      port: 993,
      servername: "::1",
    });
    expect(() =>
      parseTlsAuthority({ host: "imap.example.com:993", port: 993 }),
    ).toThrow(TlsError);
    expect(() => parseTlsAuthority({ host: "user@imap.example.com", port: 993 })).toThrow(
      /host is invalid/,
    );
    expect(() => parseTlsAuthority({ host: "/tmp/imap.sock", port: 993 })).toThrow(
      /host is invalid/,
    );
    expect(() => parseTlsAuthority({ host: "imap.example.com", port: 0 })).toThrow(
      /port is invalid/,
    );
    expect(() =>
      parseTlsAuthority({
        host: "imap.example.com",
        port: 993,
        servername: "imap.example.com:993",
      }),
    ).toThrow(/servername is invalid/);
  });

  it("connects through an injected factory to a local TLS server", async () => {
    const { cert, key } = fixturePem();
    const { server, port } = await listenTls(cert, key, (socket) => {
      socket.write("* OK IMAP4rev1 ready\r\n");
    });
    activeServers.push(server);

    const service = createService({
      tlsConnect: connectWithTestCa(cert),
    });
    const socket = await service.connect(PLUGIN_ID, {
      host: "127.0.0.1",
      port,
      servername: "imap.test",
    });
    const greeting = await readLine(socket.readable);
    expect(greeting).toBe("* OK IMAP4rev1 ready");
    expect(service.countOwned(PLUGIN_ID)).toBe(1);
    await socket.close();
    await socket.closed;
    expect(service.countOwned(PLUGIN_ID)).toBe(0);
    expect(service.listAudit()).toEqual([
      expect.objectContaining({
        pluginId: PLUGIN_ID,
        host: "127.0.0.1",
        port,
        servername: "imap.test",
        outcome: "opened",
      }),
      expect.objectContaining({ outcome: "closed" }),
    ]);
  });

  it("rejects the production factory against a self-signed certificate", async () => {
    const { cert, key } = fixturePem();
    const { server, port } = await listenTls(cert, key);
    activeServers.push(server);

    const service = createService();
    await expect(
      service.connect(PLUGIN_ID, {
        host: "127.0.0.1",
        port,
        servername: "imap.test",
      }),
    ).rejects.toMatchObject({
      name: "TlsError",
      code: "failed",
      message: expect.stringMatching(/untrusted/i),
    });
    expect(service.countOwned(PLUGIN_ID)).toBe(0);
    expect(service.listAudit()).toEqual([
      expect.objectContaining({
        outcome: "failed",
        failure: "cert-untrusted",
      }),
    ]);
    const serialized = JSON.stringify(service.listAudit());
    expect(serialized).not.toContain("BEGIN CERTIFICATE");
    expect(serialized).not.toContain(cert);
    expect(serialized).not.toContain(key);
  });

  it("rejects invalid authority without opening a socket", async () => {
    const calls: unknown[] = [];
    const service = createService({
      tlsConnect: async (options) => {
        calls.push(options);
        throw new Error("should not connect");
      },
    });
    await expect(
      service.connect(PLUGIN_ID, { host: "", port: 993 }),
    ).rejects.toThrow(/host is invalid/);
    await expect(
      service.connect(PLUGIN_ID, { host: "imap.example.com", port: 70_000 }),
    ).rejects.toThrow(/port is invalid/);
    expect(calls).toEqual([]);
    expect(service.listAudit().map((record) => record.failure)).toEqual([
      "invalid-host",
      "invalid-port",
    ]);
  });

  it("caps live sockets per plugin including in-flight handshakes", async () => {
    const blockers: Array<() => void> = [];
    const service = createService({
      handshakeTimeoutMs: 5_000,
      tlsConnect: ({ signal }) =>
        new Promise<TlsTransport>((_resolve, reject) => {
          const onAbort = (): void => {
            reject(new TlsError("unavailable", "TLS connect was aborted"));
          };
          signal.addEventListener("abort", onAbort, { once: true });
          blockers.push(() => {
            signal.removeEventListener("abort", onAbort);
            reject(new Error("released"));
          });
        }),
    });
    const pending = Array.from({ length: 4 }, () =>
      service.connect(PLUGIN_ID, { host: "imap.example.com", port: 993 }).catch(
        (error: unknown) => error,
      ),
    );
    await vi.waitFor(() => expect(service.countOwned(PLUGIN_ID)).toBe(4));
    await expect(
      service.connect(PLUGIN_ID, { host: "imap.example.com", port: 993 }),
    ).rejects.toThrow(/already holds 4 sockets/);
    expect(
      service.listAudit().some((record) => record.failure === "socket-limit"),
    ).toBe(true);

    service.abortOwned(PLUGIN_ID);
    expect(service.countOwned(PLUGIN_ID)).toBe(0);
    const extra = service
      .connect("other.plugin", { host: "imap.example.com", port: 993 })
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(service.countOwned("other.plugin")).toBe(1));
    service.abortOwned("other.plugin");
    for (const release of blockers) {
      release();
    }
    await Promise.all([...pending, extra]);
  });

  it("drops in-flight and live sockets on abortOwned", async () => {
    const { cert, key } = fixturePem();
    const { server, port } = await listenTls(cert, key, (socket) => {
      socket.write("hello\r\n");
    });
    activeServers.push(server);
    const service = createService({
      tlsConnect: connectWithTestCa(cert),
    });
    const hanging = service.connect(PLUGIN_ID, {
      host: "127.0.0.1",
      port,
      servername: "imap.test",
      signal: new AbortController().signal,
    });
    const opened = await hanging;
    expect(service.countOwned(PLUGIN_ID)).toBe(1);

    let handshakeReject: ((error: Error) => void) | undefined;
    const inFlight = createService({
      handshakeTimeoutMs: 5_000,
      tlsConnect: ({ signal }) =>
        new Promise<TlsTransport>((_resolve, reject) => {
          handshakeReject = reject;
          signal.addEventListener(
            "abort",
            () => reject(new TlsError("unavailable", "TLS connect was aborted")),
            { once: true },
          );
        }),
    });
    const pending = inFlight.connect(PLUGIN_ID, {
      host: "imap.example.com",
      port: 993,
    });
    await vi.waitFor(() => expect(inFlight.countOwned(PLUGIN_ID)).toBe(1));
    service.abortOwned(PLUGIN_ID);
    inFlight.abortOwned(PLUGIN_ID);
    await opened.closed;
    await expect(pending).rejects.toThrow(/aborted/);
    expect(service.countOwned(PLUGIN_ID)).toBe(0);
    expect(inFlight.countOwned(PLUGIN_ID)).toBe(0);
    handshakeReject?.(new Error("cleanup"));
  });

  it("rejects an already aborted signal and a shut down service", async () => {
    const service = createService({
      tlsConnect: async () => {
        throw new Error("should not connect");
      },
    });
    const controller = new AbortController();
    controller.abort(new Error("stale"));
    await expect(
      service.connect(PLUGIN_ID, {
        host: "imap.example.com",
        port: 993,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/aborted/);
    service.shutdown();
    await expect(
      service.connect(PLUGIN_ID, { host: "imap.example.com", port: 993 }),
    ).rejects.toThrow(/shut down/);
    expect(service.listAudit().map((record) => record.failure)).toEqual([
      "aborted",
      "shut-down",
    ]);
  });

  it("times out a hanging handshake", async () => {
    const service = createService({
      handshakeTimeoutMs: 20,
      tlsConnect: ({ signal }) =>
        new Promise<TlsTransport>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new TlsError("unavailable", "TLS connect was aborted")),
            { once: true },
          );
        }),
    });
    await expect(
      service.connect(PLUGIN_ID, { host: "imap.example.com", port: 993 }),
    ).rejects.toThrow(/timed out/);
    expect(service.listAudit()).toEqual([
      expect.objectContaining({
        outcome: "failed",
        failure: "handshake-timeout",
      }),
    ]);
    expect(service.countOwned(PLUGIN_ID)).toBe(0);
  });

  it("redacts PEM and filesystem paths from connect failures", async () => {
    const pem = `-----BEGIN CERTIFICATE-----\nMIIFAKESECRET\n-----END CERTIFICATE-----`;
    const service = createService({
      tlsConnect: async () => {
        throw new Error(`verify failed ${pem} at /secret/keys/imap.pem hunter2`);
      },
    });
    try {
      await service.connect(PLUGIN_ID, { host: "imap.example.com", port: 993 });
      throw new Error("expected TLS connect to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(TlsError);
      expect(String(error)).not.toContain("BEGIN CERTIFICATE");
      expect(String(error)).not.toContain("/secret/keys/imap.pem");
    }
    const serialized = JSON.stringify(service.listAudit());
    expect(serialized).not.toContain("BEGIN CERTIFICATE");
    expect(serialized).not.toContain("MIIFAKESECRET");
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("/secret/keys/imap.pem");
    expect(service.listAudit()[0]).toEqual({
      pluginId: PLUGIN_ID,
      host: "imap.example.com",
      port: 993,
      servername: "imap.example.com",
      outcome: "failed",
      failure: "connect-failed",
    });
    expect(Object.isFrozen(service.listAudit()[0])).toBe(true);
  });
});
