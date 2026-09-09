import {
  coinbaseCreateOrderInputSchema,
  coinbaseCreateOrderOutputSchema,
  coinbaseGetAccountInputSchema,
  coinbaseGetAccountOutputSchema,
  coinbaseGetPriceInputSchema,
  coinbaseGetPriceOutputSchema,
  coinbaseListAccountsInputSchema,
  coinbaseListAccountsOutputSchema,
  coinbaseListOrdersInputSchema,
  coinbaseListOrdersOutputSchema,
  coinbaseListTransactionsInputSchema,
  coinbaseListTransactionsOutputSchema,
  coinbaseSendCryptoInputSchema,
  coinbaseSendCryptoOutputSchema,
} from "@borg/contracts";
import {
  defineTool,
  type Disposable,
  type PluginContext,
} from "@borg/plugin-sdk";
import type { CoinbaseClient } from "./client";

const ACCOUNT_SECURITY = {
  outputClassification: "confidential",
  outputProvenance: "external",
  channelCapacity: "private",
} as const;

const PUBLIC_SECURITY = {
  outputClassification: "public",
  outputProvenance: "external",
  channelCapacity: "public",
} as const;

export type CoinbaseClientResolver = (
  connectionId: string | undefined,
) => Promise<CoinbaseClient>;

export function registerCoinbaseTools(
  context: PluginContext,
  resolveClient: CoinbaseClientResolver,
): Disposable {
  const handles = [
    context.tools.register(
      defineTool({
        id: "coinbase.trading.list_accounts",
        description: "List all Coinbase accounts with balances.",
        input: coinbaseListAccountsInputSchema,
        output: coinbaseListAccountsOutputSchema,
        approval: "auto",
        sideEffect: false,
        security: ACCOUNT_SECURITY,
        execute: async (input, execution) => {
          const client = await resolveClient(input.connectionId);
          return client.listAccounts(execution.signal);
        },
      }),
    ),
    context.tools.register(
      defineTool({
        id: "coinbase.trading.get_account",
        description: "Get details for a specific Coinbase account by UUID.",
        input: coinbaseGetAccountInputSchema,
        output: coinbaseGetAccountOutputSchema,
        approval: "auto",
        sideEffect: false,
        security: ACCOUNT_SECURITY,
        execute: async (input, execution) => {
          const client = await resolveClient(input.connectionId);
          return client.getAccount(input, execution.signal);
        },
      }),
    ),
    context.tools.register(
      defineTool({
        id: "coinbase.trading.get_price",
        description: "Get the current price for a trading pair (e.g. BTC-USD).",
        input: coinbaseGetPriceInputSchema,
        output: coinbaseGetPriceOutputSchema,
        approval: "auto",
        sideEffect: false,
        security: PUBLIC_SECURITY,
        execute: async (input, execution) => {
          const client = await resolveClient(input.connectionId);
          return client.getPrice(input, execution.signal);
        },
      }),
    ),
    context.tools.register(
      defineTool({
        id: "coinbase.trading.list_transactions",
        description: "List transactions for a specific account.",
        input: coinbaseListTransactionsInputSchema,
        output: coinbaseListTransactionsOutputSchema,
        approval: "auto",
        sideEffect: false,
        security: ACCOUNT_SECURITY,
        execute: async (input, execution) => {
          const client = await resolveClient(input.connectionId);
          return client.listTransactions(input, execution.signal);
        },
      }),
    ),
    context.tools.register(
      defineTool({
        id: "coinbase.trading.create_order",
        description:
          "Place a market order to buy or sell cryptocurrency. Specify either quoteSize (amount in quote currency, e.g. USD) or baseSize (amount in base currency, e.g. BTC).",
        input: coinbaseCreateOrderInputSchema,
        output: coinbaseCreateOrderOutputSchema,
        approval: "ask",
        sideEffect: true,
        security: ACCOUNT_SECURITY,
        execute: async (input, execution) => {
          const client = await resolveClient(input.connectionId);
          return client.createOrder(input, execution.signal);
        },
      }),
    ),
    context.tools.register(
      defineTool({
        id: "coinbase.trading.send_crypto",
        description:
          "Send cryptocurrency from an account to an external address or email.",
        input: coinbaseSendCryptoInputSchema,
        output: coinbaseSendCryptoOutputSchema,
        approval: "ask",
        sideEffect: true,
        security: ACCOUNT_SECURITY,
        execute: async (input, execution) => {
          const client = await resolveClient(input.connectionId);
          return client.sendCrypto(input, execution.signal);
        },
      }),
    ),
    context.tools.register(
      defineTool({
        id: "coinbase.trading.list_orders",
        description: "List historical orders.",
        input: coinbaseListOrdersInputSchema,
        output: coinbaseListOrdersOutputSchema,
        approval: "auto",
        sideEffect: false,
        security: ACCOUNT_SECURITY,
        execute: async (input, execution) => {
          const client = await resolveClient(input.connectionId);
          return client.listOrders(execution.signal);
        },
      }),
    ),
  ];
  return {
    dispose: async () => {
      for (const handle of [...handles].reverse()) {
        await handle.dispose();
      }
    },
  };
}
