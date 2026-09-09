import { describe, expect, it } from "vitest";
import {
  coinbaseConfigSchema,
  defaultCoinbaseConfig,
  parseCoinbaseConfig,
  parseKeyName,
  sameCoinbaseConfig,
} from "../src/config";

const KEY_NAME = "organizations/org1/apiKeys/key-uuid-123";

function defaultAccount(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "default",
    name: "Coinbase",
    enabled: false,
    sandbox: false,
    keyName: "",
    ...overrides,
  };
}

describe("Coinbase config", () => {
  it("parses empty config as no accounts", () => {
    const defaults = defaultCoinbaseConfig();
    expect(defaults).toEqual({ accounts: [] });
    expect(coinbaseConfigSchema.parse({})).toEqual({ accounts: [] });
    expect(coinbaseConfigSchema.parse(defaults)).toEqual(defaults);
  });

  it("lifts a stored singleton into the default account", () => {
    expect(
      parseCoinbaseConfig({
        enabled: true,
        keyName: KEY_NAME,
      }),
    ).toEqual({
      accounts: [
        defaultAccount({
          enabled: true,
          keyName: KEY_NAME,
        }),
      ],
    });
  });

  it("drops leftover singleton keys when accounts is present", () => {
    expect(
      parseCoinbaseConfig({
        accounts: [{ id: "work", name: "Work" }],
        enabled: true,
      }),
    ).toEqual({
      accounts: [defaultAccount({ id: "work", name: "Work" })],
    });
  });

  it("refuses unknown keys", () => {
    expect(
      coinbaseConfigSchema.safeParse({ enabled: false, privateKey: "leak" })
        .success,
    ).toBe(false);
  });

  it("requires unique ids and at most eight accounts", () => {
    expect(
      coinbaseConfigSchema.safeParse({
        accounts: [
          { id: "work", name: "Work" },
          { id: "work", name: "Also work" },
        ],
      }).success,
    ).toBe(false);
    expect(
      coinbaseConfigSchema.safeParse({
        accounts: Array.from({ length: 8 }, (_value, index) => ({
          id: `acct-${index}`,
          name: `Account ${index}`,
        })),
      }).success,
    ).toBe(true);
    expect(
      coinbaseConfigSchema.safeParse({
        accounts: Array.from({ length: 9 }, (_value, index) => ({
          id: `acct-${index}`,
          name: `Account ${index}`,
        })),
      }).success,
    ).toBe(false);
  });

  it("refuses to enable without a CDP key name", () => {
    expect(() => parseCoinbaseConfig({ enabled: true })).toThrow(
      "Enable Coinbase only after saving a CDP API key name",
    );
  });

  it("accepts HiveMind-style key names", () => {
    expect(parseKeyName("organizations/org1/apiKeys/key-uuid-123")).toBe(
      "organizations/org1/apiKeys/key-uuid-123",
    );
    expect(parseKeyName("orgs/1/apiKeys/2")).toBe("orgs/1/apiKeys/2");
    expect(() => parseKeyName("not-a-key")).toThrow(/CDP API key name/);
  });

  it("compares configurations by value", () => {
    const left = parseCoinbaseConfig({
      enabled: true,
      keyName: KEY_NAME,
    });
    expect(
      sameCoinbaseConfig(
        left,
        parseCoinbaseConfig({ enabled: true, keyName: KEY_NAME }),
      ),
    ).toBe(true);
    expect(
      sameCoinbaseConfig(
        left,
        parseCoinbaseConfig({
          enabled: true,
          sandbox: true,
          keyName: KEY_NAME,
        }),
      ),
    ).toBe(false);
  });
});
