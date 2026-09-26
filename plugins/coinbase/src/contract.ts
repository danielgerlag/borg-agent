import {
  connectorAccountIdSchema,
  connectorAccountNameSchema,
  connectorCommandInputSchema,
  defineCommand,
} from "@borg/contracts";
import { z } from "zod";

export const COINBASE_ACCOUNT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const COINBASE_PRODUCT_ID_PATTERN = /^[A-Z0-9.]{1,16}-[A-Z0-9.]{1,16}$/;
export const COINBASE_CURRENCY_PATTERN = /^[A-Z0-9]{2,10}$/;
export const COINBASE_AMOUNT_PATTERN = /^-?\d{1,18}(\.\d{1,18})?$/;
export const COINBASE_KEY_NAME_PATTERN =
  /^(organizations|orgs)\/[A-Za-z0-9_-]+\/apiKeys\/[A-Za-z0-9_-]+$/;

export const coinbaseStatusSchema = z
  .object({
    accountId: connectorAccountIdSchema,
    name: connectorAccountNameSchema,
    hasPrivateKey: z.boolean(),
    hasKeyName: z.boolean(),
    enabled: z.boolean(),
    sandbox: z.boolean(),
    connected: z.boolean(),
    error: z.string().max(1_000).optional(),
  })
  .strict();

export type CoinbaseStatus = z.infer<typeof coinbaseStatusSchema>;

export const coinbaseGetStatus = defineCommand({
  id: "borg.coinbase.getStatus",
  input: connectorCommandInputSchema,
  output: coinbaseStatusSchema,
});

export const coinbaseVerify = defineCommand({
  id: "borg.coinbase.verify",
  input: connectorCommandInputSchema,
  output: coinbaseStatusSchema,
  timeoutMs: 30_000,
});

export const coinbaseDisconnect = defineCommand({
  id: "borg.coinbase.disconnect",
  input: connectorCommandInputSchema,
  output: coinbaseStatusSchema,
});

export const coinbaseAccountSchema = z
  .object({
    id: z.string().regex(COINBASE_ACCOUNT_ID_PATTERN),
    name: z.string().min(1).max(256),
    currency: z.string().regex(COINBASE_CURRENCY_PATTERN),
    available: z.string().regex(COINBASE_AMOUNT_PATTERN),
    hold: z.string().regex(COINBASE_AMOUNT_PATTERN),
    type: z.string().min(1).max(64),
    active: z.boolean(),
  })
  .strict();

export type CoinbaseAccount = z.infer<typeof coinbaseAccountSchema>;

export const coinbaseListAccountsInputSchema = z
  .object({
    connectionId: connectorAccountIdSchema.optional(),
  })
  .strict();
export type CoinbaseListAccountsInput = z.input<
  typeof coinbaseListAccountsInputSchema
>;

export const coinbaseListAccountsOutputSchema = z
  .object({
    accounts: z.array(coinbaseAccountSchema).max(100),
  })
  .strict();
export type CoinbaseListAccountsOutput = z.infer<
  typeof coinbaseListAccountsOutputSchema
>;

export const coinbaseGetAccountInputSchema = z
  .object({
    connectionId: connectorAccountIdSchema.optional(),
    accountId: z.string().regex(COINBASE_ACCOUNT_ID_PATTERN),
  })
  .strict();
export type CoinbaseGetAccountInput = z.input<
  typeof coinbaseGetAccountInputSchema
>;

export const coinbaseGetAccountOutputSchema = coinbaseAccountSchema;
export type CoinbaseGetAccountOutput = z.infer<
  typeof coinbaseGetAccountOutputSchema
>;

export const coinbaseProductSchema = z
  .object({
    productId: z.string().regex(COINBASE_PRODUCT_ID_PATTERN),
    price: z.string().regex(COINBASE_AMOUNT_PATTERN),
    baseCurrency: z.string().regex(COINBASE_CURRENCY_PATTERN),
    quoteCurrency: z.string().regex(COINBASE_CURRENCY_PATTERN),
    status: z.string().min(1).max(64),
  })
  .strict();

export type CoinbaseProduct = z.infer<typeof coinbaseProductSchema>;

export const coinbaseGetPriceInputSchema = z
  .object({
    connectionId: connectorAccountIdSchema.optional(),
    productId: z.string().regex(COINBASE_PRODUCT_ID_PATTERN),
  })
  .strict();
export type CoinbaseGetPriceInput = z.input<typeof coinbaseGetPriceInputSchema>;
export const coinbaseGetPriceOutputSchema = coinbaseProductSchema;
export type CoinbaseGetPriceOutput = z.infer<typeof coinbaseGetPriceOutputSchema>;

