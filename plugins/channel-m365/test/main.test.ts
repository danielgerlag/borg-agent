import {
  driveReadInputSchema,
  m365ChannelConnect,
  m365ChannelDisconnect,
  m365ChannelGetStatus,
  m365ChannelInject,
  type M365ChannelStatus,
} from "@borg/contracts";
import { createTestHarness, type ToolContribution } from "@borg/plugin-sdk";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import plugin, { GRAPH_API_BASE, M365_ADAPTER_ID } from "../src/main";
import { isAllowedGraphPath, M365_SCOPES } from "../src/protocol";
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
    if (request.url.includes("/v1.0/me/calendarView")) {
      return jsonResponse(200, {
        value: [
          {
            id: "evt-1",
            subject: "Standup",
            start: { dateTime: "2026-01-01T10:00:00.0000000", timeZone: "UTC" },
            end: { dateTime: "2026-01-01T10:30:00.0000000", timeZone: "UTC" },
            location: { displayName: "Room A" },
          },
        ],
      });
    }
    if (request.method === "POST" && request.url.endsWith("/v1.0/me/events")) {
      const payload = JSON.parse(request.body ?? "{}") as {
        readonly subject?: string;
        readonly start?: { readonly dateTime?: string };
        readonly end?: { readonly dateTime?: string };
      };
      return jsonResponse(201, {
        id: "evt-new",
        subject: payload.subject,
        start: payload.start,
        end: payload.end,
      });
    }
    if (request.url.includes("/v1.0/me/drive/root/search")) {
      return jsonResponse(200, {
        value: [
          {
            id: "file-1",
            name: "notes.txt",
            file: { mimeType: "text/plain" },
          },
        ],
      });
    }
    if (request.url.includes("/drive/items/") && request.url.includes("/content")) {
      return new Response("hello from drive", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    }
    if (request.url.includes("/v1.0/me/drive/items/")) {
      return jsonResponse(200, {
        id: "file-1",
        name: "notes.txt",
        file: { mimeType: "text/plain" },
      });
    }
    if (request.url.includes("/v1.0/me/contacts")) {
      return jsonResponse(200, {
        value: [
          {
            id: "ct-1",
            displayName: "Ada Lovelace",
            emailAddresses: [{ address: "ada@contoso.com" }],
          },
          {
            id: "ct-skip",
            displayName: "",
            emailAddresses: [],
          },
          {
            id: "ct-2",
            emailAddresses: [{ address: "nameless@contoso.com" }],
          },
        ],
      });
    }
    return jsonResponse(404, { message: "unexpected" });
  };
}

const CONNECTOR_TOOL_IDS = [
  "m365.calendar.list",
  "m365.calendar.create",
  "m365.drive.search",
  "m365.drive.read",
  "m365.contacts.search",
] as const;

function recordedText(harness: { readonly requests: readonly RecordedRequest[] }): string {
  return harness.requests
    .map((request) => `${request.url}\n${request.body ?? ""}`)
    .join("\n");
}

