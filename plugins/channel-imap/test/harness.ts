import type {
  PluginTls,
  PluginTlsConnectOptions,
  PluginTlsSocket,
} from "@borg/plugin-sdk";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bindSocket(
  readable: ReadableStream<Uint8Array>,
  writable: WritableStream<Uint8Array>,
): PluginTlsSocket {
  let resolveClosed = (): void => undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  let finished = false;
  const finish = async (): Promise<void> => {
    if (finished) {
      return closed;
    }
    finished = true;
    try {
      await writable.close();
    } catch {
      try {
        await writable.abort();
      } catch {
        // already closed
      }
    }
    try {
      await readable.cancel();
    } catch {
      // already cancelled
    }
    resolveClosed();
    return closed;
  };
  return {
    readable,
    writable,
    closed,
    close: () => finish(),
    dispose: () => {
      void finish();
    },
  };
}

export function createTlsPair(): {
  readonly client: PluginTlsSocket;
  readonly peer: PluginTlsSocket;
} {
  const toPeer = new TransformStream<Uint8Array, Uint8Array>();
  const toClient = new TransformStream<Uint8Array, Uint8Array>();
  return {
    client: bindSocket(toClient.readable, toPeer.writable),
    peer: bindSocket(toPeer.readable, toClient.writable),
  };
}

export class FakeTls implements PluginTls {
  readonly connections: PluginTlsConnectOptions[] = [];
  failNext: string | undefined;
  onPeer: ((peer: PluginTlsSocket) => void | Promise<void>) | undefined;

  async connect(options: PluginTlsConnectOptions): Promise<PluginTlsSocket> {
    this.connections.push({
      host: options.host,
      port: options.port,
      ...(options.servername !== undefined
        ? { servername: options.servername }
        : {}),
    });
    if (this.failNext !== undefined) {
      const message = this.failNext;
      this.failNext = undefined;
      throw new Error(message);
    }
    options.signal?.throwIfAborted();
    const { client, peer } = createTlsPair();
    if (options.signal) {
      const onAbort = (): void => {
        void client.close();
        void peer.close();
      };
      options.signal.addEventListener("abort", onAbort, { once: true });
    }
    void this.onPeer?.(peer);
    return client;
  }
}

export class ScriptedImapServer {
  readonly #writer: WritableStreamDefaultWriter<Uint8Array>;
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  #buffer: Uint8Array = new Uint8Array(0);
  #idleTag: string | undefined;

  constructor(peer: PluginTlsSocket) {
    this.#writer = peer.writable.getWriter();
    this.#reader = peer.readable.getReader();
  }

  async greet(line = "* OK IMAP4rev1 ready"): Promise<void> {
    await this.writeLine(line);
  }

  async expectLogin(username: string, password: string): Promise<void> {
    const line = await this.readLine();
    const match = /^(\S+) LOGIN /i.exec(line);
    if (!match?.[1]) {
      throw new Error(`expected LOGIN, got ${line}`);
    }
    if (!line.includes(`"${username}"`) || !line.includes(`"${password}"`)) {
      throw new Error("LOGIN credentials did not match");
    }
    await this.writeLine(`${match[1]} OK LOGIN completed`);
  }

  async expectSelect(mailbox: string, exists = 0): Promise<void> {
    const line = await this.readLine();
    const match = /^(\S+) SELECT /i.exec(line);
    if (!match?.[1] || !line.toUpperCase().includes(mailbox.toUpperCase())) {
      throw new Error(`expected SELECT ${mailbox}, got ${line}`);
    }
    await this.writeLine(`* ${exists} EXISTS`);
    await this.writeLine(`${match[1]} OK [READ-WRITE] SELECT completed`);
  }

  async expectIdle(): Promise<string> {
    const line = await this.readLine();
    const match = /^(\S+) IDLE$/i.exec(line);
    if (!match?.[1]) {
      throw new Error(`expected IDLE, got ${line}`);
    }
    this.#idleTag = match[1];
    await this.writeLine("+ idling");
    return match[1];
  }

