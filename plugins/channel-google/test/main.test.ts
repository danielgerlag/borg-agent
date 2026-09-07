import {
  driveReadInputSchema,
  googleChannelConnect,
  googleChannelDisconnect,
  googleChannelGetStatus,
  googleChannelInject,
  type GoogleChannelStatus,
} from "@borg/contracts";
import { createTestHarness, type ToolContribution } from "@borg/plugin-sdk";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import plugin, { GMAIL_API_BASE, GOOGLE_ADAPTER_ID } from "../src/main";
import {
  GOOGLE_APIS_BASE,
  GOOGLE_SCOPES,
  PEOPLE_API_BASE,
  isAllowedGoogleApisPath,
  isAllowedPeoplePath,
} from "../src/protocol";
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
    const url = new URL(request.url);
    if (url.pathname === "/calendar/v3/calendars/primary/events") {
      if (request.method === "POST") {
        const payload = JSON.parse(request.body ?? "{}") as {
          readonly summary?: string;
          readonly start?: { readonly dateTime?: string };
          readonly end?: { readonly dateTime?: string };
        };
        return jsonResponse(200, {
          id: "evt-new",
          summary: payload.summary,
          start: payload.start,
          end: payload.end,
        });
      }
      return jsonResponse(200, {
        items: [
          {
            id: "evt-1",
            summary: "Standup",
            start: { dateTime: "2026-01-01T10:00:00.000Z" },
            end: { dateTime: "2026-01-01T10:30:00.000Z" },
            location: "Room A",
          },
        ],
      });
    }
    if (url.pathname === "/drive/v3/files") {
      return jsonResponse(200, {
        files: [
          { id: "file-1", name: "notes.txt", mimeType: "text/plain" },
        ],
      });
    }
    if (
      url.pathname.startsWith("/drive/v3/files/") &&
      url.searchParams.get("alt") === "media"
    ) {
      return new Response("hello from drive", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    }
    if (url.pathname.startsWith("/drive/v3/files/")) {
      return jsonResponse(200, {
        id: "file-1",
        name: "notes.txt",
        mimeType: "text/plain",
      });
    }
    if (url.pathname === "/v1/people:searchContacts") {
      return jsonResponse(200, {
        results: [
          {
            person: {
              resourceName: "people/c1",
              names: [{ displayName: "Ada Lovelace" }],
              emailAddresses: [{ value: "ada@gmail.com" }],
            },
          },
          {
            person: {
              resourceName: "people/skip",
              names: [],
              emailAddresses: [],
            },
          },
          {
            person: {
              resourceName: "people/c2",
              names: [{ givenName: "Grace", familyName: "Hopper" }],
              emailAddresses: [{ value: "grace@gmail.com" }],
            },
          },
        ],
      });
    }
    if (url.pathname === "/v1/people/me/connections") {
      return jsonResponse(200, {
        connections: [
          {
            resourceName: "people/c1",
            names: [{ displayName: "Ada Lovelace" }],
            emailAddresses: [{ value: "ada@gmail.com" }],
          },
          {
            resourceName: "people/c3",
            emailAddresses: [{ value: "nameless@gmail.com" }],
          },
        ],
      });
    }
    return jsonResponse(404, { message: "unexpected" });
  };
}

const CONNECTOR_TOOL_IDS = [
  "google.calendar.list",
  "google.calendar.create",
  "google.drive.search",
  "google.drive.read",
  "google.contacts.search",
] as const;

