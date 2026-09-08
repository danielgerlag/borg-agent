import { describe, expect, it } from "vitest";
import { CoinbaseClient, CoinbaseError } from "../src/client";
import {
  COINBASE_PRODUCTION_ORIGIN,
  COINBASE_SANDBOX_ORIGIN,
} from "../src/protocol";
import { createFakeHttp, jsonResponse, type RecordedRequest } from "./harness";

const TEST_EC_PEM = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgl0V43geGdE1aUifF
Yl9SkTFxl51Pzhxf1ceo4TTX4x2hRANCAAS0d4TxS/dVRfp8uugFXbSD2oFKKxdz
WFqar8wj03nITtVkHqWT5oLXHtnpcrCFMnCUrr7BH7gJwUpeGedSgKV/
-----END PRIVATE KEY-----
`;

const KEY_NAME = "organizations/org1/apiKeys/key-uuid-123";
const ACCOUNT = "11111111-1111-4111-8111-111111111111";

function decodeJwt(token: string): {
  readonly header: Record<string, unknown>;
  readonly claims: Record<string, unknown>;
} {
  const [headerPart, claimsPart] = token.slice("Bearer ".length).split(".");
  if (headerPart === undefined || claimsPart === undefined) {
    throw new Error("missing jwt");
  }
  return {
    header: JSON.parse(
      Buffer.from(headerPart, "base64url").toString("utf8"),
    ) as Record<string, unknown>,
    claims: JSON.parse(
      Buffer.from(claimsPart, "base64url").toString("utf8"),
    ) as Record<string, unknown>,
  };
}

function createClient(
  handler: (request: RecordedRequest) => Response | Promise<Response>,
  options: { readonly sandbox?: boolean } = {},
) {
  const { http, requests } = createFakeHttp(handler);
  const client = new CoinbaseClient({
    http,
    sandbox: options.sandbox === true,
    keyName: KEY_NAME,
    readPrivateKey: async () => TEST_EC_PEM,
    nowSeconds: () => 1_700_000_000,
    nonce: () => "fixednonce",
    createClientOrderId: () => "client-order-1",
  });
  return { client, requests };
}

describe("CoinbaseClient", () => {
  it("lists accounts against the pinned production origin with a CDP JWT", async () => {
    const { client, requests } = createClient(() =>
      jsonResponse(200, {
        accounts: [
          {
            uuid: ACCOUNT,
            name: "BTC Wallet",
            currency: "BTC",
            available_balance: { value: "1.5", currency: "BTC" },
            hold: { value: "0.0", currency: "BTC" },
            type: "ACCOUNT_TYPE_CRYPTO",
            active: true,
          },
        ],
      }),
    );

    await expect(client.listAccounts()).resolves.toEqual({
      accounts: [
        {
          id: ACCOUNT,
          name: "BTC Wallet",
          currency: "BTC",
          available: "1.5",
          hold: "0.0",
          type: "ACCOUNT_TYPE_CRYPTO",
          active: true,
        },
      ],
    });

    const [request] = requests;
    expect(request?.url).toBe(
      `${COINBASE_PRODUCTION_ORIGIN}/api/v3/brokerage/accounts`,
    );
    expect(request?.method).toBe("GET");
    expect(request?.redirect).toBe("error");
    expect(request?.url).not.toContain("BEGIN PRIVATE KEY");
    const token = request?.headers.Authorization ?? "";
    expect(token.startsWith("Bearer ")).toBe(true);
    expect(token).not.toContain("BEGIN");
    const jwt = decodeJwt(token);
    expect(jwt.header.kid).toBe(KEY_NAME);
    expect(jwt.claims.iss).toBe("cdp");
    expect(jwt.claims.uri).toBe(
      "GET api.coinbase.com/api/v3/brokerage/accounts",
    );
  });

  it("pins sandbox host and JWT uri when sandbox is on", async () => {
    const { client, requests } = createClient(
      () => jsonResponse(200, { accounts: [] }),
      { sandbox: true },
    );
    await client.listAccounts();
    const [request] = requests;
    expect(request?.url).toBe(
      `${COINBASE_SANDBOX_ORIGIN}/api/v3/brokerage/accounts`,
    );
    expect(decodeJwt(request?.headers.Authorization ?? "").claims.uri).toBe(
      "GET api-sandbox.coinbase.com/api/v3/brokerage/accounts",
    );
  });

  it("places a market order with quote_size and a client order id", async () => {
    const { client, requests } = createClient(() =>
      jsonResponse(200, { success: true, order_id: "order-xyz" }),
    );
    await expect(
      client.createOrder({
        productId: "BTC-USD",
        side: "BUY",
        quoteSize: "100",
      }),
    ).resolves.toEqual({ success: true, orderId: "order-xyz" });
    const [request] = requests;
    expect(request?.url).toBe(
      `${COINBASE_PRODUCTION_ORIGIN}/api/v3/brokerage/orders`,
    );
    expect(request?.method).toBe("POST");
    expect(JSON.parse(request?.body ?? "{}")).toEqual({
      client_order_id: "client-order-1",
      product_id: "BTC-USD",
      side: "BUY",
      order_configuration: { market_market_ioc: { quote_size: "100" } },
    });
  });

  it("sends crypto on the v2 transaction path", async () => {
    const { client, requests } = createClient(() =>
      jsonResponse(200, {
        data: {
          id: "tx-1",
          type: "send",
          status: "completed",
          amount: { amount: "-0.01", currency: "BTC" },
          native_amount: { amount: "-500.00", currency: "USD" },
          created_at: "2025-01-01T00:00:00Z",
        },
      }),
    );
    await expect(
      client.sendCrypto({
        accountId: ACCOUNT,
        to: "1abcDestination",
        amount: "0.01",
        currency: "BTC",
      }),
    ).resolves.toMatchObject({ id: "tx-1", type: "send", amount: "-0.01" });
    expect(requests[0]?.url).toBe(
      `${COINBASE_PRODUCTION_ORIGIN}/v2/accounts/${ACCOUNT}/transactions`,
    );
  });

  it("maps 401 without leaking the PEM", async () => {
    const { client } = createClient(() =>
      jsonResponse(401, { message: TEST_EC_PEM }),
    );
    await expect(client.listAccounts()).rejects.toMatchObject({
      name: "CoinbaseError",
      message: "Coinbase rejected the API key",
    });
  });

  it("rejects an oversize response", async () => {
    const { client } = createClient(
      () =>
        new Response("x".repeat(300_000), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    await expect(client.listAccounts()).rejects.toBeInstanceOf(CoinbaseError);
  });
});
