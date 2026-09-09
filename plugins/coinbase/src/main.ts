import {
  DEFAULT_CONNECTOR_ACCOUNT_ID,
  coinbaseDisconnect,
  coinbaseGetStatus,
  coinbaseVerify,
  connectorSecretKey,
  type CoinbaseStatus,
} from "@borg/contracts";
import {
  definePlugin,
  type Disposable,
  type PluginContext,
} from "@borg/plugin-sdk";
import { CoinbaseClient } from "./client";
import {
  defaultCoinbaseConfig,
  parseCoinbaseConfig,
  sameCoinbaseConfig,
  coinbaseConfigSchema,
  type CoinbaseConfig,
  type CoinbaseConnectorAccount,
} from "./config";
import {
  COINBASE_PRIVATE_KEY_SECRET,
  SAFE_COINBASE_ERRORS,
  boundDiagnostic,
  isKeyName,
} from "./protocol";
import { registerCoinbaseTools } from "./tools";

export class CoinbaseController {
  readonly #context: PluginContext;
  #config: CoinbaseConfig = defaultCoinbaseConfig();
  #registration: Disposable | undefined;
  #configWatch: Disposable | undefined;
  #queue: Promise<void> = Promise.resolve();
  #configError: string | undefined;
  readonly #errors = new Map<string, string>();
  readonly #paused = new Set<string>();
  #disposed = false;

  constructor(context: PluginContext) {
    this.#context = context;
  }

