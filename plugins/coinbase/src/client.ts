import {
  coinbaseAccountSchema,
  coinbaseCreateOrderOutputSchema,
  coinbaseListAccountsOutputSchema,
  coinbaseListOrdersOutputSchema,
  coinbaseListTransactionsOutputSchema,
  coinbaseOrderSchema,
  coinbaseProductSchema,
  coinbaseTransactionSchema,
  type CoinbaseAccount,
  type CoinbaseCreateOrderInput,
  type CoinbaseCreateOrderOutput,
  type CoinbaseGetAccountInput,
  type CoinbaseGetPriceInput,
  type CoinbaseListAccountsOutput,
  type CoinbaseListOrdersOutput,
  type CoinbaseListTransactionsInput,
  type CoinbaseListTransactionsOutput,
  type CoinbaseOrder,
  type CoinbaseProduct,
  type CoinbaseSendCryptoInput,
  type CoinbaseTransaction,
} from "@borg/contracts";
import type { PluginHttp } from "@borg/plugin-sdk";
import { randomUUID } from "node:crypto";
import { signCdpJwt, randomNonce } from "./jwt";
import {
  ACCOUNTS_PATH,
  HISTORICAL_ORDERS_PATH,
  MAX_PRIVATE_KEY_CHARS,
  MAX_REST_RESPONSE_BYTES,
  ORDERS_PATH,
  REQUEST_TIMEOUT_MS,
  SAFE_COINBASE_ERRORS,
  accountPath,
  boundDiagnostic,
  coinbaseHost,
  coinbaseOrigin,
  isAllowedCoinbasePath,
  isRecord,
  productPath,
  transactionsPath,
} from "./protocol";

export type CoinbaseErrorCode =
  | "auth"
  | "forbidden"
  | "not-found"
  | "invalid"
  | "failed";

export class CoinbaseError extends Error {
  constructor(
    readonly code: CoinbaseErrorCode,
    readonly status: number | undefined,
    message: string,
  ) {
    super(message);
    this.name = "CoinbaseError";
  }
}

export interface CoinbaseClientOptions {
  readonly http: PluginHttp;
  readonly sandbox: boolean;
  readonly keyName: string;
  readonly readPrivateKey: () => Promise<string | undefined>;
  readonly nowSeconds?: (() => number) | undefined;
  readonly nonce?: (() => string) | undefined;
  readonly createClientOrderId?: (() => string) | undefined;
}

export class CoinbaseClient {
  readonly #http: PluginHttp;
  readonly #sandbox: boolean;
  readonly #keyName: string;
  readonly #readPrivateKey: () => Promise<string | undefined>;
  readonly #nowSeconds: () => number;
  readonly #nonce: () => string;
  readonly #createClientOrderId: () => string;

  constructor(options: CoinbaseClientOptions) {
    this.#http = options.http;
    this.#sandbox = options.sandbox;
    this.#keyName = options.keyName;
    this.#readPrivateKey = options.readPrivateKey;
    this.#nowSeconds =
      options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
    this.#nonce = options.nonce ?? randomNonce;
    this.#createClientOrderId = options.createClientOrderId ?? (() => randomUUID());
  }

  async listAccounts(
    signal?: AbortSignal | undefined,
  ): Promise<CoinbaseListAccountsOutput> {
    const payload = await this.#request("GET", ACCOUNTS_PATH, { signal });
    if (!isRecord(payload) || !Array.isArray(payload.accounts)) {
      throw new CoinbaseError("invalid", undefined, SAFE_COINBASE_ERRORS.protocol);
    }
    return coinbaseListAccountsOutputSchema.parse({
      accounts: payload.accounts.map((item) => parseAccount(item)),
    });
  }