export const coinbaseTransactionSchema = z
  .object({
    id: z.string().min(1).max(128),
    type: z.string().min(1).max(64),
    status: z.string().min(1).max(64),
    amount: z.string().regex(COINBASE_AMOUNT_PATTERN),
    currency: z.string().regex(COINBASE_CURRENCY_PATTERN),
    nativeAmount: z.string().regex(COINBASE_AMOUNT_PATTERN).optional(),
    nativeCurrency: z.string().regex(COINBASE_CURRENCY_PATTERN).optional(),
    description: z.string().min(1).max(512).optional(),
    createdAt: z.string().min(1).max(80),
  })
  .strict();

export type CoinbaseTransaction = z.infer<typeof coinbaseTransactionSchema>;

export const coinbaseListTransactionsInputSchema = z
  .object({
    connectionId: connectorAccountIdSchema.optional(),
    accountId: z.string().regex(COINBASE_ACCOUNT_ID_PATTERN),
  })
  .strict();
export type CoinbaseListTransactionsInput = z.input<
  typeof coinbaseListTransactionsInputSchema
>;

export const coinbaseListTransactionsOutputSchema = z
  .object({
    transactions: z.array(coinbaseTransactionSchema).max(100),
  })
  .strict();
export type CoinbaseListTransactionsOutput = z.infer<
  typeof coinbaseListTransactionsOutputSchema
>;

export const coinbaseCreateOrderInputSchema = z
  .object({
    connectionId: connectorAccountIdSchema.optional(),
    productId: z.string().regex(COINBASE_PRODUCT_ID_PATTERN),
    side: z.enum(["BUY", "SELL"]),
    quoteSize: z.string().regex(COINBASE_AMOUNT_PATTERN).optional(),
    baseSize: z.string().regex(COINBASE_AMOUNT_PATTERN).optional(),
  })
  .strict()
  .refine(
    (value) =>
      (value.quoteSize !== undefined) !== (value.baseSize !== undefined),
    "Specify quoteSize or baseSize, not both",
  );
export type CoinbaseCreateOrderInput = z.input<
  typeof coinbaseCreateOrderInputSchema
>;

export const coinbaseCreateOrderOutputSchema = z
  .object({
    success: z.boolean(),
    orderId: z.string().max(128),
    failureReason: z.string().max(256).optional(),
  })
  .strict();
export type CoinbaseCreateOrderOutput = z.infer<
  typeof coinbaseCreateOrderOutputSchema
>;

export const coinbaseSendCryptoInputSchema = z
  .object({
    connectionId: connectorAccountIdSchema.optional(),
    accountId: z.string().regex(COINBASE_ACCOUNT_ID_PATTERN),
    to: z
      .string()
      .min(3)
      .max(256)
      .refine((value) => !/\s/.test(value), "Destination must not contain spaces"),
    amount: z.string().regex(COINBASE_AMOUNT_PATTERN),
    currency: z.string().regex(COINBASE_CURRENCY_PATTERN),
  })
  .strict();
export type CoinbaseSendCryptoInput = z.input<
  typeof coinbaseSendCryptoInputSchema
>;

export const coinbaseSendCryptoOutputSchema = coinbaseTransactionSchema;
export type CoinbaseSendCryptoOutput = z.infer<
  typeof coinbaseSendCryptoOutputSchema
>;

export const coinbaseOrderSchema = z
  .object({
    orderId: z.string().min(1).max(128),
    productId: z.string().regex(COINBASE_PRODUCT_ID_PATTERN),
    side: z.string().min(1).max(16),
    status: z.string().min(1).max(64),
    createdAt: z.string().min(1).max(80).optional(),
    filledSize: z.string().regex(COINBASE_AMOUNT_PATTERN).optional(),
    averageFilledPrice: z.string().regex(COINBASE_AMOUNT_PATTERN).optional(),
  })
  .strict();

export type CoinbaseOrder = z.infer<typeof coinbaseOrderSchema>;

export const coinbaseListOrdersInputSchema = z
  .object({
    connectionId: connectorAccountIdSchema.optional(),
  })
  .strict();
export type CoinbaseListOrdersInput = z.input<typeof coinbaseListOrdersInputSchema>;

export const coinbaseListOrdersOutputSchema = z
  .object({
    orders: z.array(coinbaseOrderSchema).max(100),
  })
  .strict();
export type CoinbaseListOrdersOutput = z.infer<
  typeof coinbaseListOrdersOutputSchema
>;
