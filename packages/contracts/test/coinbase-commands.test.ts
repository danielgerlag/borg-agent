import { describe, expect, it } from "vitest";
import {
  coinbaseCreateOrderInputSchema,
  coinbaseDisconnect,
  coinbaseGetStatus,
  coinbaseStatusSchema,
  coinbaseVerify,
} from "../src/index";

describe("coinbase commands", () => {
  it("exports Coinbase commands after Slack with a 30s verify timeout", () => {
    expect(coinbaseGetStatus.id).toBe("borg.coinbase.getStatus");
    expect(coinbaseVerify.id).toBe("borg.coinbase.verify");
    expect(coinbaseDisconnect.id).toBe("borg.coinbase.disconnect");
    expect(coinbaseVerify.timeoutMs).toBe(30_000);
  });

  it("parses status without secret fields", () => {
    expect(
      coinbaseGetStatus.output.parse({
        hasPrivateKey: true,
        hasKeyName: true,
        enabled: true,
        sandbox: false,
        connected: true,
      }),
    ).toEqual({
      hasPrivateKey: true,
      hasKeyName: true,
      enabled: true,
      sandbox: false,
      connected: true,
    });
    expect(() =>
      coinbaseStatusSchema.parse({
        hasPrivateKey: true,
        hasKeyName: true,
        enabled: true,
        sandbox: false,
        connected: false,
        privateKey: "-----BEGIN PRIVATE KEY-----",
      }),
    ).toThrow();
  });

  it("requires exactly one of quoteSize and baseSize", () => {
    expect(
      coinbaseCreateOrderInputSchema.parse({
        productId: "BTC-USD",
        side: "BUY",
        quoteSize: "100",
      }),
    ).toEqual({
      productId: "BTC-USD",
      side: "BUY",
      quoteSize: "100",
    });
    expect(() =>
      coinbaseCreateOrderInputSchema.parse({
        productId: "BTC-USD",
        side: "BUY",
      }),
    ).toThrow();
    expect(() =>
      coinbaseCreateOrderInputSchema.parse({
        productId: "BTC-USD",
        side: "BUY",
        quoteSize: "100",
        baseSize: "0.01",
      }),
    ).toThrow();
  });
});
