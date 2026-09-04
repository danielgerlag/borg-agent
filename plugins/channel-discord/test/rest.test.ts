import { describe, expect, it } from "vitest";
import {
  DISCORD_API_BASE,
  MAX_OUTBOUND_CONTENT_LENGTH,
  MAX_REST_RESPONSE_BYTES,
} from "../src/protocol";
import { DiscordRestClient, DiscordRestError } from "../src/rest";
import { createFakeHttp, jsonResponse, type RecordedRequest } from "./harness";

const TOKEN = "MTIzNDU2Nzg5.super-secret-token";

function createClient(
  handler: (request: RecordedRequest) => Response | Promise<Response>,
  options: { readonly token?: string | undefined } = {},
) {
  const { http, requests } = createFakeHttp(handler);
  const sleeps: number[] = [];
  const client = new DiscordRestClient({
    http,
    readToken: async () =>
      "token" in options ? options.token : TOKEN,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { client, requests, sleeps };
}

describe("discord rest client", () => {
  it("verifies the bot against the pinned api base with a header-only token", async () => {
    const { client, requests } = createClient(() =>
      jsonResponse(200, { id: "300000000000000001", username: "borg" }),
    );

    await expect(client.verifyBot()).resolves.toEqual({
      botUserId: "300000000000000001",
      username: "borg",
    });

    const [request] = requests;
    expect(request?.url).toBe(`${DISCORD_API_BASE}/users/@me`);
    expect(request?.url.startsWith("https://discord.com/api/v10")).toBe(true);
    expect(request?.url).not.toContain(TOKEN);
    expect(request?.headers.Authorization).toBe(`Bot ${TOKEN}`);
  });

  it("reads the gateway url and session start limit from /gateway/bot", async () => {
    const { client, requests } = createClient(() =>
      jsonResponse(200, {
        url: "wss://gateway.discord.gg/",
        session_start_limit: { remaining: 0, reset_after: 4_200, total: 1_000 },
      }),
    );

    await expect(client.discoverGateway()).resolves.toEqual({
      url: "wss://gateway.discord.gg",
      sessionStartLimit: { remaining: 0, resetAfterMs: 4_200 },
    });
    expect(requests[0]?.url).toBe(`${DISCORD_API_BASE}/gateway/bot`);
  });

  it("refuses a gateway url that is not credential-free wss", async () => {
    for (const url of [
      "https://gateway.discord.gg",
      "wss://a:b@gateway.discord.gg",
      "wss://attacker.example",
      "wss://gateway.discord.gg:444",
    ]) {
      const { client } = createClient(() => jsonResponse(200, { url }));
      await expect(client.discoverGateway()).rejects.toThrow(
        "Discord returned an unusable gateway url",
      );
    }
  });

  it("posts a bounded message to an allow-listed channel and parses the id", async () => {
    const { client, requests } = createClient(() =>
      jsonResponse(200, { id: "700000000000000001", channel_id: "100000000000000001" }),
    );

    await expect(
      client.createMessage({
        channelId: "100000000000000001",
        content: "hello",
      }),
    ).resolves.toEqual({ messageId: "700000000000000001" });

    const [request] = requests;
    expect(request?.method).toBe("POST");
    expect(request?.url).toBe(
      `${DISCORD_API_BASE}/channels/100000000000000001/messages`,
    );
    expect(request?.body).toBe(JSON.stringify({ content: "hello" }));
    expect(request?.headers["Content-Type"]).toBe("application/json");
  });

  it("rejects unusable destinations and message bodies before any request", async () => {
    const { client, requests } = createClient(() => jsonResponse(200, {}));

    await expect(
      client.createMessage({ channelId: "not-a-snowflake", content: "hi" }),
    ).rejects.toThrow("Discord channel id is invalid");
    await expect(
      client.createMessage({ channelId: "100000000000000001", content: "" }),
    ).rejects.toThrow(/1 to 2000 characters/);
    await expect(
      client.createMessage({
        channelId: "100000000000000001",
        content: "x".repeat(MAX_OUTBOUND_CONTENT_LENGTH + 1),
      }),
    ).rejects.toThrow(/1 to 2000 characters/);
    expect(requests).toHaveLength(0);
  });

  it("rejects a response that claims an unusable message id", async () => {
    const { client } = createClient(() => jsonResponse(200, { id: "12" }));
    await expect(
      client.createMessage({ channelId: "100000000000000001", content: "hi" }),
    ).rejects.toThrow("Discord returned an unusable message id");
  });

  it("retries a 429 at most twice and honours retry_after", async () => {
    let calls = 0;
    const { client, sleeps, requests } = createClient(() => {
      calls += 1;
      return calls <= 2
        ? jsonResponse(429, { retry_after: 0.25 })
        : jsonResponse(200, { id: "700000000000000001" });
    });

    await expect(
      client.createMessage({ channelId: "100000000000000001", content: "hi" }),
    ).resolves.toEqual({ messageId: "700000000000000001" });
    expect(sleeps).toEqual([250, 250]);
    expect(requests).toHaveLength(3);
  });

  it("gives up after the retry budget is exhausted", async () => {
    const { client, sleeps, requests } = createClient(() =>
      jsonResponse(429, { retry_after: 1 }),
    );

    await expect(client.verifyBot()).rejects.toMatchObject({
      code: "rate-limited",
      status: 429,
    });
    expect(sleeps).toEqual([1_000, 1_000]);
    expect(requests).toHaveLength(3);
  });

  it("never waits longer than a minute for a rate limit", async () => {
    const { client, sleeps } = createClient(() =>
      jsonResponse(429, { retry_after: 3_600 }),
    );

    await expect(client.verifyBot()).rejects.toThrow(
      "Discord rate limited this request",
    );
    expect(sleeps).toEqual([]);
  });

  it("maps status codes to safe messages that cannot leak the token", async () => {
    const cases: readonly [number, string, boolean][] = [
      [401, "Discord rejected the bot token", true],
      [403, "Discord denied access to this resource", true],
      [404, "Discord could not find this resource", false],
      [500, "Discord request failed with status 500", false],
    ];
    for (const [status, message, fatal] of cases) {
      const { client } = createClient(() =>
        jsonResponse(status, { message: `leaky ${TOKEN}` }),
      );
      const error = await client.verifyBot().catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(DiscordRestError);
      expect((error as DiscordRestError).message).toBe(message);
      expect((error as DiscordRestError).message).not.toContain(TOKEN);
      expect((error as DiscordRestError).fatal).toBe(fatal);
    }
  });

  it("redacts the token from transport failures", async () => {
    const { client } = createClient(() => {
      throw new Error(`connect ECONNREFUSED with ${TOKEN}`);
    });
    const error = await client.verifyBot().catch((failure: unknown) => failure);
    expect((error as Error).message).not.toContain(TOKEN);
    expect((error as Error).message).toBe("Discord request failed");
  });

  it("refuses to send without a saved token", async () => {
    const { client, requests } = createClient(() => jsonResponse(200, {}), {
      token: undefined,
    });
    await expect(client.verifyBot()).rejects.toMatchObject({
      code: "auth",
      message: "Discord bot token is not saved",
    });
    expect(requests).toHaveLength(0);
  });

  it("bounds the response body it will read", async () => {
    const { client } = createClient(
      () =>
        new Response("x".repeat(MAX_REST_RESPONSE_BYTES + 10), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    await expect(client.verifyBot()).rejects.toThrow(
      "Discord response is too large",
    );
  });

  it("rejects a malformed body", async () => {
    const { client } = createClient(
      () =>
        new Response("{not json", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    await expect(client.verifyBot()).rejects.toThrow(
      "Discord returned a malformed response",
    );
  });
});
