import {
  m365ChannelConnect,
  m365ChannelDisconnect,
  m365ChannelGetStatus,
  m365ChannelInject,
  type M365ChannelStatus,
} from "@borg/contracts";
import { createTestHarness } from "@borg/plugin-sdk";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import plugin, { GRAPH_API_BASE, M365_ADAPTER_ID } from "../src/main";
import {
  createM365Harness,
  jsonResponse,
  settle,
  type RecordedRequest,
} from "./harness";

const MAILBOX = "borg@contoso.com";
const RECIPIENT = "alice@contoso.com";
const CLIENT_ID = "public-native-client";

function graphRoutes(
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
    if (request.url.endsWith("/v1.0/me") || request.url.endsWith("/v1.0/me/")) {
      return jsonResponse(200, { mail: MAILBOX });
    }
    if (request.url.includes("/mailFolders/inbox/messages")) {
      return jsonResponse(200, { value: [] });
    }
    if (request.url.endsWith("/v1.0/me/sendMail")) {
      return new Response(null, { status: 202 });
    }
    return jsonResponse(404, { message: "unexpected" });
  };
}

describe("borg.channel.m365 plugin", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  async function activate(
    options: Parameters<typeof createM365Harness>[0] = {},
  ) {
    const harness = createM365Harness({
      fetch: graphRoutes(),
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
      await harness.invoke<M365ChannelStatus>(m365ChannelGetStatus, {}),
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
      id: M365_ADAPTER_ID,
      capacity: "private",
    });
    await settle();
    const result = await harness.invoke<{
      accepted: true;
      externalId: string;
    }>(m365ChannelInject, {
      text: "injected without mailbox",
      sender: "bob@contoso.com",
    });
    expect(result.accepted).toBe(true);
    expect(harness.activeRegistration.drafts).toEqual([
      expect.objectContaining({
        text: "injected without mailbox",
        destinationId: "inbox",
        sender: "bob@contoso.com",
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
        adapterId: M365_ADAPTER_ID,
        destinationId: RECIPIENT,
        text: "hello",
        idempotencyKey: "k1",
      }),
    ).rejects.toThrow(/not connected/);
  });

  it("stores the mailbox from Graph /me on connect", async () => {
    const harness = await activate({
      config: { enabled: true, clientId: CLIENT_ID },
    });
    const status = await harness.invoke<M365ChannelStatus>(
      m365ChannelConnect,
      {},
    );
    expect(status).toMatchObject({
      connected: true,
      hasClientId: true,
      mailbox: MAILBOX,
    });
    expect(harness.oauth.connects).toBe(1);
    expect(harness.requests.some((request) => request.url === `${GRAPH_API_BASE}/v1.0/me`)).toBe(
      true,
    );
    expect(harness.requests.map((request) => `${request.url}\n${request.body ?? ""}`).join("\n")).not.toContain(
      "m365-access-token",
    );
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
    await harness.invoke(m365ChannelConnect, {});
    await settle();
    const receipt = await harness.activeRegistration.adapter.send({
      adapterId: M365_ADAPTER_ID,
      destinationId: RECIPIENT,
      text: "hello graph",
      idempotencyKey: "out-1",
    });
    expect(receipt.externalId.length).toBeGreaterThan(0);
    const send = harness.requests.find((request) =>
      request.url.endsWith("/v1.0/me/sendMail"),
    );
    expect(send?.url).toBe(`${GRAPH_API_BASE}/v1.0/me/sendMail`);
    expect(send?.body).toContain(RECIPIENT);
    await expect(
      harness.activeRegistration.adapter.send({
        adapterId: M365_ADAPTER_ID,
        destinationId: "eve@contoso.com",
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
    const status = await harness.invoke<M365ChannelStatus>(
      m365ChannelDisconnect,
      {},
    );
    expect(status.connected).toBe(false);
    expect(status.mailbox).toBeUndefined();
    expect(harness.oauth.disconnects).toBe(1);
  });
});
