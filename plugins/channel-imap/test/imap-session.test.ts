import { describe, expect, it, vi } from "vitest";
import { ImapFakeTransport } from "../src/runtime";
import { ImapSession } from "../src/imap-session";
import {
  createBackgroundRuntime,
  FakeTls,
  ScriptedImapServer,
} from "./harness";

describe("ImapSession", () => {
  it("connects over FakeTls without putting the password on connect options", async () => {
    const fake = new FakeTls();
    const controller = new AbortController();
    fake.onPeer = async (peer) => {
      const server = new ScriptedImapServer(peer);
      await server.greet("* OK IMAP4rev1 ready");
      await server.expectLogin("borg@example.com", "secret");
      await server.expectSelect("INBOX");
      await server.idleUntilAbort();
    };
    const session = new ImapSession({
      tls: fake,
      readPassword: async () => "secret",
      host: "imap.example.com",
      port: 993,
      username: "borg@example.com",
      mailbox: "INBOX",
      ingest: () => undefined,
    });
    const running = session.run(controller.signal);
    await vi.waitFor(() => expect(fake.connections).toHaveLength(1));
    expect(fake.connections[0]).toMatchObject({
      host: "imap.example.com",
      port: 993,
    });
    expect(JSON.stringify(fake.connections)).not.toContain("secret");
    await vi.waitFor(() => expect(session.connected).toBe(true));
    controller.abort();
    await session.dispose();
    await running.catch(() => undefined);
  });
});

describe("ImapFakeTransport live send", () => {
  it("APPENDs when a live session is connected and keeps fake send otherwise", async () => {
    const fake = new FakeTls();
    let releaseIdle: (() => void) | undefined;
    const idling = new Promise<void>((resolve) => {
      releaseIdle = resolve;
    });
    fake.onPeer = async (peer) => {
      const server = new ScriptedImapServer(peer);
      await server.greet();
      await server.expectLogin("borg@example.com", "secret");
      await server.expectSelect("INBOX");
      await server.expectIdle();
      releaseIdle?.();
      await server.expectDone();
      const appended = await server.expectAppend();
      expect(appended).toContain("live outbound");
    };
    const transport = new ImapFakeTransport({
      id: "borg.channel.imap",
      tls: fake,
      runtime: createBackgroundRuntime(),
      readPassword: async () => "secret",
    });
    transport.configureEndpoint({
      host: "imap.example.com",
      port: 993,
      username: "borg@example.com",
    });
    const started = transport.start({
      ingest: () => undefined,
      signal: new AbortController().signal,
    });
    await vi.waitFor(() => expect(fake.connections).toHaveLength(1));
    expect(JSON.stringify(fake.connections)).not.toContain("secret");
    await idling;
    const receipt = await transport.send({
      adapterId: "borg.channel.imap",
      destinationId: "INBOX",
      text: "live outbound",
      idempotencyKey: "send-1",
    });
    expect(receipt.externalId).toBe("imap:42");

    await started.dispose();
    transport.dispose();

    const offline = new ImapFakeTransport({
      id: "borg.channel.imap",
      readPassword: async () => undefined,
    });
    offline.start({
      ingest: () => undefined,
      signal: new AbortController().signal,
    });
    const fakeReceipt = await offline.send({
      adapterId: "borg.channel.imap",
      destinationId: "INBOX",
      text: "fake outbound",
      idempotencyKey: "offline-1",
    });
    expect(fakeReceipt.externalId).toBe("imap:offline-1");
    offline.dispose();
  });
});