  async getAccount(
    input: CoinbaseGetAccountInput,
    signal?: AbortSignal | undefined,
  ): Promise<CoinbaseAccount> {
    const payload = await this.#request("GET", accountPath(input.accountId), {
      signal,
    });
    if (!isRecord(payload)) {
      throw new CoinbaseError("invalid", undefined, SAFE_COINBASE_ERRORS.protocol);
    }
    return parseAccount(payload.account ?? payload);
  }

  async getPrice(
    input: CoinbaseGetPriceInput,
    signal?: AbortSignal | undefined,
  ): Promise<CoinbaseProduct> {
    const payload = await this.#request("GET", productPath(input.productId), {
      signal,
    });
    return parseProduct(payload);
  }

  async listTransactions(
    input: CoinbaseListTransactionsInput,
    signal?: AbortSignal | undefined,
  ): Promise<CoinbaseListTransactionsOutput> {
    const payload = await this.#request(
      "GET",
      transactionsPath(input.accountId),
      { signal },
    );
    if (!isRecord(payload) || !Array.isArray(payload.data)) {
      throw new CoinbaseError("invalid", undefined, SAFE_COINBASE_ERRORS.protocol);
    }
    return coinbaseListTransactionsOutputSchema.parse({
      transactions: payload.data.map((item) => parseTransaction(item)),
    });
  }

  async createOrder(
    input: CoinbaseCreateOrderInput,
    signal?: AbortSignal | undefined,
  ): Promise<CoinbaseCreateOrderOutput> {
    const quoteSize = input.quoteSize;
    const baseSize = input.baseSize;
    const market =
      quoteSize !== undefined
        ? { quote_size: quoteSize }
        : baseSize !== undefined
          ? { base_size: baseSize }
          : undefined;
    if (market === undefined) {
      throw new CoinbaseError(
        "invalid",
        undefined,
        "Specify quoteSize or baseSize, not both",
      );
    }
    const payload = await this.#request("POST", ORDERS_PATH, {
      body: {
        client_order_id: this.#createClientOrderId(),
        product_id: input.productId,
        side: input.side,
        order_configuration: { market_market_ioc: market },
      },
      signal,
    });
    if (!isRecord(payload)) {
      throw new CoinbaseError("invalid", undefined, SAFE_COINBASE_ERRORS.protocol);
    }
    const orderId =
      typeof payload.order_id === "string" ? payload.order_id : "";
    const failureReason =
      typeof payload.failure_reason === "string"
        ? payload.failure_reason
        : undefined;
    return coinbaseCreateOrderOutputSchema.parse({
      success: payload.success === true,
      orderId,
      ...(failureReason !== undefined && failureReason.length > 0
        ? { failureReason }
        : {}),
    });
  }

  async sendCrypto(
    input: CoinbaseSendCryptoInput,
    signal?: AbortSignal | undefined,
  ): Promise<CoinbaseTransaction> {
    const payload = await this.#request(
      "POST",
      transactionsPath(input.accountId),
      {
        body: {
          type: "send",
          to: input.to,
          amount: input.amount,
          currency: input.currency,
        },
        signal,
      },
    );
    if (!isRecord(payload)) {
      throw new CoinbaseError("invalid", undefined, SAFE_COINBASE_ERRORS.protocol);
    }
    return parseTransaction(payload.data ?? payload);
  }

  async listOrders(
    signal?: AbortSignal | undefined,
  ): Promise<CoinbaseListOrdersOutput> {
    const payload = await this.#request("GET", HISTORICAL_ORDERS_PATH, {
      signal,
    });
    if (!isRecord(payload) || !Array.isArray(payload.orders)) {
      throw new CoinbaseError("invalid", undefined, SAFE_COINBASE_ERRORS.protocol);
    }
    return coinbaseListOrdersOutputSchema.parse({
      orders: payload.orders.map((item) => parseOrder(item)),
    });
  }

  async #request(
    method: string,
    path: string,
    init: {
      readonly body?: unknown;
      readonly signal?: AbortSignal | undefined;
    } = {},
  ): Promise<unknown> {
    const origin = coinbaseOrigin(this.#sandbox);
    const url = new URL(path, `${origin}/`);
    if (
      url.origin !== origin ||
      url.username !== "" ||
      url.password !== "" ||
      !isAllowedCoinbasePath(method, url.pathname)
    ) {
      throw new CoinbaseError(
        "invalid",
        undefined,
        SAFE_COINBASE_ERRORS.invalidPath,
      );
    }
    const privateKey = await this.#readPrivateKey();
    if (privateKey === undefined || privateKey.length === 0) {
      throw new CoinbaseError(
        "auth",
        undefined,
        SAFE_COINBASE_ERRORS.missingKey,
      );
    }
    if (privateKey.length > MAX_PRIVATE_KEY_CHARS) {
      throw new CoinbaseError(
        "auth",
        undefined,
        SAFE_COINBASE_ERRORS.invalidKey,
      );
    }
    const token = signCdpJwt({
      keyName: this.#keyName,
      privateKeyPem: privateKey,
      method,
      path: url.pathname,
      host: coinbaseHost(this.#sandbox),
      nowSeconds: this.#nowSeconds(),
      nonce: this.#nonce(),
    });
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const combined =
      init.signal === undefined
        ? timeout
        : AbortSignal.any([init.signal, timeout]);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    };
    let body: string | undefined;
    if (init.body !== undefined) {
      body = JSON.stringify(init.body);
      headers["Content-Type"] = "application/json";
    }
    let response: Response;
    try {
      response = await this.#http.fetch(url, {
        method,
        headers,
        redirect: "error",
        ...(body !== undefined ? { body } : {}),
        signal: combined,
      });
    } catch (error) {
      throw coinbaseErrorFromUnknown(error, timeout, init.signal);
    }
    if (!response.ok) {
      await discardBody(response);
      throw errorForStatus(response.status);
    }
    const text = await readBoundedText(response);
    if (text.length === 0) {
      throw new CoinbaseError(
        "invalid",
        response.status,
        SAFE_COINBASE_ERRORS.protocol,
      );
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new CoinbaseError(
        "invalid",
        response.status,
        SAFE_COINBASE_ERRORS.protocol,
      );
    }
  }
}

