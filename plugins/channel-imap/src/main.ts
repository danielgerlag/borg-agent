import { imapChannelInject } from "@borg/contracts";
import {
  definePlugin,
  z,
  type Disposable,
  type PluginContext,
} from "@borg/plugin-sdk";
import {
  IMAP_DEFAULT_MAILBOX,
  IMAP_PASSWORD_SECRET_KEY,
  ImapFakeTransport,
} from "./runtime";

export {
  IMAP_CHANNEL_ADAPTER_ID,
  IMAP_DEFAULT_MAILBOX,
  IMAP_PASSWORD_SECRET_KEY,
  ImapChannelDisposedError,
  ImapChannelNotStartedError,
  ImapFakeTransport,
} from "./runtime";

export const imapChannelConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    host: z.string().max(253).default(""),
    port: z.number().int().min(1).max(65_535).default(993),
    username: z.string().max(320).default(""),
    mailbox: z.string().min(1).max(256).default(IMAP_DEFAULT_MAILBOX),
  })
  .strict();

export type ImapChannelConfig = z.infer<typeof imapChannelConfigSchema>;

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
    const mailbox = config.mailbox.trim() || IMAP_DEFAULT_MAILBOX;
    this.transport.destinations = [mailbox];
    const configured =
      config.enabled &&
      config.host.trim().length > 0 &&
      config.username.trim().length > 0 &&
      (await this.#context.secrets.has(IMAP_PASSWORD_SECRET_KEY));
    if (!configured) {
      await this.#teardown();
      return;
    }
    if (this.#registration) {
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
  permissions: ["channels.register", "secrets:read"],
  contributes: {
    commands: [imapChannelInject.id],
    kinds: ["channel"],
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