async function executeTool(
  tools: readonly ToolContribution[],
  id: string,
  input: unknown,
): Promise<unknown> {
  const tool = tools.find((candidate) => candidate.id === id);
  if (!tool) {
    throw new Error(`Missing tool ${id}`);
  }
  return tool.execute(input, {
    toolCallId: "call-1",
    signal: new AbortController().signal,
  });
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
      "tools.register",
      "ui.settings",
    ]);
    expect(manifest.contributes).toMatchObject({
      kinds: ["channel", "settingsPage", "tool"],
    });
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

  it("does not register calendar, Drive, or contacts tools until connected", async () => {
    const harness = await activate({
      config: { enabled: true, clientId: CLIENT_ID },
    });
    expect(harness.tools).toEqual([]);
  });

  it("registers five tools after a fake OAuth connect", async () => {
    const harness = await activate({
      config: { enabled: true, clientId: CLIENT_ID },
    });
    await harness.invoke(m365ChannelConnect, {});
    expect(harness.tools.map((tool) => tool.id)).toEqual([...CONNECTOR_TOOL_IDS]);
    expect(
      harness.tools.map((tool) => ({
        id: tool.id,
        approval: tool.approval,
        sideEffect: tool.sideEffect,
        security: tool.security,
      })),
    ).toEqual(
      CONNECTOR_TOOL_IDS.map((id) => ({
        id,
        approval: "ask",
        sideEffect: id === "m365.calendar.create",
        security: {
          outputClassification: "confidential",
          outputProvenance: "external",
          channelCapacity: "private",
        },
      })),
    );
    expect(harness.oauth.requests[0]?.extraAuthorizationParams).toEqual({
      prompt: "consent",
    });
    expect(harness.oauth.requests[0]?.scopes).toEqual([...M365_SCOPES]);
    await harness.invoke(m365ChannelDisconnect, {});
    expect(harness.tools).toEqual([]);
  });

  it("lists and creates calendar events on pinned Graph URLs", async () => {
    const harness = await activate({
      config: { enabled: true, clientId: CLIENT_ID },
      oauth: { connected: true },
    });
    await harness.invoke(m365ChannelConnect, {});
    const listed = await executeTool(harness.tools, "m365.calendar.list", {
      start: "2026-01-01T00:00:00.000Z",
      end: "2026-01-08T00:00:00.000Z",
      maxResults: 5,
    });
    expect(listed).toEqual({
      events: [
        {
          id: "evt-1",
          title: "Standup",
          start: "2026-01-01T10:00:00.0000000",
          end: "2026-01-01T10:30:00.0000000",
          location: "Room A",
        },
      ],
    });
    const listRequest = harness.requests.find((request) =>
      request.url.includes("/v1.0/me/calendarView"),
    );
    expect(listRequest?.method).toBe("GET");
    expect(listRequest?.url.startsWith(`${GRAPH_API_BASE}/v1.0/me/calendarView`)).toBe(
      true,
    );
    const listUrl = new URL(listRequest?.url ?? "https://invalid.example/");
    expect(listUrl.searchParams.get("startDateTime")).toBe("2026-01-01T00:00:00.000Z");
    expect(listUrl.searchParams.get("endDateTime")).toBe("2026-01-08T00:00:00.000Z");

    const created = await executeTool(harness.tools, "m365.calendar.create", {
      title: "Ship review",
      start: "2026-01-02T15:00:00.000Z",
      end: "2026-01-02T16:00:00.000Z",
    });
    expect(created).toEqual({
      id: "evt-new",
      title: "Ship review",
      start: "2026-01-02T15:00:00.000Z",
      end: "2026-01-02T16:00:00.000Z",
    });
    const createRequest = harness.requests.find((request) =>
      request.url.endsWith("/v1.0/me/events"),
    );
    expect(createRequest).toMatchObject({
      method: "POST",
      url: `${GRAPH_API_BASE}/v1.0/me/events`,
    });
    expect(recordedText(harness)).not.toContain("m365-access-token");
  });

  it("defaults the calendar list window to the next seven days", async () => {
    const harness = await activate({
      config: { enabled: true, clientId: CLIENT_ID },
      oauth: { connected: true },
    });
    await harness.invoke(m365ChannelConnect, {});
    await executeTool(harness.tools, "m365.calendar.list", {});
    const listRequest = harness.requests.find((request) =>
      request.url.includes("/v1.0/me/calendarView"),
    );
    const listUrl = new URL(listRequest?.url ?? "https://invalid.example/");
    const start = Date.parse(listUrl.searchParams.get("startDateTime") ?? "");
    const end = Date.parse(listUrl.searchParams.get("endDateTime") ?? "");
    expect(end - start).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("searches and reads Drive files on pinned Graph URLs", async () => {
    const harness = await activate({
      config: { enabled: true, clientId: CLIENT_ID },
      oauth: { connected: true },
    });
    await harness.invoke(m365ChannelConnect, {});
    const found = await executeTool(harness.tools, "m365.drive.search", {
      query: "notes",
    });
    expect(found).toEqual({
      files: [{ id: "file-1", name: "notes.txt", mimeType: "text/plain" }],
    });
    const searchRequest = harness.requests.find((request) =>
      request.url.includes("/v1.0/me/drive/root/search"),
    );
    expect(searchRequest?.method).toBe("GET");
    const searchUrl = new URL(searchRequest?.url ?? "https://invalid.example/");
    expect(searchUrl.origin).toBe(GRAPH_API_BASE);
    expect(searchUrl.pathname).toBe("/v1.0/me/drive/root/search");
    expect(searchUrl.searchParams.get("q")).toBe("notes");

    const read = await executeTool(harness.tools, "m365.drive.read", {
      id: "file-1",
    });
    expect(read).toEqual({
      id: "file-1",
      name: "notes.txt",
      mimeType: "text/plain",
      text: "hello from drive",
    });
    expect(
      harness.requests.some(
        (request) =>
          request.method === "GET" &&
          request.url.startsWith(`${GRAPH_API_BASE}/v1.0/me/drive/items/file-1`),
      ),
    ).toBe(true);
    expect(recordedText(harness)).not.toContain("m365-access-token");
  });

  it("omits Drive text for binary files and rejects unsafe ids", async () => {
    const harness = await activate({
      config: { enabled: true, clientId: CLIENT_ID },
      oauth: { connected: true },
      fetch: graphRoutes({
        "/v1.0/me/drive/items/bin-1": () =>
          jsonResponse(200, {
            id: "bin-1",
            name: "deck.pdf",
            file: { mimeType: "application/pdf" },
          }),
      }),
    });
    await harness.invoke(m365ChannelConnect, {});
    await expect(
      executeTool(harness.tools, "m365.drive.read", { id: "bin-1" }),
    ).resolves.toEqual({
      id: "bin-1",
      name: "deck.pdf",
      mimeType: "application/pdf",
    });
    expect(
      harness.requests.some((request) => request.url.includes("/content")),
    ).toBe(false);
    expect(() => driveReadInputSchema.parse({ id: "has/slash" })).toThrow();
    expect(driveReadInputSchema.parse({ id: "01ABC!file=" })).toEqual({
      id: "01ABC!file=",
    });
    expect(isAllowedGraphPath("/v1.0/me/drive/items/has/slash", "GET")).toBe(
      false,
    );
  });

  it("searches contacts on pinned Graph URLs", async () => {
    const harness = await activate({
      config: { enabled: true, clientId: CLIENT_ID },
      oauth: { connected: true },
    });
    await harness.invoke(m365ChannelConnect, {});
    const found = await executeTool(harness.tools, "m365.contacts.search", {
      query: "Ada",
      maxResults: 5,
    });
    expect(found).toEqual({
      contacts: [
        {
          id: "ct-1",
          name: "Ada Lovelace",
          emails: ["ada@contoso.com"],
        },
        {
          id: "ct-2",
          name: "nameless@contoso.com",
          emails: ["nameless@contoso.com"],
        },
      ],
    });
    const searchRequest = harness.requests.find((request) =>
      request.url.includes("/v1.0/me/contacts"),
    );
    expect(searchRequest?.method).toBe("GET");
    const searchUrl = new URL(searchRequest?.url ?? "https://invalid.example/");
    expect(searchUrl.origin).toBe(GRAPH_API_BASE);
    expect(searchUrl.pathname).toBe("/v1.0/me/contacts");
    expect(searchUrl.searchParams.get("$select")).toBe(
      "id,displayName,emailAddresses",
    );
    expect(searchUrl.searchParams.get("$top")).toBe("5");
    expect(searchUrl.searchParams.get("$filter")).toBe(
      "startswith(displayName,'Ada')",
    );

    await executeTool(harness.tools, "m365.contacts.search", {});
    const listRequest = harness.requests
      .filter((request) => request.url.includes("/v1.0/me/contacts"))
      .at(-1);
    const listUrl = new URL(listRequest?.url ?? "https://invalid.example/");
    expect(listUrl.origin).toBe(GRAPH_API_BASE);
    expect(listUrl.pathname).toBe("/v1.0/me/contacts");
    expect(listUrl.searchParams.get("$filter")).toBeNull();
    expect(listUrl.searchParams.get("$top")).toBe("10");
    expect(recordedText(harness)).not.toContain("m365-access-token");
  });

  it("escapes a quote in the Graph contacts OData filter", async () => {
    const harness = await activate({
      config: { enabled: true, clientId: CLIENT_ID },
      oauth: { connected: true },
    });
    await harness.invoke(m365ChannelConnect, {});
    await executeTool(harness.tools, "m365.contacts.search", {
      query: "O'Brien",
    });
    const searchRequest = harness.requests.find((request) =>
      request.url.includes("/v1.0/me/contacts"),
    );
    const searchUrl = new URL(searchRequest?.url ?? "https://invalid.example/");
    expect(searchUrl.searchParams.get("$filter")).toBe(
      "startswith(displayName,'O''Brien')",
    );
    expect(searchRequest?.url).not.toContain("startswith(displayName,'O'Brien')");
  });

  it("forbids Graph paths outside the mail, calendar, Drive, and contacts allowlist", () => {
    expect(isAllowedGraphPath("/v1.0/me/calendarView", "GET")).toBe(true);
    expect(isAllowedGraphPath("/v1.0/me/events", "POST")).toBe(true);
    expect(isAllowedGraphPath("/v1.0/me/drive/root/search", "GET")).toBe(true);
    expect(isAllowedGraphPath("/v1.0/me/drive/items/file-1/content", "GET")).toBe(
      true,
    );
    expect(isAllowedGraphPath("/v1.0/me/contacts", "GET")).toBe(true);
    expect(isAllowedGraphPath("/v1.0/me/events", "GET")).toBe(false);
    expect(isAllowedGraphPath("/v1.0/me/contacts", "POST")).toBe(false);
    expect(isAllowedGraphPath("/v1.0/users/foo/contacts", "GET")).toBe(false);
    expect(isAllowedGraphPath("/v1.0/me/people", "GET")).toBe(false);
    expect(isAllowedGraphPath("/v1.0/users/other/events", "POST")).toBe(false);
    expect(isAllowedGraphPath("/v1.0/me/drive/root/children", "GET")).toBe(false);
  });
});
