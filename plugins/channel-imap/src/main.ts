import {
  DEFAULT_CONNECTOR_ACCOUNT_ID,
  connectorAdapterId,
  connectorSecretKey,
  imapChannelInject,
} from "@borg/contracts";
import {
  definePlugin,
  type Disposable,
  type PluginContext,
} from "@borg/plugin-sdk";
import {
  defaultImapChannelConfig,
  imapChannelConfigSchema,
  parseImapChannelConfig,
  sameImapAccountRuntime,
  type ImapChannelAccount,
  type ImapChannelConfig,
} from "./config";
import {
  IMAP_CHANNEL_ADAPTER_ID,
  IMAP_DEFAULT_MAILBOX,
  IMAP_PASSWORD_SECRET_KEY,
  ImapChannelNotStartedError,
  ImapFakeTransport,
} from "./runtime";

export {
  imapChannelConfigSchema,
  type ImapChannelAccount,
  type ImapChannelConfig,
} from "./config";

export {
  IMAP_CHANNEL_ADAPTER_ID,
  IMAP_DEFAULT_MAILBOX,
  IMAP_PASSWORD_SECRET_KEY,
  ImapChannelDisposedError,
  ImapChannelNotStartedError,
  ImapFakeTransport,
} from "./runtime";
export { ImapCodec, ImapError } from "./imap-codec";
export { ImapSession } from "./imap-session";

interface ImapAccountSession {
  account: ImapChannelAccount;
  transport: ImapFakeTransport;
  registration: Disposable | undefined;
}

class ImapChannelController {
  readonly #context: PluginContext;
  readonly #sessions = new Map<string, ImapAccountSession>();
  #config: ImapChannelConfig = defaultImapChannelConfig();
  #configWatch: Disposable | undefined;
  #queue: Promise<void> = Promise.resolve();
  #disposed = false;

  constructor(context: PluginContext) {
    this.#context = context;
  }

  async initialize(): Promise<void> {
    this.#config = this.#read(await this.#context.config.get());
    this.#configWatch = this.#context.config.watch((next) => {
      this.#config = this.#read(next);
      return this.sync();
    });
    await this.sync();
  }

  sync(): Promise<void> {
    const run = this.#queue.then(() => this.#syncNow());
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async inject(
    input: unknown,
    signal?: AbortSignal,
  ): Promise<{ readonly accepted: true; readonly externalId: string }> {
    const parsed = imapChannelInject.input.parse(input);
    const account = this.#resolve(parsed.accountId);
    const session = this.#sessions.get(account.id);
    if (!session) {
      throw new ImapChannelNotStartedError();
    }
    return session.transport.inject(
      {
        text: parsed.text,
        ...(parsed.destinationId !== undefined
          ? { destinationId: parsed.destinationId }
          : {}),
        ...(parsed.externalId !== undefined
          ? { externalId: parsed.externalId }
          : {}),
        ...(parsed.sender !== undefined ? { sender: parsed.sender } : {}),
        ...(parsed.classification !== undefined
          ? { classification: parsed.classification }
          : {}),
      },
      signal,
    );
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#configWatch?.dispose();
    this.#configWatch = undefined;
    await this.sync();
  }

  #resolve(accountId?: string): ImapChannelAccount {
    const accounts = this.#config.accounts;
    if (accountId !== undefined && accountId.length > 0) {
      const match = accounts.find((account) => account.id === accountId);
      if (!match) {
        throw new Error(`Unknown IMAP account ${accountId}`);
      }
      return match;
    }
    const fallback =
      accounts.find((account) => account.id === DEFAULT_CONNECTOR_ACCOUNT_ID) ??
      (accounts.length === 1 ? accounts[0] : undefined);
    if (fallback === undefined) {
      throw new Error(
        accounts.length === 0
          ? "No IMAP account is configured"
          : "Specify accountId when multiple IMAP accounts exist",
      );
    }
    return fallback;
  }

  #read(candidate: unknown): ImapChannelConfig {
    try {
      return parseImapChannelConfig(candidate);
    } catch {
      this.#context.logger.warn("IMAP settings are invalid");
      return defaultImapChannelConfig();
    }
  }

  async #syncNow(): Promise<void> {
    if (this.#disposed) {
      for (const accountId of [...this.#sessions.keys()]) {
        await this.#stopSession(accountId);
      }
      return;
    }
    const wanted = new Set(this.#config.accounts.map((account) => account.id));
    for (const accountId of [...this.#sessions.keys()]) {
      if (!wanted.has(accountId)) {
        await this.#stopSession(accountId);
      }
    }
    for (const account of this.#config.accounts) {
      await this.#syncAccount(account);
    }
  }

  async #syncAccount(account: ImapChannelAccount): Promise<void> {
    const mailbox = account.mailbox.trim() || IMAP_DEFAULT_MAILBOX;
    const host = account.host.trim();
    const username = account.username.trim();
    const configured =
      account.enabled &&
      host.length > 0 &&
      username.length > 0 &&
      (await this.#context.secrets.has(
        connectorSecretKey(account.id, IMAP_PASSWORD_SECRET_KEY),
      ));
    if (!configured) {
      await this.#stopSession(account.id);
      return;
    }
    const existing = this.#sessions.get(account.id);
    if (
      existing?.registration !== undefined &&
      sameImapAccountRuntime(existing.account, account)
    ) {
      existing.account = account;
      return;
    }
    await this.#stopSession(account.id);
    this.#startSession(account, host, username, mailbox);
  }

  #startSession(
    account: ImapChannelAccount,
    host: string,
    username: string,
    mailbox: string,
  ): void {
    const transport = new ImapFakeTransport({
      id: connectorAdapterId(IMAP_CHANNEL_ADAPTER_ID, account.id),
      tls: this.#context.tls,
      runtime: this.#context.runtime,
      logger: this.#context.logger,
      readPassword: () =>
        this.#context.secrets.get(
          connectorSecretKey(account.id, IMAP_PASSWORD_SECRET_KEY),
        ),
    });
    transport.destinations = [mailbox];
    transport.configureEndpoint({
      host,
      port: account.port,
      username,
    });
    const session: ImapAccountSession = {
      account,
      transport,
      registration: undefined,
    };
    this.#sessions.set(account.id, session);
    session.registration = this.#context.channels.register(transport);
  }

  async #stopSession(accountId: string): Promise<void> {
    const session = this.#sessions.get(accountId);
    if (!session) {
      return;
    }
    this.#sessions.delete(accountId);
    const registration = session.registration;
    session.registration = undefined;
    await registration?.dispose();
    session.transport.dispose();
  }
}

export default definePlugin({
  id: "borg.channel.imap",
  version: "0.1.0",
  engines: {
    borg: "^0.1.0",
  },
  permissions: [
    "channels.register",
    "network:tls",
    "runtime.background",
    "secrets:read",
    "secrets:write",
    "ui.settings",
  ],
  contributes: {
    commands: [imapChannelInject.id],
    kinds: ["channel", "settingsPage"],
  },
  configSchema: imapChannelConfigSchema,
  async activate(context) {
    const controller = new ImapChannelController(context);
    await controller.initialize();
    const injectCommand = context.bus.handle(
      imapChannelInject,
      async (input, signal) => {
        signal.throwIfAborted();
        return controller.inject(input, signal);
      },
    );
    return {
      dispose: async () => {
        injectCommand.dispose();
        await controller.dispose();
      },
    };
  },
});
