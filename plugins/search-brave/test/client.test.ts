import { describe, expect, it } from "vitest";
import {
  BRAVE_PRODUCTION_ENDPOINT,
  BraveClient,
  SAFE_BRAVE_ERRORS,
  resolveBraveEndpoint,
} from "../src/client";

describe("resolveBraveEndpoint", () => {
  it("uses production when no override is set", () => {
    expect(resolveBraveEndpoint({})).toBe(BRAVE_PRODUCTION_ENDPOINT);
  });

  it("rejects a non-loopback override without BORG_E2E", () => {
    expect(() =>
      resolveBraveEndpoint({
        BORG_BRAVE_ENDPOINT: "https://example.com/search",
      }),
    ).toThrow(SAFE_BRAVE_ERRORS.invalidEndpoint);
  });

  it("allows a loopback override only when BORG_E2E=1", () => {
    expect(
      resolveBraveEndpoint({
        BORG_E2E: "1",
        BORG_BRAVE_ENDPOINT: "http://127.0.0.1:9/search",
      }),
    ).toBe("http://127.0.0.1:9/search");
  });
});

describe("BraveClient", () => {
  it("gets q and token then returns parsed hits", async () => {
    const calls: { readonly url: string; readonly token: string | null }[] = [];
    const client = new BraveClient({
      endpoint: "http://127.0.0.1:9/search",
      getApiKey: async () => "brave-test",
      fetchImpl: async (input, init) => {
        const headers = new Headers(init?.headers);
        calls.push({
          url: String(input),
          token: headers.get("X-Subscription-Token"),
        });
        return new Response(
          JSON.stringify({
            web: {
              results: [
                {
                  title: "Brave Hit",
                  url: "https://example.com/brave",
                  description: "from brave",
                },
              ],
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    await expect(client.search({ query: "borg" })).resolves.toEqual({
      query: "borg",
      hits: [
        {
          title: "Brave Hit",
          url: "https://example.com/brave",
          snippet: "from brave",
        },
      ],
    });
    expect(calls).toEqual([
      {
        url: "http://127.0.0.1:9/search?q=borg&count=5",
        token: "brave-test",
      },
    ]);
  });
});