function recordedText(harness: {
  readonly requests: readonly RecordedRequest[];
}): string {
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
    await harness.invoke(googleChannelConnect, {});
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
        sideEffect: id === "google.calendar.create",
        security: {
          outputClassification: "confidential",
          outputProvenance: "external",
          channelCapacity: "private",
        },
      })),
    );
    expect(harness.oauth.requests[0]?.extraAuthorizationParams).toMatchObject({
      prompt: "consent",
    });
    expect(harness.oauth.requests[0]?.scopes).toEqual([...GOOGLE_SCOPES]);
    await harness.invoke(googleChannelDisconnect, {});
    expect(harness.tools).toEqual([]);
  });

  it("lists and creates calendar events on pinned Google URLs", async () => {
    const harness = await activate({
      config: { enabled: true, clientId: CLIENT_ID },
      oauth: { connected: true },
    });
    await harness.invoke(googleChannelConnect, {});
    const listed = await executeTool(harness.tools, "google.calendar.list", {
      start: "2026-01-01T00:00:00.000Z",
      end: "2026-01-08T00:00:00.000Z",
      maxResults: 5,
    });
    expect(listed).toEqual({
      events: [
        {
          id: "evt-1",
          title: "Standup",
          start: "2026-01-01T10:00:00.000Z",
          end: "2026-01-01T10:30:00.000Z",
          location: "Room A",
        },
      ],
    });
    const listRequest = harness.requests.find((request) =>
      request.url.includes("/calendar/v3/calendars/primary/events?"),
    );
    expect(listRequest?.method).toBe("GET");
    const listUrl = new URL(listRequest?.url ?? "https://invalid.example/");
    expect(listUrl.origin).toBe(GOOGLE_APIS_BASE);
    expect(listUrl.pathname).toBe("/calendar/v3/calendars/primary/events");
    expect(listUrl.searchParams.get("timeMin")).toBe("2026-01-01T00:00:00.000Z");
    expect(listUrl.searchParams.get("timeMax")).toBe("2026-01-08T00:00:00.000Z");

    const created = await executeTool(harness.tools, "google.calendar.create", {
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
    const createRequest = harness.requests.find(
      (request) =>
        request.method === "POST" &&
        request.url === `${GOOGLE_APIS_BASE}/calendar/v3/calendars/primary/events`,
    );
    expect(createRequest).toBeDefined();
    expect(recordedText(harness)).not.toContain("google-access-token");
  });

  it("defaults the calendar list window to the next seven days", async () => {
    const harness = await activate({
      config: { enabled: true, clientId: CLIENT_ID },
      oauth: { connected: true },
    });
    await harness.invoke(googleChannelConnect, {});
    await executeTool(harness.tools, "google.calendar.list", {});
    const listRequest = harness.requests.find((request) =>
      request.url.includes("/calendar/v3/calendars/primary/events?"),
    );
    const listUrl = new URL(listRequest?.url ?? "https://invalid.example/");
    const start = Date.parse(listUrl.searchParams.get("timeMin") ?? "");
    const end = Date.parse(listUrl.searchParams.get("timeMax") ?? "");
    expect(end - start).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("searches and reads Drive files on pinned Google URLs", async () => {
    const harness = await activate({
      config: { enabled: true, clientId: CLIENT_ID },
      oauth: { connected: true },
    });
    await harness.invoke(googleChannelConnect, {});
    const found = await executeTool(harness.tools, "google.drive.search", {
      query: "notes",
    });
    expect(found).toEqual({
      files: [{ id: "file-1", name: "notes.txt", mimeType: "text/plain" }],
    });
    const searchRequest = harness.requests.find((request) => {
      const url = new URL(request.url);
      return url.pathname === "/drive/v3/files" && url.searchParams.has("q");
    });
    expect(searchRequest?.method).toBe("GET");
    const searchUrl = new URL(searchRequest?.url ?? "https://invalid.example/");
    expect(searchUrl.origin).toBe(GOOGLE_APIS_BASE);
    expect(searchUrl.searchParams.get("q")).toBe("notes");

    const read = await executeTool(harness.tools, "google.drive.read", {
      id: "file-1",
    });
    expect(read).toEqual({
      id: "file-1",
      name: "notes.txt",
      mimeType: "text/plain",
      text: "hello from drive",
    });
    expect(
      harness.requests.some((request) => {
        const url = new URL(request.url);
        return (
          url.origin === GOOGLE_APIS_BASE &&
          url.pathname === "/drive/v3/files/file-1" &&
          url.searchParams.get("alt") === "media"
        );
      }),
    ).toBe(true);
    expect(recordedText(harness)).not.toContain("google-access-token");
  });

  it("omits Drive text for binary files and rejects unsafe ids", async () => {
    const harness = await activate({
      config: { enabled: true, clientId: CLIENT_ID },
      oauth: { connected: true },
      fetch: gmailRoutes({
        "/drive/v3/files/bin-1": () =>
          jsonResponse(200, {
            id: "bin-1",
            name: "deck.pdf",
            mimeType: "application/pdf",
          }),
      }),
    });
    await harness.invoke(googleChannelConnect, {});
    await expect(
      executeTool(harness.tools, "google.drive.read", { id: "bin-1" }),
    ).resolves.toEqual({
      id: "bin-1",
      name: "deck.pdf",
      mimeType: "application/pdf",
    });
    expect(
      harness.requests.some((request) => request.url.includes("alt=media")),
    ).toBe(false);
    expect(() => driveReadInputSchema.parse({ id: "has/slash" })).toThrow();
    expect(driveReadInputSchema.parse({ id: "01ABC!file=" })).toEqual({
      id: "01ABC!file=",
    });
    expect(isAllowedGoogleApisPath("/drive/v3/files/has/slash", "GET")).toBe(
      false,
    );
  });

  it("searches contacts on the pinned People API origin", async () => {
    const harness = await activate({
      config: { enabled: true, clientId: CLIENT_ID },
      oauth: { connected: true },
    });
    await harness.invoke(googleChannelConnect, {});
    const found = await executeTool(harness.tools, "google.contacts.search", {
      query: "Ada",
      maxResults: 5,
    });
    expect(found).toEqual({
      contacts: [
        {
          id: "people/c1",
          name: "Ada Lovelace",
          emails: ["ada@gmail.com"],
        },
        {
          id: "people/c2",
          name: "Grace Hopper",
          emails: ["grace@gmail.com"],
        },
      ],
    });
    const searchRequest = harness.requests.find((request) => {
      const url = new URL(request.url);
      return url.pathname === "/v1/people:searchContacts";
    });
    expect(searchRequest?.method).toBe("GET");
    const searchUrl = new URL(searchRequest?.url ?? "https://invalid.example/");
    expect(searchUrl.origin).toBe(PEOPLE_API_BASE);
    expect(searchUrl.pathname).toBe("/v1/people:searchContacts");
    expect(searchUrl.searchParams.get("query")).toBe("Ada");
    expect(searchUrl.searchParams.get("pageSize")).toBe("5");
    expect(searchUrl.searchParams.get("readMask")).toBe(
      "names,emailAddresses",
    );

    const listed = await executeTool(harness.tools, "google.contacts.search", {});
    expect(listed).toEqual({
      contacts: [
        {
          id: "people/c1",
          name: "Ada Lovelace",
          emails: ["ada@gmail.com"],
        },
        {
          id: "people/c3",
          name: "nameless@gmail.com",
          emails: ["nameless@gmail.com"],
        },
      ],
    });
    const listRequest = harness.requests.find((request) => {
      const url = new URL(request.url);
      return url.pathname === "/v1/people/me/connections";
    });
    expect(listRequest?.method).toBe("GET");
    const listUrl = new URL(listRequest?.url ?? "https://invalid.example/");
    expect(listUrl.origin).toBe(PEOPLE_API_BASE);
    expect(listUrl.searchParams.get("personFields")).toBe(
      "names,emailAddresses",
    );
    expect(listUrl.searchParams.get("pageSize")).toBe("10");
    expect(recordedText(harness)).not.toContain("google-access-token");
  });

  it("forbids Google APIs paths outside calendar events and Drive files", () => {
    expect(
      isAllowedGoogleApisPath("/calendar/v3/calendars/primary/events", "GET"),
    ).toBe(true);
    expect(
      isAllowedGoogleApisPath("/calendar/v3/calendars/primary/events", "POST"),
    ).toBe(true);
    expect(isAllowedGoogleApisPath("/drive/v3/files", "GET")).toBe(true);
    expect(isAllowedGoogleApisPath("/drive/v3/files/file-1", "GET")).toBe(true);
    expect(isAllowedGoogleApisPath("/drive/v3/about", "GET")).toBe(false);
    expect(
      isAllowedGoogleApisPath("/calendar/v3/users/me/calendarList", "GET"),
    ).toBe(false);
    expect(isAllowedGoogleApisPath("/drive/v3/files", "POST")).toBe(false);
    expect(isAllowedGoogleApisPath("/v1/people:searchContacts", "GET")).toBe(
      false,
    );
  });

  it("forbids People API paths outside connections and searchContacts", () => {
    expect(isAllowedPeoplePath("/v1/people/me/connections", "GET")).toBe(true);
    expect(isAllowedPeoplePath("/v1/people:searchContacts", "GET")).toBe(true);
    expect(isAllowedPeoplePath("/v1/people:searchContacts", "POST")).toBe(false);
    expect(isAllowedPeoplePath("/v1/people/me", "GET")).toBe(false);
    expect(isAllowedPeoplePath("/v1/people/me/connections/foo", "GET")).toBe(
      false,
    );
    expect(isAllowedPeoplePath("/v1/otherContacts:search", "GET")).toBe(false);
    expect(isAllowedPeoplePath("/v1/people:createContact", "POST")).toBe(false);
  });
});
