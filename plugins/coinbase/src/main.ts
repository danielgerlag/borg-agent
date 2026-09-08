import {
  coinbaseDisconnect,
  coinbaseGetStatus,
  coinbaseVerify,
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
  #error: string | undefined;
  #paused = false;
  #disposed = false;

  constructor(context: PluginContext) {
    this.#context = context;
  }

  async initialize(): Promise<void> {
    this.#config = this.#read(await this.#context.config.get());
    this.#configWatch = this.#context.config.watch((next) => {
      void this.#onConfigChanged(next);
    });
    await this.#sync();
  }

  async status(): Promise<CoinbaseStatus> {
    const hasPrivateKey = await this.#context.secrets.has(
      COINBASE_PRIVATE_KEY_SECRET,
    );
    const error = this.#configError ?? this.#error;
    return {
      hasPrivateKey,
      hasKeyName: isKeyName(this.#config.keyName),
      enabled: this.#config.enabled,
      sandbox: this.#config.sandbox,
      connected: this.#registration !== undefined,
      ...(error !== undefined ? { error } : {}),
    };
  }

  async verify(signal?: AbortSignal | undefined): Promise<CoinbaseStatus> {
    this.#paused = false;
    this.#error = undefined;
    await this.#sync();
    if (!isKeyName(this.#config.keyName)) {
      this.#error = SAFE_COINBASE_ERRORS.missingKeyName;
      return this.status();
    }
    try {
      await this.#createClient().listAccounts(signal);
      this.#error = undefined;
    } catch (error) {
      this.#error = describeError(error);
    }
    return this.status();
  }

  async disconnect(): Promise<CoinbaseStatus> {
    this.#paused = true;
    this.#error = undefined;
    await this.#sync();
    return this.status();
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#configWatch?.dispose();
    this.#configWatch = undefined;
    await this.#sync();
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
    this.#paused = false;
    await this.#sync();
  }

  #sync(): Promise<void> {
    const run = this.#queue.then(() => this.#syncNow());
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async #syncNow(): Promise<void> {
    await this.#clearRegistration();
    if (this.#disposed || this.#paused) {
      return;
    }
    if (!this.#config.enabled) {
      return;
    }
    if (!isKeyName(this.#config.keyName)) {
      this.#error = SAFE_COINBASE_ERRORS.missingKeyName;
      return;
    }
    if (!(await this.#context.secrets.has(COINBASE_PRIVATE_KEY_SECRET))) {
      this.#error = SAFE_COINBASE_ERRORS.missingKey;
      return;
    }
    this.#error = undefined;
    this.#registration = registerCoinbaseTools(
      this.#context,
      this.#createClient(),
    );
  }

  async #clearRegistration(): Promise<void> {
    const current = this.#registration;
    this.#registration = undefined;
    await current?.dispose();
  }

  #createClient(): CoinbaseClient {
    return new CoinbaseClient({
      http: this.#context.http,
      sandbox: this.#config.sandbox,
      keyName: this.#config.keyName,
      readPrivateKey: () =>
        this.#context.secrets.get(COINBASE_PRIVATE_KEY_SECRET),
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
      context.bus.handle(coinbaseGetStatus, () => controller.status()),
      context.bus.handle(coinbaseVerify, (_input, signal) =>
        controller.verify(signal),
      ),
      context.bus.handle(coinbaseDisconnect, () => controller.disconnect()),
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
