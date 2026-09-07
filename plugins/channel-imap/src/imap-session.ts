import type {
  ChannelInboundDraft,
  PluginTls,
  PluginTlsSocket,
} from "@borg/plugin-sdk";
import { ImapCodec } from "./imap-codec";

export class ImapSession {
  readonly #tls: PluginTls;
  readonly #readPassword: () => Promise<string | undefined>;
  readonly #host: string;
  readonly #port: number;
  readonly #username: string;
  readonly #mailbox: string;
  readonly #ingest: (draft: ChannelInboundDraft) => void | Promise<void>;
  #socket: PluginTlsSocket | undefined;
  #codec: ImapCodec | undefined;
  #connected = false;

  constructor(options: {
    readonly tls: PluginTls;
    readonly readPassword: () => Promise<string | undefined>;
    readonly host: string;
    readonly port: number;
    readonly username: string;
    readonly mailbox: string;
    readonly ingest: (draft: ChannelInboundDraft) => void | Promise<void>;
  }) {
    this.#tls = options.tls;
    this.#readPassword = options.readPassword;
    this.#host = options.host;
    this.#port = options.port;
    this.#username = options.username;
    this.#mailbox = options.mailbox;
    this.#ingest = options.ingest;
  }

  get connected(): boolean {
    return this.#connected;
  }

  async run(signal: AbortSignal): Promise<void> {
    const password = await this.#readPassword();
    if (!password) {
      throw new Error("IMAP password is not saved");
    }
    const socket = await this.#tls.connect({
      host: this.#host,
      port: this.#port,
      signal,
    });
    this.#socket = socket;
    try {
      const codec = new ImapCodec(socket);
      this.#codec = codec;
      await codec.readGreeting(signal);
      await codec.login(this.#username, password, signal);
      await codec.select(this.#mailbox, signal);
      this.#connected = true;
      await codec.idleAndFetch(this.#ingest, signal);
    } finally {
      this.#connected = false;
      this.#codec = undefined;
      const current = this.#socket;
      this.#socket = undefined;
      await current?.close();
    }
  }

  async append(
    text: string,
    signal?: AbortSignal,
  ): Promise<{ readonly externalId: string; readonly sentAt: string }> {
    const codec = this.#codec;
    if (!codec || !this.#connected) {
      throw new Error("IMAP session is not connected");
    }
    return codec.append(this.#mailbox, text, signal);
  }

  async dispose(): Promise<void> {
    this.#connected = false;
    this.#codec = undefined;
    const socket = this.#socket;
    this.#socket = undefined;
    await socket?.close();
  }
}
