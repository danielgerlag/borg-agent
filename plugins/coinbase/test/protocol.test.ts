import { describe, expect, it } from "vitest";
import {
  ACCOUNTS_PATH,
  HISTORICAL_ORDERS_PATH,
  ORDERS_PATH,
  isAllowedCoinbasePath,
} from "../src/protocol";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";

describe("Coinbase path allowlist", () => {
  it("allows the Advanced Trade and v2 transaction paths HiveMind uses", () => {
    expect(isAllowedCoinbasePath("GET", ACCOUNTS_PATH)).toBe(true);
    expect(isAllowedCoinbasePath("GET", `${ACCOUNTS_PATH}/${ACCOUNT}`)).toBe(
      true,
    );
    expect(isAllowedCoinbasePath("GET", "/api/v3/brokerage/products/BTC-USD")).toBe(
      true,
    );
    expect(isAllowedCoinbasePath("POST", ORDERS_PATH)).toBe(true);
    expect(isAllowedCoinbasePath("GET", HISTORICAL_ORDERS_PATH)).toBe(true);
    expect(
      isAllowedCoinbasePath("GET", `/v2/accounts/${ACCOUNT}/transactions`),
    ).toBe(true);
    expect(
      isAllowedCoinbasePath("POST", `/v2/accounts/${ACCOUNT}/transactions`),
    ).toBe(true);
  });

  it("rejects path traversal, wrong methods, and unknown products", () => {
    expect(isAllowedCoinbasePath("DELETE", ACCOUNTS_PATH)).toBe(false);
    expect(
      isAllowedCoinbasePath("GET", `${ACCOUNTS_PATH}/../products`),
    ).toBe(false);
    expect(isAllowedCoinbasePath("GET", "/api/v3/brokerage/products/BTC")).toBe(
      false,
    );
    expect(
      isAllowedCoinbasePath("GET", "/api/v3/brokerage/products/BTC-USD/book"),
    ).toBe(false);
    expect(isAllowedCoinbasePath("GET", `/v2/accounts/${ACCOUNT}`)).toBe(false);
  });
});
