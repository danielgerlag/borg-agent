import { createPrivateKey, randomBytes, sign } from "node:crypto";
import { JWT_TTL_SECONDS, SAFE_COINBASE_ERRORS } from "./protocol";

export function normalizePem(pem: string): string {
  const normalized = pem.replace(/\\n/g, "\n").replace(/\r\n/g, "\n").trim();
  return normalized.length === 0 ? "" : `${normalized}\n`;
}

export function randomNonce(): string {
  return randomBytes(16).toString("hex");
}

export interface CdpJwtInput {
  readonly keyName: string;
  readonly privateKeyPem: string;
  readonly method: string;
  readonly path: string;
  readonly host: string;
  readonly nowSeconds: number;
  readonly nonce: string;
}

export function signCdpJwt(input: CdpJwtInput): string {
  const pem = normalizePem(input.privateKeyPem);
  let key;
  try {
    key = createPrivateKey(pem);
  } catch {
    throw new Error(SAFE_COINBASE_ERRORS.invalidKey);
  }
  if (
    key.asymmetricKeyType !== "ec" ||
    key.asymmetricKeyDetails?.namedCurve !== "prime256v1"
  ) {
    throw new Error(SAFE_COINBASE_ERRORS.invalidKey);
  }
  const header = {
    alg: "ES256",
    typ: "JWT",
    kid: input.keyName,
    nonce: input.nonce,
  };
  const claims = {
    sub: input.keyName,
    iss: "cdp",
    nbf: input.nowSeconds,
    exp: input.nowSeconds + JWT_TTL_SECONDS,
    uri: `${input.method.toUpperCase()} ${input.host}${input.path}`,
  };
  const encodedHeader = Buffer.from(JSON.stringify(header), "utf8").toString(
    "base64url",
  );
  const encodedClaims = Buffer.from(JSON.stringify(claims), "utf8").toString(
    "base64url",
  );
  const message = `${encodedHeader}.${encodedClaims}`;
  const signature = sign("sha256", Buffer.from(message, "utf8"), {
    key,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return `${message}.${signature}`;
}