  async initialize(): Promise<void> {
    this.#config = this.#read(await this.#context.config.get());
    this.#configWatch = this.#context.config.watch((next) =>
      this.#onConfigChanged(next),
    );
    await this.#sync();
  }

  async status(accountId?: string): Promise<CoinbaseStatus> {
    const account = this.#resolve(accountId);
    const hasPrivateKey = await this.#context.secrets.has(
      connectorSecretKey(account.id, COINBASE_PRIVATE_KEY_SECRET),
    );
    const error = this.#configError ?? this.#errors.get(account.id);
    return {
      accountId: account.id,
      name: account.name,
      hasPrivateKey,
      hasKeyName: isKeyName(account.keyName),
      enabled: account.enabled,
      sandbox: account.sandbox,
      connected: await this.#isLive(account),
      ...(error !== undefined ? { error } : {}),
    };
  }

  async verify(
    accountId?: string,
    signal?: AbortSignal | undefined,
  ): Promise<CoinbaseStatus> {
    const account = this.#resolve(accountId);
    this.#paused.delete(account.id);
    this.#errors.delete(account.id);
    await this.#sync();
    if (!isKeyName(account.keyName)) {
      this.#errors.set(account.id, SAFE_COINBASE_ERRORS.missingKeyName);
      return this.status(account.id);
    }
    try {
      await this.#createClient(account).listAccounts(signal);
      this.#errors.delete(account.id);
    } catch (error) {
      this.#errors.set(account.id, describeError(error));
    }
    return this.status(account.id);
  }

  async disconnect(accountId?: string): Promise<CoinbaseStatus> {
    const account = this.#resolve(accountId);
    this.#paused.add(account.id);
    this.#errors.delete(account.id);
    await this.#sync();
    return this.status(account.id);
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#configWatch?.dispose();
    this.#configWatch = undefined;
    await this.#sync();
  }

  #resolve(accountId?: string): CoinbaseConnectorAccount {
    const accounts = this.#config.accounts;
    if (accountId !== undefined && accountId.length > 0) {
      const match = accounts.find((account) => account.id === accountId);
      if (!match) {
        throw new Error(`Unknown Coinbase account ${accountId}`);
      }
      return match;
    }
    const fallback =
      accounts.find((account) => account.id === DEFAULT_CONNECTOR_ACCOUNT_ID) ??
      (accounts.length === 1 ? accounts[0] : undefined);
    if (fallback === undefined) {
      throw new Error(
        accounts.length === 0
          ? "No Coinbase account is configured"
          : "Specify accountId when multiple Coinbase accounts exist",
      );
    }
    return fallback;
  }

  async #clientForConnection(
    connectionId: string | undefined,
  ): Promise<CoinbaseClient> {
    const live = await this.#liveAccounts();
    if (connectionId !== undefined && connectionId.length > 0) {
      const match = live.find((account) => account.id === connectionId);
      if (match === undefined) {
        throw new Error(
          `Coinbase connection ${connectionId} is not connected`,
        );
      }
      return this.#createClient(match);
    }
    if (live.length === 1) {
      const only = live[0];
      if (only !== undefined) {
        return this.#createClient(only);
      }
    }
    throw new Error(
      live.length === 0
        ? SAFE_COINBASE_ERRORS.notConnected
        : "Specify connectionId when multiple Coinbase accounts are connected",
    );
  }

  async #isLive(account: CoinbaseConnectorAccount): Promise<boolean> {
    if (
      this.#disposed ||
      this.#paused.has(account.id) ||
      !account.enabled ||
      !isKeyName(account.keyName)
    ) {
      return false;
    }
    return this.#context.secrets.has(
      connectorSecretKey(account.id, COINBASE_PRIVATE_KEY_SECRET),
    );
  }

  async #liveAccounts(): Promise<CoinbaseConnectorAccount[]> {
    const live: CoinbaseConnectorAccount[] = [];
    for (const account of this.#config.accounts) {
      if (await this.#isLive(account)) {
        live.push(account);
      }
    }
    return live;
  }

  #read(candidate: unknown): CoinbaseConfig {
    try {
      const config = parseCoinbaseConfig(candidate);
      this.#configError = undefined;
      return config;
    } catch (error) {
      this.#configError = describeError(error);
      this.#context.logger.warn("Coinbase settings are invalid", {
        reason: this.#configError,
      });
      return defaultCoinbaseConfig();
    }
  }

  async #onConfigChanged(candidate: unknown): Promise<void> {
    const next = this.#read(candidate);
    if (sameCoinbaseConfig(this.#config, next)) {
      return;
    }
    this.#config = next;
    await this.#sync();
  }

  #sync(): Promise<void> {
    const run = this.#queue.then(() => this.#syncNow());
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #syncNow(): Promise<void> {
    if (this.#disposed) {
      await this.#clearRegistration();
      return;
    }
    const wanted = new Set(this.#config.accounts.map((account) => account.id));
    for (const accountId of [...this.#paused]) {
      if (!wanted.has(accountId)) {
        this.#paused.delete(accountId);
      }
    }
    for (const accountId of [...this.#errors.keys()]) {
      if (!wanted.has(accountId)) {
        this.#errors.delete(accountId);
      }
    }
    const live: CoinbaseConnectorAccount[] = [];
    for (const account of this.#config.accounts) {
      if (await this.#isLive(account)) {
        live.push(account);
        const error = this.#errors.get(account.id);
        if (
          error === SAFE_COINBASE_ERRORS.missingKey ||
          error === SAFE_COINBASE_ERRORS.missingKeyName
        ) {
          this.#errors.delete(account.id);
        }
        continue;
      }
      if (!account.enabled || this.#paused.has(account.id)) {
        continue;
      }
      if (!isKeyName(account.keyName)) {
        this.#errors.set(account.id, SAFE_COINBASE_ERRORS.missingKeyName);
      } else if (
        !(await this.#context.secrets.has(
          connectorSecretKey(account.id, COINBASE_PRIVATE_KEY_SECRET),
        ))
      ) {
        this.#errors.set(account.id, SAFE_COINBASE_ERRORS.missingKey);
      }
    }
    if (live.length === 0) {
      await this.#clearRegistration();
      return;
    }
    if (this.#registration === undefined) {
      this.#registration = registerCoinbaseTools(this.#context, (connectionId) =>
        this.#clientForConnection(connectionId),
      );
    }
  }

  async #clearRegistration(): Promise<void> {
    const current = this.#registration;
    this.#registration = undefined;
    await current?.dispose();
  }

  #createClient(account: CoinbaseConnectorAccount): CoinbaseClient {
    return new CoinbaseClient({
      http: this.#context.http,
      sandbox: account.sandbox,
      keyName: account.keyName,
      readPrivateKey: () =>
        this.#context.secrets.get(
          connectorSecretKey(account.id, COINBASE_PRIVATE_KEY_SECRET),
        ),
    });
  }
}

function describeError(error: unknown): string {
  return error instanceof Error && error.message.length > 0
    ? boundDiagnostic(error.message)
    : SAFE_COINBASE_ERRORS.protocol;
}

export default definePlugin({
  id: "borg.coinbase",
  version: "0.1.0",
  engines: {
    borg: "^0.1.0",
  },
  permissions: [
    "network:api.coinbase.com",
    "network:api-sandbox.coinbase.com",
    "network:dynamic",
    "secrets:read",
    "secrets:write",
    "tools.register",
    "ui.settings",
  ],
  contributes: {
    commands: [
      coinbaseDisconnect.id,
      coinbaseGetStatus.id,
      coinbaseVerify.id,
    ],
    kinds: ["settingsPage", "tool"],
  },
  configSchema: coinbaseConfigSchema,
  async activate(context) {
    const controller = new CoinbaseController(context);
    const handles = [
      context.bus.handle(coinbaseGetStatus, (input) =>
        controller.status(input.accountId),
      ),
      context.bus.handle(coinbaseVerify, (input, signal) =>
        controller.verify(input.accountId, signal),
      ),
      context.bus.handle(coinbaseDisconnect, (input) =>
        controller.disconnect(input.accountId),
      ),
    ];
    await controller.initialize();
    return {
      dispose: async () => {
        for (const handle of handles) {
          handle.dispose();
        }
        await controller.dispose();
      },
    };
  },
});