function parseAccount(value: unknown): CoinbaseAccount {
  if (!isRecord(value) || typeof value.uuid !== "string") {
    throw new CoinbaseError("invalid", undefined, SAFE_COINBASE_ERRORS.protocol);
  }
  const available = moneyValue(value.available_balance);
  const hold = moneyValue(value.hold);
  const currency =
    typeof value.currency === "string" && value.currency.length > 0
      ? value.currency
      : available.currency;
  const name =
    typeof value.name === "string" && value.name.trim().length > 0
      ? value.name.trim()
      : currency;
  return coinbaseAccountSchema.parse({
    id: value.uuid,
    name,
    currency,
    available: available.value,
    hold: hold.value,
    type: typeof value.type === "string" && value.type.length > 0
      ? value.type
      : "unknown",
    active: value.active !== false,
  });
}

function parseProduct(value: unknown): CoinbaseProduct {
  if (!isRecord(value) || typeof value.product_id !== "string") {
    throw new CoinbaseError("invalid", undefined, SAFE_COINBASE_ERRORS.protocol);
  }
  return coinbaseProductSchema.parse({
    productId: value.product_id,
    price: typeof value.price === "string" ? value.price : "0",
    baseCurrency:
      typeof value.base_currency_id === "string"
        ? value.base_currency_id
        : "UNK",
    quoteCurrency:
      typeof value.quote_currency_id === "string"
        ? value.quote_currency_id
        : "UNK",
    status:
      typeof value.status === "string" && value.status.length > 0
        ? value.status
        : "UNKNOWN",
  });
}

function parseTransaction(value: unknown): CoinbaseTransaction {
  if (!isRecord(value) || typeof value.id !== "string") {
    throw new CoinbaseError("invalid", undefined, SAFE_COINBASE_ERRORS.protocol);
  }
  const amount = moneyHash(value.amount);
  const native = isRecord(value.native_amount)
    ? moneyHash(value.native_amount)
    : undefined;
  const description =
    typeof value.description === "string" && value.description.trim().length > 0
      ? value.description.trim()
      : undefined;
  return coinbaseTransactionSchema.parse({
    id: value.id,
    type: typeof value.type === "string" && value.type.length > 0
      ? value.type
      : "unknown",
    status:
      typeof value.status === "string" && value.status.length > 0
        ? value.status
        : "unknown",
    amount: amount.value,
    currency: amount.currency,
    ...(native !== undefined
      ? { nativeAmount: native.value, nativeCurrency: native.currency }
      : {}),
    ...(description !== undefined ? { description } : {}),
    createdAt:
      typeof value.created_at === "string" && value.created_at.length > 0
        ? value.created_at
        : "unknown",
  });
}

