import { imapChannelInject } from "@borg/contracts";
import {
  definePlugin,
  type Disposable,
  type PluginContext,
} from "@borg/plugin-sdk";
import { imapChannelConfigSchema } from "./config";
import {
  IMAP_DEFAULT_MAILBOX,
  IMAP_PASSWORD_SECRET_KEY,
  ImapFakeTransport,
} from "./runtime";

export {
  imapChannelConfigSchema,
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

class ImapChannelController {
  readonly #context: PluginContext;
  readonly transport = new ImapFakeTransport();
  #registration: Disposable | undefined;
  #configWatch: Disposable | undefined;
  #queue: Promise<void> = Promise.resolve();
  #disposed = false;

  constructor(context: PluginContext) {
    this.#context = context;
  }

  async initialize(): Promise<void> {
    this.#configWatch = this.#context.config.watch(() => this.sync());
    await this.sync();
  }

  sync(): Promise<void> {
    const run = this.#queue.then(() => this.#syncNow());
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#configWatch?.dispose();
    this.#configWatch = undefined;
    await this.#teardown();
    this.transport.dispose();
  }

  async #syncNow(): Promise<void> {
    if (this.#disposed) {
      await this.#teardown();
      return;
    }
    const config = imapChannelConfigSchema.parse(await this.#context.config.get());
    await this.#teardown();
    const mailbox = config.mailbox.trim() || IMAP_DEFAULT_MAILBOX;
    this.transport.destinations = [mailbox];
    const configured =
      config.enabled &&
      config.host.trim().length > 0 &&
      config.username.trim().length > 0 &&
      (await this.#context.secrets.has(IMAP_PASSWORD_SECRET_KEY));
    if (!configured) {
      return;
    }
    this.#registration = this.#context.channels.register(this.transport);
  }

  async #teardown(): Promise<void> {
    const registration = this.#registration;
    this.#registration = undefined;
    await registration?.dispose();
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
        return controller.transport.inject(
          imapChannelInject.input.parse(input),
          signal,
        );
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
