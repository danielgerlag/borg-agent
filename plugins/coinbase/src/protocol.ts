export const COINBASE_PLUGIN_ID = "borg.coinbase";
export const COINBASE_PRIVATE_KEY_SECRET = "privateKey";

export const COINBASE_PRODUCTION_ORIGIN = "https://api.coinbase.com";
export const COINBASE_SANDBOX_ORIGIN = "https://api-sandbox.coinbase.com";
export const COINBASE_PRODUCTION_HOST = "api.coinbase.com";
export const COINBASE_SANDBOX_HOST = "api-sandbox.coinbase.com";

export const ACCOUNTS_PATH = "/api/v3/brokerage/accounts";
export const PRODUCTS_PATH = "/api/v3/brokerage/products";
export const ORDERS_PATH = "/api/v3/brokerage/orders";
export const HISTORICAL_ORDERS_PATH = "/api/v3/brokerage/orders/historical/batch";

export const ACCOUNT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const PRODUCT_ID_PATTERN = /^[A-Z0-9.]{1,16}-[A-Z0-9.]{1,16}$/;
export const KEY_NAME_PATTERN =
  /^(organizations|orgs)\/[A-Za-z0-9_-]+\/apiKeys\/[A-Za-z0-9_-]+$/;
export const CURRENCY_PATTERN = /^[A-Z0-9]{2,10}$/;
export const AMOUNT_PATTERN = /^-?\d{1,18}(\.\d{1,18})?$/;

export const MAX_KEY_NAME_LENGTH = 256;
export const MAX_PRIVATE_KEY_CHARS = 8_192;
export const MAX_REST_RESPONSE_BYTES = 262_144;
export const MAX_DIAGNOSTIC_CHARS = 200;
export const MAX_DESTINATION_LENGTH = 256;
export const REQUEST_TIMEOUT_MS = 20_000;
export const JWT_TTL_SECONDS = 120;

export const SAFE_COINBASE_ERRORS = Object.freeze({
  cancelled: "The Coinbase request was cancelled.",
  timeout: "The Coinbase request timed out.",
  missingKey: "Coinbase private key is not saved",
  missingKeyName: "Coinbase CDP API key name is not saved",
  invalidKey: "Coinbase private key is invalid",
  invalidPath: "Coinbase request path is invalid",
  rejected: "Coinbase rejected the request",
  protocol: "Coinbase returned an unreadable response",
  oversized: "Coinbase response is too large",
  notConnected: "Coinbase is not connected",
});

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isAccountId(value: string): boolean {
  return ACCOUNT_ID_PATTERN.test(value);
}

export function isProductId(value: string): boolean {
  return PRODUCT_ID_PATTERN.test(value);
}

export function isKeyName(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_KEY_NAME_LENGTH &&
    KEY_NAME_PATTERN.test(value)
  );
}

export function coinbaseOrigin(sandbox: boolean): string {
  return sandbox ? COINBASE_SANDBOX_ORIGIN : COINBASE_PRODUCTION_ORIGIN;
}

export function coinbaseHost(sandbox: boolean): string {
  return sandbox ? COINBASE_SANDBOX_HOST : COINBASE_PRODUCTION_HOST;
}

export function accountPath(accountId: string): string {
  return `${ACCOUNTS_PATH}/${accountId}`;
}

export function productPath(productId: string): string {
  return `${PRODUCTS_PATH}/${productId}`;
}

export function transactionsPath(accountId: string): string {
  return `/v2/accounts/${accountId}/transactions`;
}

export function isAllowedCoinbasePath(method: string, pathname: string): boolean {
  const upper = method.toUpperCase();
  if (upper === "GET" && pathname === ACCOUNTS_PATH) {
    return true;
  }
  if (upper === "GET" && pathname === HISTORICAL_ORDERS_PATH) {
    return true;
  }
  if (upper === "POST" && pathname === ORDERS_PATH) {
    return true;
  }
  const account = /^\/api\/v3\/brokerage\/accounts\/([^/]+)$/.exec(pathname);
  if (upper === "GET" && account?.[1] !== undefined && isAccountId(account[1])) {
    return true;
  }
  const product = /^\/api\/v3\/brokerage\/products\/([^/]+)$/.exec(pathname);
  if (upper === "GET" && product?.[1] !== undefined && isProductId(product[1])) {
    return true;
  }
  const transactions = /^\/v2\/accounts\/([^/]+)\/transactions$/.exec(pathname);
  if (
    (upper === "GET" || upper === "POST") &&
    transactions?.[1] !== undefined &&
    isAccountId(transactions[1])
  ) {
    return true;
  }
  return false;
}

export function boundDiagnostic(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length <= MAX_DIAGNOSTIC_CHARS
    ? collapsed
    : `${collapsed.slice(0, MAX_DIAGNOSTIC_CHARS)}…`;
}