function parseOrder(value: unknown): CoinbaseOrder {
  if (!isRecord(value) || typeof value.order_id !== "string") {
    throw new CoinbaseError("invalid", undefined, SAFE_COINBASE_ERRORS.protocol);
  }
  const createdAt =
    typeof value.created_time === "string" && value.created_time.length > 0
      ? value.created_time
      : undefined;
  const filledSize =
    typeof value.filled_size === "string" ? value.filled_size : undefined;
  const averageFilledPrice =
    typeof value.average_filled_price === "string"
      ? value.average_filled_price
      : undefined;
  return coinbaseOrderSchema.parse({
    orderId: value.order_id,
    productId:
      typeof value.product_id === "string" ? value.product_id : "UNK-UNK",
    side: typeof value.side === "string" && value.side.length > 0
      ? value.side
      : "UNKNOWN",
    status:
      typeof value.status === "string" && value.status.length > 0
        ? value.status
        : "UNKNOWN",
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(filledSize !== undefined ? { filledSize } : {}),
    ...(averageFilledPrice !== undefined ? { averageFilledPrice } : {}),
  });
}

function moneyValue(value: unknown): { value: string; currency: string } {
  if (!isRecord(value)) {
    return { value: "0", currency: "UNK" };
  }
  return {
    value: typeof value.value === "string" && value.value.length > 0
      ? value.value
      : "0",
    currency:
      typeof value.currency === "string" && value.currency.length > 0
        ? value.currency
        : "UNK",
  };
}

function moneyHash(value: unknown): { value: string; currency: string } {
  if (!isRecord(value)) {
    return { value: "0", currency: "UNK" };
  }
  return {
    value:
      typeof value.amount === "string" && value.amount.length > 0
        ? value.amount
        : "0",
    currency:
      typeof value.currency === "string" && value.currency.length > 0
        ? value.currency
        : "UNK",
  };
}

function errorForStatus(status: number): CoinbaseError {
  if (status === 401) {
    return new CoinbaseError("auth", status, "Coinbase rejected the API key");
  }
  if (status === 403) {
    return new CoinbaseError(
      "forbidden",
      status,
      "Coinbase denied access to this resource",
    );
  }
  if (status === 404) {
    return new CoinbaseError(
      "not-found",
      status,
      "Coinbase could not find this resource",
    );
  }
  return new CoinbaseError(
    "failed",
    status,
    boundDiagnostic(`Coinbase request failed with status ${status}`),
  );
}

function coinbaseErrorFromUnknown(
  error: unknown,
  timeout: AbortSignal,
  signal: AbortSignal | undefined,
): CoinbaseError {
  if (timeout.aborted && signal?.aborted !== true) {
    return new CoinbaseError("failed", undefined, SAFE_COINBASE_ERRORS.timeout);
  }
  if (
    (error instanceof Error && error.name === "AbortError") ||
    (error instanceof DOMException && error.name === "AbortError")
  ) {
    return new CoinbaseError(
      "failed",
      undefined,
      SAFE_COINBASE_ERRORS.cancelled,
    );
  }
  if (error instanceof CoinbaseError) {
    return error;
  }
  if (
    error instanceof Error &&
    Object.values(SAFE_COINBASE_ERRORS).includes(
      error.message as (typeof SAFE_COINBASE_ERRORS)[keyof typeof SAFE_COINBASE_ERRORS],
    )
  ) {
    return new CoinbaseError("auth", undefined, error.message);
  }
  return new CoinbaseError("failed", undefined, SAFE_COINBASE_ERRORS.protocol);
}

async function readBoundedText(response: Response): Promise<string> {
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_REST_RESPONSE_BYTES) {
    throw new CoinbaseError(
      "invalid",
      response.status,
      SAFE_COINBASE_ERRORS.oversized,
    );
  }
  return text;
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    return;
  }
}
