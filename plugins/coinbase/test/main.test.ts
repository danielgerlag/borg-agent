import {
  coinbaseDisconnect,
  coinbaseGetStatus,
  coinbaseVerify,
  type CoinbaseStatus,
} from "@borg/contracts";
import { createTestHarness, type ToolExecutionContext } from "@borg/plugin-sdk";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import coinbasePlugin from "../src/main";
import {
  COINBASE_PRIVATE_KEY_SECRET,
  COINBASE_PRODUCTION_ORIGIN,
  COINBASE_SANDBOX_ORIGIN,
} from "../src/protocol";
import {
  createCoinbaseHarness,
  jsonResponse,
  type RecordedRequest,
} from "./harness";

const TEST_EC_PEM = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgl0V43geGdE1aUifF
Yl9SkTFxl51Pzhxf1ceo4TTX4x2hRANCAAS0d4TxS/dVRfp8uugFXbSD2oFKKxdz
WFqar8wj03nITtVkHqWT5oLXHtnpcrCFMnCUrr7BH7gJwUpeGedSgKV/
-----END PRIVATE KEY-----
`;

const KEY_NAME = "organizations/org1/apiKeys/key-uuid-123";
const WORK_KEY_NAME = "organizations/org1/apiKeys/work-key";
const ACCOUNT = "11111111-1111-4111-8111-111111111111";

const TOOL_IDS = [
  "coinbase.trading.list_accounts",
  "coinbase.trading.get_account",
  "coinbase.trading.get_price",
  "coinbase.trading.list_transactions",
  "coinbase.trading.create_order",
  "coinbase.trading.send_crypto",
  "coinbase.trading.list_orders",
] as const;

function defaultAccount(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "default",
    name: "Coinbase",
    enabled: true,
    sandbox: false,
    keyName: KEY_NAME,
    ...overrides,
  };
}

function execution(toolCallId = "call-1"): ToolExecutionContext {
  return {
    toolCallId,
    signal: new AbortController().signal,
  };
}

function coinbaseRoutes(
  overrides: Readonly<
    Record<string, (request: RecordedRequest) => Response | Promise<Response>>
  > = {},
) {
  return (request: RecordedRequest): Response | Promise<Response> => {
    for (const [suffix, handler] of Object.entries(overrides)) {
      if (request.url.endsWith(suffix)) {
        return handler(request);
      }
    }
    if (request.url.endsWith("/api/v3/brokerage/accounts")) {
      return jsonResponse(200, {
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
      });
    }
    return jsonResponse(404, { message: "unexpected" });
  };
}

describe("borg.coinbase plugin", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  async function activate(
    options: Parameters<typeof createCoinbaseHarness>[0] = {},
  ) {
    const harness = createCoinbaseHarness({
      fetch: coinbaseRoutes(),
      ...options,
    });
    const active = await createTestHarness(coinbasePlugin, harness.context);
    cleanups.push(async () => {
      await active.deactivate();
    });
    return harness;
  }

  it("agrees with its static manifest", async () => {
    const manifest = JSON.parse(
      await readFile(new URL("../borg.plugin.json", import.meta.url), "utf8"),
    ) as Record<string, unknown>;
    expect(coinbasePlugin).toMatchObject({
      id: manifest.id,
      version: manifest.version,
      permissions: manifest.permissions,
      contributes: manifest.contributes,
    });
    expect(manifest.permissions).toEqual([
      "network:api.coinbase.com",
      "network:api-sandbox.coinbase.com",
      "network:dynamic",
      "secrets:read",
      "secrets:write",
      "tools.register",
      "ui.settings",
    ]);
  });

  it("stays unregistered until enabled with a key name and private key", async () => {
    const harness = await activate();
    expect(harness.tools).toHaveLength(0);
    await expect(
      harness.invoke<CoinbaseStatus>(coinbaseGetStatus, {}),
    ).rejects.toThrow("No Coinbase account is configured");
  });

  it("explains itself when enabled without a private key", async () => {
    const harness = await activate({
      config: { enabled: true, keyName: KEY_NAME },
    });
    expect(harness.tools).toHaveLength(0);
    expect(
      await harness.invoke<CoinbaseStatus>(coinbaseGetStatus, {}),
    ).toEqual({
      accountId: "default",
      name: "Coinbase",
      hasPrivateKey: false,
      hasKeyName: true,
      enabled: true,
      sandbox: false,
      connected: false,
      error: "Coinbase private key is not saved",
    });
  });

  it("registers trading tools once enabled with credentials", async () => {
    const harness = await activate({
      config: { enabled: true, keyName: KEY_NAME },
      secrets: { [COINBASE_PRIVATE_KEY_SECRET]: TEST_EC_PEM },
    });
    expect(harness.tools.map((tool) => tool.id)).toEqual([...TOOL_IDS]);
    expect(
      harness.tools.find((tool) => tool.id === "coinbase.trading.create_order"),
    ).toMatchObject({ approval: "ask", sideEffect: true });
    expect(
      harness.tools.find((tool) => tool.id === "coinbase.trading.send_crypto"),
    ).toMatchObject({ approval: "ask", sideEffect: true });
    expect(
      harness.tools.find((tool) => tool.id === "coinbase.trading.list_accounts"),
    ).toMatchObject({ approval: "auto", sideEffect: false });
    expect(
      harness.tools.find((tool) => tool.id === "coinbase.trading.get_price"),
    ).toMatchObject({
      security: {
        outputClassification: "public",
        channelCapacity: "public",
      },
    });
  });

  it("verifies with list_accounts and unregisters on disconnect", async () => {
    const harness = await activate({
      config: { enabled: true, keyName: KEY_NAME },
      secrets: { [COINBASE_PRIVATE_KEY_SECRET]: TEST_EC_PEM },
    });
    const verified = await harness.invoke<CoinbaseStatus>(coinbaseVerify, {});
    expect(verified).toMatchObject({
      accountId: "default",
      name: "Coinbase",
      connected: true,
    });
    expect(verified.error).toBeUndefined();
    expect(harness.requests[0]?.url).toBe(
      `${COINBASE_PRODUCTION_ORIGIN}/api/v3/brokerage/accounts`,
    );
    const listed = await harness.tools[0]?.execute({}, execution());
    expect(listed).toEqual({
      accounts: [
        expect.objectContaining({ id: ACCOUNT, currency: "BTC" }),
      ],
    });
    const disconnected = await harness.invoke<CoinbaseStatus>(
      coinbaseDisconnect,
      {},
    );
    expect(disconnected.connected).toBe(false);
    expect(harness.tools).toHaveLength(0);
  });

  it("keeps a failed verify diagnostic without dropping registration", async () => {
    const harness = await activate({
      config: { enabled: true, keyName: KEY_NAME },
      secrets: { [COINBASE_PRIVATE_KEY_SECRET]: TEST_EC_PEM },
      fetch: () => jsonResponse(401, { message: "nope" }),
    });
    const verified = await harness.invoke<CoinbaseStatus>(coinbaseVerify, {});
    expect(verified.connected).toBe(true);
    expect(verified.error).toBe("Coinbase rejected the API key");
  });

  it("unregisters tools when the live account is disabled", async () => {
    const harness = await activate({
      config: { enabled: true, keyName: KEY_NAME },
      secrets: { [COINBASE_PRIVATE_KEY_SECRET]: TEST_EC_PEM },
    });
    expect(harness.tools).toHaveLength(TOOL_IDS.length);
    await harness.updateConfig({
      accounts: [defaultAccount({ enabled: false })],
    });
    expect(harness.tools).toHaveLength(0);
  });

  it("registers trading tools once and uses a namespaced privateKey for a second account", async () => {
    const workAccount = {
      id: "work",
      name: "Work",
      enabled: true,
      sandbox: true,
      keyName: WORK_KEY_NAME,
    };
    const harness = await activate({
      config: {
        accounts: [defaultAccount(), workAccount],
      },
      secrets: {
        "work.privateKey": TEST_EC_PEM,
      },
    });

    expect(harness.tools.map((tool) => tool.id)).toEqual([...TOOL_IDS]);
    expect(
      await harness.invoke<CoinbaseStatus>(coinbaseGetStatus, {
        accountId: "work",
      }),
    ).toMatchObject({
      accountId: "work",
      name: "Work",
      connected: true,
      sandbox: true,
      hasPrivateKey: true,
    });
    expect(
      await harness.invoke<CoinbaseStatus>(coinbaseGetStatus, {}),
    ).toMatchObject({
      accountId: "default",
      connected: false,
      hasPrivateKey: false,
    });

    await harness.tools[0]?.execute({}, execution("sole"));
    expect(harness.requests.at(-1)?.url).toBe(
      `${COINBASE_SANDBOX_ORIGIN}/api/v3/brokerage/accounts`,
    );
    await expect(
      harness.tools[0]?.execute({ connectionId: "default" }, execution("miss")),
    ).rejects.toThrow("Coinbase connection default is not connected");

    harness.secrets.set(COINBASE_PRIVATE_KEY_SECRET, TEST_EC_PEM);
    const verified = await harness.invoke<CoinbaseStatus>(coinbaseVerify, {
      accountId: "default",
    });
    expect(verified.connected).toBe(true);
    expect(harness.tools.map((tool) => tool.id)).toEqual([...TOOL_IDS]);

    await expect(
      harness.tools[0]?.execute({}, execution("ambiguous")),
    ).rejects.toThrow(
      "Specify connectionId when multiple Coinbase accounts are connected",
    );

    await harness.tools[0]?.execute(
      { connectionId: "default" },
      execution("default"),
    );
    expect(harness.requests.at(-1)?.url).toBe(
      `${COINBASE_PRODUCTION_ORIGIN}/api/v3/brokerage/accounts`,
    );
    await harness.tools[0]?.execute(
      { connectionId: "work" },
      execution("work"),
    );
    expect(harness.requests.at(-1)?.url).toBe(
      `${COINBASE_SANDBOX_ORIGIN}/api/v3/brokerage/accounts`,
    );
  });
});
