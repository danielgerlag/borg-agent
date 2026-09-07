import { describe, expect, it, vi } from "vitest";
import { ImapCodec, ImapError } from "../src/imap-codec";
import { createTlsPair, ScriptedImapServer } from "./harness";

describe("ImapCodec", () => {
  it("logs in, selects, and appends over a duplex pair", async () => {
    const { client, peer } = createTlsPair();
    const server = new ScriptedImapServer(peer);
    const codec = new ImapCodec(client);
    const signal = new AbortController().signal;

    const session = (async () => {
      await codec.readGreeting(signal);
      await codec.login("borg@example.com", "secret", signal);
      await codec.select("INBOX", signal);
    })();

    await server.greet();
    await server.expectLogin("borg@example.com", "secret");
    await server.expectSelect("INBOX", 0);
    await session;

    const appendPeer = server.expectAppend();
    const receipt = await codec.append("INBOX", "outbound text", signal);
    const appended = await appendPeer;
    expect(appended).toContain("outbound text");
    expect(receipt.externalId).toBe("imap:42");
    expect(JSON.stringify(receipt)).not.toContain("secret");

    await client.close();
    await peer.close();
  });

  it("IDLEs and FETCHes new messages into ingest", async () => {
    const { client, peer } = createTlsPair();
    const server = new ScriptedImapServer(peer);
    const codec = new ImapCodec(client);
    const controller = new AbortController();
    const drafts: { readonly text: string; readonly externalId: string }[] = [];

    const ready = (async () => {
      await codec.readGreeting(controller.signal);
      await codec.login("borg@example.com", "secret", controller.signal);
      await codec.select("INBOX", controller.signal);
    })();
    await server.greet();
    await server.expectLogin("borg@example.com", "secret");
    await server.expectSelect("INBOX", 0);
    await ready;

    const idle = codec.idleAndFetch(async (draft) => {
      drafts.push({ text: draft.text, externalId: draft.externalId });
    }, controller.signal);
    await server.expectIdle();
    await server.announceExists(1);
    await server.expectDone();
    await server.expectFetchAndReply("hello mailbox", 17);
    await vi.waitFor(() => expect(drafts).toHaveLength(1));
    expect(drafts[0]).toEqual({
      text: "hello mailbox",
      externalId: "imap:17",
    });

    controller.abort();
    await server.expectIdle().catch(() => undefined);
    await client.close();
    await peer.close();
    await idle.catch(() => undefined);
  });

  it("rejects LOGIN without echoing the password", async () => {
    const { client, peer } = createTlsPair();
    const server = new ScriptedImapServer(peer);
    const codec = new ImapCodec(client);
    const signal = new AbortController().signal;
    const login = (async () => {
      await codec.readGreeting(signal);
      await codec.login("borg@example.com", "super-secret-password", signal);
    })();
    await server.greet();
    const line = await server.readLine();
    expect(line).toContain("LOGIN");
    const tag = line.split(" ")[0] ?? "A0001";
    await server.writeLine(`${tag} NO [AUTHENTICATIONFAILED] denied`);
    await expect(login).rejects.toBeInstanceOf(ImapError);
    await expect(login).rejects.toEqual(
      expect.not.objectContaining({
        message: expect.stringContaining("super-secret-password"),
      }),
    );
    await client.close();
    await peer.close();
  });
});