  async expectDone(): Promise<void> {
    const line = await this.readLine();
    if (!/^DONE$/i.test(line)) {
      throw new Error(`expected DONE, got ${line}`);
    }
    const tag = this.#idleTag;
    this.#idleTag = undefined;
    if (tag) {
      await this.writeLine(`${tag} OK IDLE terminated`);
    }
  }

  async idleUntilAbort(): Promise<void> {
    await this.expectIdle();
    try {
      await this.expectDone();
    } catch {
      // peer closed the duplex
    }
  }

  async announceExists(count: number): Promise<void> {
    await this.writeLine(`* ${count} EXISTS`);
  }

  async expectFetchAndReply(text: string, uid = 17): Promise<void> {
    const line = await this.readLine();
    const match = /^(\S+) FETCH /i.exec(line);
    if (!match?.[1]) {
      throw new Error(`expected FETCH, got ${line}`);
    }
    const body = encoder.encode(text);
    await this.#writer.write(
      encoder.encode(
        `* 1 FETCH (UID ${uid} BODY[TEXT] {${body.byteLength}}\r\n`,
      ),
    );
    await this.#writer.write(body);
    await this.#writer.write(encoder.encode(`)\r\n${match[1]} OK FETCH completed\r\n`));
  }

  async expectAppend(): Promise<string> {
    const line = await this.readLine();
    const match = /^(\S+) APPEND /i.exec(line);
    const literal = /\{(\d+)\}\s*$/.exec(line);
    if (!match?.[1] || !literal?.[1]) {
      throw new Error(`expected APPEND literal, got ${line}`);
    }
    await this.writeLine("+ Ready for literal data");
    const data = await this.readExact(Number(literal[1]));
    await this.writeLine(`${match[1]} OK [APPENDUID 1 42] APPEND completed`);
    return decoder.decode(data);
  }

  async writeLine(line: string): Promise<void> {
    await this.#writer.write(encoder.encode(`${line}\r\n`));
  }

  async readLine(): Promise<string> {
    const bytes = await this.#readUntilCrlf();
    return decoder.decode(bytes);
  }

  async readExact(size: number): Promise<Uint8Array> {
    while (this.#buffer.byteLength < size) {
      const next = await this.#reader.read();
      if (next.done) {
        throw new Error("IMAP peer closed");
      }
      this.#buffer = concat(this.#buffer, next.value);
    }
    const data = this.#buffer.slice(0, size);
    this.#buffer = this.#buffer.slice(size);
    return data;
  }

  async #readUntilCrlf(): Promise<Uint8Array> {
    for (;;) {
      const index = indexOfCrlf(this.#buffer);
      if (index >= 0) {
        const line = this.#buffer.slice(0, index);
        this.#buffer = this.#buffer.slice(index + 2);
        return line;
      }
      const next = await this.#reader.read();
      if (next.done) {
        throw new Error("IMAP peer closed");
      }
      this.#buffer = concat(this.#buffer, next.value);
    }
  }
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const merged = new Uint8Array(left.byteLength + right.byteLength);
  merged.set(left, 0);
  merged.set(right, left.byteLength);
  return merged;
}

function indexOfCrlf(buffer: Uint8Array): number {
  for (let index = 0; index < buffer.byteLength - 1; index += 1) {
    if (buffer[index] === 13 && buffer[index + 1] === 10) {
      return index;
    }
  }
  return -1;
}

export function createBackgroundRuntime(): {
  spawn(task: (signal: AbortSignal) => void | Promise<void>): {
    dispose(): void;
  };
} {
  return {
    spawn(task) {
      const controller = new AbortController();
      void Promise.resolve()
        .then(() => task(controller.signal))
        .catch(() => undefined);
      return {
        dispose: () => {
          controller.abort(new Error("IMAP test task cancelled"));
        },
      };
    },
  };
}
