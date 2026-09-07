import {
  googleChannelConnect,
  googleChannelDisconnect,
  googleChannelGetStatus,
  googleChannelInject,
  type GoogleChannelStatus,
} from "@borg/contracts";
import { createTestHarness } from "@borg/plugin-sdk";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import plugin, { GMAIL_API_BASE, GOOGLE_ADAPTER_ID } from "../src/main";
import {
  createGoogleHarness,
  jsonResponse,
  settle,
  type RecordedRequest,
} from "./harness";

const MAILBOX = "borg@gmail.com";
const RECIPIENT = "alice@gmail.com";
const CLIENT_ID = "google-desktop-client";

function gmailRoutes(
  overrides: Readonly<
    Record<string, (request: RecordedRequest) => Response | Promise<Response>>
  > = {},
) {
  return (request: RecordedRequest): Response | Promise<Response> => {
    for (const [suffix, handler] of Object.entries(overrides)) {
      if (request.url.includes(suffix)) {
        return handler(request);
      }
    }
    if (request.url.includes("/gmail/v1/users/me/profile")) {
      return jsonResponse(200, { emailAddress: MAILBOX });
    }
    if (request.url.includes("/gmail/v1/users/me/messages/send")) {
      return jsonResponse(200, { id: "sent-1" });
    }
    if (request.url.includes("/gmail/v1/users/me/messages")) {
      return jsonResponse(200, { messages: [] });
    }
    return jsonResponse(404, { message: "unexpected" });
  };
}

describe("borg.channel.google plugin", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  async function activate(
    options: Parameters<typeof createGoogleHarness>[0] = {},
  ) {
    const harness = createGoogleHarness({
      fetch: gmailRoutes(),
      ...options,
    });
    const active = await createTestHarness(plugin, harness.context);
    cleanups.push(async () => {
      await active.deactivate();
    });
    await settle();
    return harness;
  }

  it("agrees with its static manifest", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../borg.plugin.json", import.meta.url), "utf8"),
    ) as Record<string, unknown>;
    expect(plugin).toMatchObject({
      id: manifest.id,
      version: manifest.version,
      permissions: manifest.permissions,
      contributes: manifest.contributes,
    });
    expect(manifest.permissions).toEqual([
      "channels.register",
      "oauth.connect",
      "network:dynamic",
      "runtime.background",
      "ui.settings",
    ]);
  });

  it("stays unregistered until enabled with a client id", async () => {
    const harness = await activate();
    expect(harness.registrations).toHaveLength(0);
    expect(
      await harness.invoke<GoogleChannelStatus>(googleChannelGetStatus, {}),
    ).toEqual({
      connected: false,
      hasClientId: false,
    });
  });

  it("registers without a mailbox so inject works without a grant", async () => {
    const harness = await activate({
      config: { enabled: true, clientId: CLIENT_ID },
    });
    expect(harness.registrations).toHaveLength(1);
    expect(harness.activeRegistration.adapter).toMatchObject({
      id: GOOGLE_ADAPTER_ID,
      capacity: "private",
    });
    await settle();
    const result = await harness.invoke<{
      accepted: true;
      externalId: string;
    }>(googleChannelInject, {
      text: "injected without mailbox",
      sender: "bob@gmail.com",
    });
    expect(result.accepted).toBe(true);
    expect(harness.activeRegistration.drafts).toEqual([
      expect.objectContaining({
        text: "injected without mailbox",
        destinationId: "inbox",
        sender: "bob@gmail.com",
      }),
    ]);
  });

  it("throws on send when disconnected", async () => {
    const harness = await activate({
      config: {
        enabled: true,
        clientId: CLIENT_ID,
        allowedRecipients: [RECIPIENT],
      },
    });
    await settle();
    await expect(
      harness.activeRegistration.adapter.send({
        adapterId: GOOGLE_ADAPTER_ID,
        destinationId: RECIPIENT,
        text: "hello",
        idempotencyKey: "k1",
      }),
    ).rejects.toThrow(/not connected/);
  });

  it("stores the mailbox from Gmail profile on connect", async () => {
    const harness = await activate({
      config: { enabled: true, clientId: CLIENT_ID },
    });
    const status = await harness.invoke<GoogleChannelStatus>(
      googleChannelConnect,
      {},
    );
    expect(status).toMatchObject({
      connected: true,
      hasClientId: true,
      mailbox: MAILBOX,
    });
    expect(harness.oauth.connects).toBe(1);
    expect(
      harness.requests.some((request) =>
        request.url.startsWith(`${GMAIL_API_BASE}/gmail/v1/users/me/profile`),
      ),
    ).toBe(true);
    expect(
      harness.requests
        .map((request) => `${request.url}\n${request.body ?? ""}`)
        .join("\n"),
    ).not.toContain("google-access-token");
  });

  it("sends only to allow-listed recipients after connect", async () => {
    const harness = await activate({
      config: {
        enabled: true,
        clientId: CLIENT_ID,
        allowedRecipients: [RECIPIENT],
      },
      oauth: { connected: true },
    });
    await harness.invoke(googleChannelConnect, {});
    await settle();
    const receipt = await harness.activeRegistration.adapter.send({
      adapterId: GOOGLE_ADAPTER_ID,
      destinationId: RECIPIENT,
      text: "hello gmail",
      idempotencyKey: "out-1",
    });
    expect(receipt.externalId).toBe("sent-1");
    const send = harness.requests.find((request) =>
      request.url.endsWith("/gmail/v1/users/me/messages/send"),
    );
    expect(send?.url).toBe(`${GMAIL_API_BASE}/gmail/v1/users/me/messages/send`);
    await expect(
      harness.activeRegistration.adapter.send({
        adapterId: GOOGLE_ADAPTER_ID,
        destinationId: "eve@gmail.com",
        text: "nope",
        idempotencyKey: "out-2",
      }),
    ).rejects.toThrow(/allow-listed/);
  });

  it("clears the mailbox on disconnect", async () => {
    const harness = await activate({
      config: { enabled: true, clientId: CLIENT_ID, mailbox: MAILBOX },
      oauth: { connected: true },
    });
    const status = await harness.invoke<GoogleChannelStatus>(
      googleChannelDisconnect,
      {},
    );
    expect(status.connected).toBe(false);
    expect(status.mailbox).toBeUndefined();
    expect(harness.oauth.disconnects).toBe(1);
  });
});
