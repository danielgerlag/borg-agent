import { createPrivateKey, createPublicKey, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { normalizePem, signCdpJwt } from "../src/jwt";
import { JWT_TTL_SECONDS } from "../src/protocol";

const TEST_EC_PEM = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgl0V43geGdE1aUifF
Yl9SkTFxl51Pzhxf1ceo4TTX4x2hRANCAAS0d4TxS/dVRfp8uugFXbSD2oFKKxdz
WFqar8wj03nITtVkHqWT5oLXHtnpcrCFMnCUrr7BH7gJwUpeGedSgKV/
-----END PRIVATE KEY-----
`;

const TEST_SEC1_PEM = `-----BEGIN EC PRIVATE KEY-----
MHcCAQEEIPpqjjRuv+xkPgouyjxDFd22Gp5E05jmxwU4M2q5ZVDNoAoGCCqGSM49
AwEHoUQDQgAEYeiOYtO5tCzzIj2fLelBj1leLoDKiTsfD5WRY7K9wp5pVfEwHMDG
DrkNyxX60wvpTzaiJA3RpQQo0gu+vXTmUw==
-----END EC PRIVATE KEY-----
`;

const KEY_NAME = "organizations/org1/apiKeys/key-uuid-123";

function decodeJwt(token: string): {
  readonly header: Record<string, unknown>;
  readonly claims: Record<string, unknown>;
  readonly signature: Buffer;
  readonly message: string;
} {
  const [headerPart, claimsPart, signaturePart] = token.split(".");
  if (
    headerPart === undefined ||
    claimsPart === undefined ||
    signaturePart === undefined
  ) {
    throw new Error("jwt must have three parts");
  }
  return {
    header: JSON.parse(Buffer.from(headerPart, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >,
    claims: JSON.parse(Buffer.from(claimsPart, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >,
    signature: Buffer.from(signaturePart, "base64url"),
    message: `${headerPart}.${claimsPart}`,
  };
}

describe("CDP JWT", () => {
  it("signs ES256 claims that match the Coinbase CDP SDK", () => {
    const token = signCdpJwt({
      keyName: KEY_NAME,
      privateKeyPem: TEST_EC_PEM,
      method: "GET",
      path: "/api/v3/brokerage/accounts",
      host: "api.coinbase.com",
      nowSeconds: 1_700_000_000,
      nonce: "abc123",
    });
    const decoded = decodeJwt(token);
    expect(decoded.header).toEqual({
      alg: "ES256",
      typ: "JWT",
      kid: KEY_NAME,
      nonce: "abc123",
    });
    expect(decoded.claims).toEqual({
      sub: KEY_NAME,
      iss: "cdp",
      nbf: 1_700_000_000,
      exp: 1_700_000_000 + JWT_TTL_SECONDS,
      uri: "GET api.coinbase.com/api/v3/brokerage/accounts",
    });
    expect(decoded.claims.aud).toBeUndefined();
    const publicKey = createPublicKey(createPrivateKey(TEST_EC_PEM));
    expect(
      verify(
        "sha256",
        Buffer.from(decoded.message, "utf8"),
        { key: publicKey, dsaEncoding: "ieee-p1363" },
        decoded.signature,
      ),
    ).toBe(true);
  });

  it("accepts escaped newlines, CRLF, and SEC1 PEMs", () => {
    const escaped = TEST_EC_PEM.replace(/\n/g, "\\n");
    expect(normalizePem(escaped)).toContain("BEGIN PRIVATE KEY");
    expect(() =>
      signCdpJwt({
        keyName: KEY_NAME,
        privateKeyPem: escaped,
        method: "GET",
        path: "/api/v3/brokerage/accounts",
        host: "api.coinbase.com",
        nowSeconds: 1,
        nonce: "n",
      }),
    ).not.toThrow();
    expect(() =>
      signCdpJwt({
        keyName: KEY_NAME,
        privateKeyPem: TEST_EC_PEM.replace(/\n/g, "\r\n"),
        method: "GET",
        path: "/api/v3/brokerage/accounts",
        host: "api.coinbase.com",
        nowSeconds: 1,
        nonce: "n",
      }),
    ).not.toThrow();
    expect(() =>
      signCdpJwt({
        keyName: KEY_NAME,
        privateKeyPem: TEST_SEC1_PEM,
        method: "GET",
        path: "/api/v3/brokerage/accounts",
        host: "api.coinbase.com",
        nowSeconds: 1,
        nonce: "n",
      }),
    ).not.toThrow();
  });

  it("rejects a non-EC PEM without echoing the key", () => {
    expect(() =>
      signCdpJwt({
        keyName: KEY_NAME,
        privateKeyPem: "not-a-pem",
        method: "GET",
        path: "/api/v3/brokerage/accounts",
        host: "api.coinbase.com",
        nowSeconds: 1,
        nonce: "n",
      }),
    ).toThrow("Coinbase private key is invalid");
  });
});
