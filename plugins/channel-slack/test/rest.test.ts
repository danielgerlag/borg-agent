import { describe, expect, it } from "vitest";
import {
  MAX_OUTBOUND_CONTENT_LENGTH,
  MAX_REST_RESPONSE_BYTES,
  SLACK_API_BASE,
} from "../src/protocol";
import { SlackRestClient, SlackRestError } from "../src/rest";
import { createFakeHttp, jsonResponse, type RecordedRequest } from "./harness";

const BOT_TOKEN = "xoxb-super-secret-bot-token";
const APP_TOKEN = "xapp-super-secret-app-token";
const CHANNEL_ID = "C01234567";
const SOCKET_URL = "wss://wss-primary.slack.com/link?ticket=test-ticket";

function createClient(
  handler: (request: RecordedRequest) => Response | Promise<Response>,
  options: {
    readonly botToken?: string | undefined;
    readonly appToken?: string | undefined;
  } = {},
) {
  const { http, requests } = createFakeHttp(handler);
  const sleeps: number[] = [];
  const client = new SlackRestClient({
    http,
    readBotToken: async () =>
      "botToken" in options ? options.botToken : BOT_TOKEN,
    readAppToken: async () =>
      "appToken" in options ? options.appToken : APP_TOKEN,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { client, requests, sleeps };
}

describe("slack rest client", () => {
  it("verifies the bot against the pinned api base with a header-only token", async () => {
    const { client, requests } = createClient(() =>
      jsonResponse(200, { ok: true, user_id: "U01234567", team: "borg" }),
    );

    await expect(client.authTest()).resolves.toEqual({
      botUserId: "U01234567",
    });

    const [request] = requests;
    expect(request?.url).toBe(`${SLACK_API_BASE}/auth.test`);
    expect(request?.url.startsWith("https://slack.com/api")).toBe(true);
    expect(request?.method).toBe("POST");
    expect(request?.url).not.toContain(BOT_TOKEN);
    expect(request?.headers.Authorization).toBe(`Bearer ${BOT_TOKEN}`);
    expect(request?.headers["Content-Type"]).toBe("application/json");
    expect(request?.body).toBe("{}");
    expect(request?.redirect).toBe("error");
  });

  it("opens Socket Mode with the app token and pins the REST origin", async () => {
    const { client, requests } = createClient(() =>
      jsonResponse(200, { ok: true, url: SOCKET_URL }),
    );

    await expect(client.openConnection()).resolves.toEqual({ url: SOCKET_URL });
    const [request] = requests;
    expect(request?.url).toBe(`${SLACK_API_BASE}/apps.connections.open`);
    expect(request?.headers.Authorization).toBe(`Bearer ${APP_TOKEN}`);
    expect(request?.headers.Authorization).not.toContain(BOT_TOKEN);
    expect(request?.redirect).toBe("error");
  });

  it("refuses a Socket Mode url that is not credential-free wss on slack.com", async () => {
    for (const url of [
      "https://wss-primary.slack.com/link",
      "wss://a:b@wss-primary.slack.com/link",
      "wss://attacker.example/link",
      "wss://wss-primary.slack.com.evil.example/link",
      "wss://wss-primary.slack.com:444/link",
    ]) {
      const { client } = createClient(() => jsonResponse(200, { ok: true, url }));
      await expect(client.openConnection()).rejects.toThrow(
        "Slack returned an unusable Socket Mode url",
      );
    }
  });

  it("posts a bounded message and parses the timestamp", async () => {
    const { client, requests } = createClient(() =>
      jsonResponse(200, { ok: true, ts: "1710000000.000100" }),
    );

    await expect(
      client.postMessage({ channel: CHANNEL_ID, text: "hello" }),
    ).resolves.toEqual({ ts: "1710000000.000100" });

    const [request] = requests;
    expect(request?.method).toBe("POST");
    expect(request?.url).toBe(`${SLACK_API_BASE}/chat.postMessage`);
    expect(request?.body).toBe(
      JSON.stringify({ channel: CHANNEL_ID, text: "hello" }),
    );
    expect(request?.headers["Content-Type"]).toBe("application/json");
    expect(request?.headers.Authorization).toBe(`Bearer ${BOT_TOKEN}`);
    expect(request?.redirect).toBe("error");
  });

  it("rejects unusable destinations and message bodies before any request", async () => {
    const { client, requests } = createClient(() => jsonResponse(200, { ok: true }));

    await expect(
      client.postMessage({ channel: "not-a-channel", text: "hi" }),
    ).rejects.toThrow("Slack channel id is invalid");
    await expect(
      client.postMessage({ channel: CHANNEL_ID, text: "" }),
    ).rejects.toThrow(/1 to 4000 characters/);
    await expect(
      client.postMessage({
        channel: CHANNEL_ID,
        text: "x".repeat(MAX_OUTBOUND_CONTENT_LENGTH + 1),
      }),
    ).rejects.toThrow(/1 to 4000 characters/);
    expect(requests).toHaveLength(0);
  });

  it("rejects a response that claims an unusable timestamp", async () => {
    const { client } = createClient(() => jsonResponse(200, { ok: true }));
    await expect(
      client.postMessage({ channel: CHANNEL_ID, text: "hi" }),
    ).rejects.toThrow("Slack returned an unusable message timestamp");
  });

  it("maps Slack ok:false codes to safe messages that cannot leak the token", async () => {
    const { client } = createClient(() =>
      jsonResponse(200, { ok: false, error: "invalid_auth", warning: BOT_TOKEN }),
    );
    const error = await client.authTest().catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(SlackRestError);
    expect((error as SlackRestError).message).toBe("Slack rejected the bot token");
    expect((error as SlackRestError).message).not.toContain(BOT_TOKEN);
    expect((error as SlackRestError).fatal).toBe(true);
  });

  it("maps status codes to safe messages that cannot leak the token", async () => {
    const cases: readonly [number, string, boolean][] = [
      [401, "Slack rejected the bot token", true],
      [403, "Slack denied access to this resource", true],
      [404, "Slack could not find this resource", false],
      [500, "Slack request failed with status 500", false],
    ];
    for (const [status, message, fatal] of cases) {
      const { client } = createClient(() =>
        jsonResponse(status, { ok: false, error: `leaky ${BOT_TOKEN}` }),
      );
      const error = await client.authTest().catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(SlackRestError);
      expect((error as SlackRestError).message).toBe(message);
      expect((error as SlackRestError).message).not.toContain(BOT_TOKEN);
      expect((error as SlackRestError).fatal).toBe(fatal);
    }
  });

  it("redacts the token from transport failures", async () => {
    const { client } = createClient(() => {
      throw new Error(`connect ECONNREFUSED with ${BOT_TOKEN}`);
    });
    const error = await client.authTest().catch((failure: unknown) => failure);
    expect((error as Error).message).not.toContain(BOT_TOKEN);
    expect((error as Error).message).toBe("Slack request failed");
  });

  it("refuses to send without a saved bot token", async () => {
    const { client, requests } = createClient(() => jsonResponse(200, { ok: true }), {
      botToken: undefined,
    });
    await expect(client.authTest()).rejects.toMatchObject({
      code: "auth",
      message: "Slack bot token is not saved",
    });
    expect(requests).toHaveLength(0);
  });

  it("refuses Socket Mode open without a saved app token", async () => {
    const { client, requests } = createClient(() => jsonResponse(200, { ok: true }), {
      appToken: undefined,
    });
    await expect(client.openConnection()).rejects.toMatchObject({
      code: "auth",
      message: "Slack app-level token is not saved",
    });
    expect(requests).toHaveLength(0);
  });

  it("retries a 429 at most twice and honours retry_after", async () => {
    let calls = 0;
    const { client, sleeps, requests } = createClient(() => {
      calls += 1;
      return calls <= 2
        ? jsonResponse(429, { retry_after: 0.25 })
        : jsonResponse(200, { ok: true, user_id: "U01234567" });
    });

    await expect(client.authTest()).resolves.toEqual({ botUserId: "U01234567" });
    expect(sleeps).toEqual([250, 250]);
    expect(requests).toHaveLength(3);
  });

  it("bounds the response body it will read", async () => {
    const { client } = createClient(
      () =>
        new Response("x".repeat(MAX_REST_RESPONSE_BYTES + 10), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    await expect(client.authTest()).rejects.toThrow("Slack response is too large");
  });

  it("rejects a malformed body", async () => {
    const { client } = createClient(
      () =>
        new Response("{not json", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    await expect(client.authTest()).rejects.toThrow(
      "Slack returned a malformed response",
    );
  });
});
