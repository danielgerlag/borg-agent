import { describe, expect, it } from "vitest";
import {
  defaultCoinbaseConfig,
  parseCoinbaseConfig,
  parseKeyName,
} from "../src/config";

describe("Coinbase config", () => {
  it("defaults to disabled production with an empty key name", () => {
    expect(defaultCoinbaseConfig()).toEqual({
      enabled: false,
      sandbox: false,
      keyName: "",
    });
  });

  it("refuses to enable without a CDP key name", () => {
    expect(() => parseCoinbaseConfig({ enabled: true })).toThrow(
      "Enable Coinbase only after saving a CDP API key name",
    );
  });

  it("accepts HiveMind-style key names", () => {
    expect(
      parseKeyName("organizations/org1/apiKeys/key-uuid-123"),
    ).toBe("organizations/org1/apiKeys/key-uuid-123");
    expect(parseKeyName("orgs/1/apiKeys/2")).toBe("orgs/1/apiKeys/2");
    expect(() => parseKeyName("not-a-key")).toThrow(/CDP API key name/);
  });
});
