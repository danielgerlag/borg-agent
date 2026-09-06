import { afterEach, describe, expect, it } from "vitest";
import {
  SAFE_TAVILY_ERRORS,
  TAVILY_PRODUCTION_ENDPOINT,
  TavilyClient,
  resolveTavilyEndpoint,
} from "../src/client";

const originalE2e = process.env.BORG_E2E;
const originalEndpoint = process.env.BORG_TAVILY_ENDPOINT;

afterEach(() => {
  if (originalE2e === undefined) {
    delete process.env.BORG_E2E;
  } else {
    process.env.BORG_E2E = originalE2e;
  }
  if (originalEndpoint === undefined) {
    delete process.env.BORG_TAVILY_ENDPOINT;
  } else {
    process.env.BORG_TAVILY_ENDPOINT = originalEndpoint;
  }
});

describe("resolveTavilyEndpoint", () => {
  it("uses production when no override is set", () => {
    expect(resolveTavilyEndpoint({})).toBe(TAVILY_PRODUCTION_ENDPOINT);
  });

  it("rejects a non-loopback override without BORG_E2E", () => {
    expect(() =>
      resolveTavilyEndpoint({
        BORG_TAVILY_ENDPOINT: "https://example.com/search",
      }),
    ).toThrow(SAFE_TAVILY_ERRORS.invalidEndpoint);
  });

  it("rejects a non-loopback override even with BORG_E2E", () => {
    expect(() =>
      resolveTavilyEndpoint({
        BORG_E2E: "1",
        BORG_TAVILY_ENDPOINT: "https://example.com/search",
      }),
    ).toThrow(SAFE_TAVILY_ERRORS.invalidEndpoint);
  });

  it("allows a loopback override only when BORG_E2E=1", () => {
    expect(() =>
      resolveTavilyEndpoint({
        BORG_TAVILY_ENDPOINT: "http://127.0.0.1:9/search",
      }),
    ).toThrow(SAFE_TAVILY_ERRORS.invalidEndpoint);
    expect(
      resolveTavilyEndpoint({
        BORG_E2E: "1",
        BORG_TAVILY_ENDPOINT: "http://127.0.0.1:9/search",
      }),
    ).toBe("http://127.0.0.1:9/search");
  });
});

describe("TavilyClient", () => {
  it("posts query and api_key then returns parsed hits", async () => {
    const calls: { readonly url: string; readonly body: unknown }[] = [];
    const client = new TavilyClient({
      endpoint: "http://127.0.0.1:9/search",
      getApiKey: async () => "tvly-test",
      fetchImpl: async (input, init) => {
        calls.push({
          url: String(input),
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        return new Response(
          JSON.stringify({
            results: [
              {
                title: "Borg Search Hit",
                url: "https://example.com/hit",
                content: "external snippet",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    await expect(client.search({ query: "borg slice 12" })).resolves.toEqual({
      query: "borg slice 12",
      hits: [
        {
          title: "Borg Search Hit",
          url: "https://example.com/hit",
          snippet: "external snippet",
        },
      ],
    });
    expect(calls).toEqual([
      {
        url: "http://127.0.0.1:9/search",
        body: {
          query: "borg slice 12",
          max_results: 5,
          api_key: "tvly-test",
        },
      },
    ]);
  });
});
