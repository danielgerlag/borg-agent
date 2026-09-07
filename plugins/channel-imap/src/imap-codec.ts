import type {
  ChannelInboundDraft,
  PluginTlsSocket,
} from "@borg/plugin-sdk";

const CRLF = "\r\n";
const MAX_LITERAL_BYTES = 1_048_576;
const POLL_MS = 15_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class ImapError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ImapError";
  }
}

interface ImapLine {
  readonly raw: string;
  readonly literals: readonly Uint8Array[];
  readonly ok?: boolean | undefined;
  readonly tag?: string | undefined;
}

interface FetchPart {
  readonly seq: number;
  readonly uid: string | undefined;
  readonly text: string;
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const merged = new Uint8Array(left.byteLength + right.byteLength);
  merged.set(left, 0);
  merged.set(right, left.byteLength);
  return merged;
}

function streamBytes(value: Uint8Array): Uint8Array {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy;
}

function indexOfCrlf(buffer: Uint8Array): number {
  for (let index = 0; index < buffer.byteLength - 1; index += 1) {
    if (buffer[index] === 13 && buffer[index + 1] === 10) {
      return index;
    }
  }
  return -1;
}

function quoteString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function quoteMailbox(mailbox: string): string {
  return /^[A-Za-z0-9]+$/.test(mailbox) ? mailbox : quoteString(mailbox);
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new ImapError("IMAP operation was aborted");
}

async function withAbort<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    throw abortError(signal);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    throw abortError(signal);
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function parseTagged(line: ImapLine): ImapLine {
  const match = /^(\S+) (OK|NO|BAD)\b/i.exec(line.raw);
  if (!match || !match[1] || !match[2]) {
    return line;
  }
  return {
    ...line,
    tag: match[1],
    ok: match[2].toUpperCase() === "OK",
  };
}

function extractFetchText(line: ImapLine): string {
  const last = line.literals.at(-1);
  if (last) {
    return decoder.decode(last);
  }
  const quoted =
    /(?:BODY\[TEXT\]|RFC822\.TEXT)\s+"((?:\\.|[^"\\])*)"/i.exec(line.raw);
  if (quoted?.[1] !== undefined) {
    return quoted[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return "";
}

function extractFetchUid(line: ImapLine): string | undefined {
  const match = /\bUID (\d+)\b/i.exec(line.raw);
  return match?.[1];
}

function rfc822Date(date: Date): string {
  return date.toUTCString().replace("GMT", "+0000");
}

function buildMessage(mailbox: string, text: string): Uint8Array {
  const body = text.endsWith("\n") ? text : `${text}\n`;
  const message = [
    `To: ${mailbox}`,
    "Subject: Borg",
    `Date: ${rfc822Date(new Date())}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    body,
  ].join(CRLF);
  return encoder.encode(message);
}

export class ImapCodec {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #writer: WritableStreamDefaultWriter<Uint8Array>;
  readonly #pending = new Map<
    string,
    { resolve(line: ImapLine): void; reject(error: Error): void }
  >();
  readonly #park = new Set<() => void>();
  #buffer: Uint8Array = new Uint8Array(0);
  #tagSeq = 0;
  #loop: Promise<void> | undefined;
  #continuation:
    | { resolve(line: ImapLine): void; reject(error: Error): void }
    | undefined;
  #greeting: ((line: ImapLine) => void) | undefined;
  #greetingLine: Promise<ImapLine>;
  #exists = 0;
  #fetchedUpTo = 0;
  #idling = false;
  #idleWait: Promise<ImapLine> | undefined;
  #fetchParts: FetchPart[] = [];
  #closed = false;
  #mailbox = "INBOX";
  #mutex: Promise<void> = Promise.resolve();

  constructor(socket: PluginTlsSocket) {
    this.#reader = socket.readable.getReader();
    this.#writer = socket.writable.getWriter();
    this.#greetingLine = new Promise<ImapLine>((resolve) => {
      this.#greeting = resolve;
    });
  }

  async readGreeting(signal: AbortSignal): Promise<string> {
    this.#startLoop();
    const line = await withAbort(this.#greetingLine, signal);
    if (!/^\* (OK|PREAUTH)\b/i.test(line.raw)) {
      throw new ImapError("IMAP greeting was rejected");
    }
    return line.raw;
  }

  async login(
    username: string,
    password: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (/[\r\n\0]/.test(username) || /[\r\n\0]/.test(password)) {
      throw new ImapError("IMAP credentials contain invalid characters");
    }
    await this.#command(
      `LOGIN ${quoteString(username)} ${quoteString(password)}`,
      "LOGIN",
      signal,
    );
  }

  async select(mailbox: string, signal?: AbortSignal): Promise<void> {
    this.#mailbox = mailbox;
    await this.#command(`SELECT ${quoteMailbox(mailbox)}`, "SELECT", signal);
    this.#fetchedUpTo = this.#exists;
  }

  async idleAndFetch(
    ingest: (draft: ChannelInboundDraft) => void | Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    this.#startLoop();
    while (!signal.aborted) {
      const started = await this.#runExclusive(() => this.#beginIdle(signal));
      if (!started) {
        await this.#runExclusive(() => this.#checkAndFetch(ingest, signal));
        await sleep(POLL_MS, signal);
        continue;
      }
      await this.#parkUntilIdleShouldEnd(signal);
      await this.#runExclusive(async () => {
        if (this.#idling) {
          await this.#endIdle();
        }
        await this.#fetchNew(ingest, signal);
      });
    }
  }

  async append(
    mailbox: string,
    text: string,
    signal?: AbortSignal,
  ): Promise<{ readonly externalId: string; readonly sentAt: string }> {
    this.#wakePark();
    return this.#runExclusive(async () => {
      if (this.#idling) {
        await this.#endIdle();
      }
      return this.#appendNow(mailbox, text, signal);
    });
  }

  #startLoop(): void {
    this.#loop ??= this.#readLoop().catch((error: unknown) => {
      this.#closed = true;
      this.#failWaiters(
        error instanceof Error ? error : new ImapError("IMAP connection closed"),
      );
    });
  }

  async #readLoop(): Promise<void> {
    for (;;) {
      const line = parseTagged(await this.#readLogicalLine());
      if (line.raw.startsWith("+")) {
        const waiter = this.#continuation;
        this.#continuation = undefined;
        waiter?.resolve(line);
        continue;
      }
      if (line.raw.startsWith("*")) {
        this.#handleUntagged(line);
        continue;
      }
      if (line.tag) {
        const waiter = this.#pending.get(line.tag);
        if (waiter) {
          this.#pending.delete(line.tag);
          waiter.resolve(line);
        }
      }
    }
  }

  #handleUntagged(line: ImapLine): void {
    if (this.#greeting) {
      const resolve = this.#greeting;
      this.#greeting = undefined;
      resolve(line);
      if (/^\* BYE\b/i.test(line.raw)) {
        throw new ImapError("IMAP connection closed");
      }
      return;
    }
    const exists = /^\* (\d+) EXISTS\b/i.exec(line.raw);
    if (exists?.[1]) {
      this.#exists = Number(exists[1]);
      this.#wakePark();
      return;
    }
    const fetch = /^\* (\d+) FETCH\b/i.exec(line.raw);
    if (fetch?.[1]) {
      this.#fetchParts.push({
        seq: Number(fetch[1]),
        uid: extractFetchUid(line),
        text: extractFetchText(line),
      });
    }
    if (/^\* BYE\b/i.test(line.raw)) {
      throw new ImapError("IMAP connection closed");
    }
  }

  async #readLogicalLine(): Promise<ImapLine> {
    const literals: Uint8Array[] = [];
    let raw = "";
    for (;;) {
      const lineBytes = await this.#readUntilCrlf();
      const line = decoder.decode(lineBytes);
      raw = raw.length === 0 ? line : `${raw}\n${line}`;
      const literal = /\{(\d+)\}\s*$/.exec(line);
      if (!literal?.[1]) {
        return { raw, literals };
      }
      const size = Number(literal[1]);
      if (!Number.isInteger(size) || size < 0 || size > MAX_LITERAL_BYTES) {
        throw new ImapError("IMAP literal is invalid");
      }
      literals.push(await this.#readExact(size));
    }
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
        throw new ImapError("IMAP connection closed");
      }
      this.#buffer = concat(this.#buffer, streamBytes(next.value));
    }
  }

  async #readExact(size: number): Promise<Uint8Array> {
    while (this.#buffer.byteLength < size) {
      const next = await this.#reader.read();
      if (next.done) {
        throw new ImapError("IMAP connection closed");
      }
      this.#buffer = concat(this.#buffer, streamBytes(next.value));
    }
    const data = this.#buffer.slice(0, size);
    this.#buffer = this.#buffer.slice(size);
    return data;
  }

  async #command(
    payload: string,
    verb: string,
    signal?: AbortSignal,
  ): Promise<ImapLine> {
    this.#startLoop();
    const tag = this.#nextTag();
    const wait = this.#waitTagged(tag);
    await this.#writeText(`${tag} ${payload}${CRLF}`);
    const result = await withAbort(wait, signal);
    if (!result.ok) {
      throw new ImapError(`IMAP ${verb} was rejected`);
    }
    return result;
  }

  async #beginIdle(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) {
      throw abortError(signal);
    }
    const tag = this.#nextTag();
    const tagged = this.#waitTagged(tag);
    const continuation = this.#waitContinuation();
    await this.#writeText(`${tag} IDLE${CRLF}`);
    const first = await withAbort(
      Promise.race([
        tagged.then((line) => ({ kind: "tagged" as const, line })),
        continuation.then((line) => ({ kind: "plus" as const, line })),
      ]),
      signal,
    );
    if (first.kind === "tagged") {
      return false;
    }
    this.#idling = true;
    this.#idleWait = tagged;
    return true;
  }

  async #endIdle(): Promise<void> {
    if (!this.#idling) {
      return;
    }
    const wait = this.#idleWait;
    this.#idling = false;
    this.#idleWait = undefined;
    // DONE is untagged; sending it is the only legal way to leave IDLE.
    await this.#writeText(`DONE${CRLF}`);
    if (wait) {
      await wait;
    }
    this.#wakePark();
  }

  async #checkAndFetch(
    ingest: (draft: ChannelInboundDraft) => void | Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    await this.#command("CHECK", "CHECK", signal);
    await this.#fetchNew(ingest, signal);
  }

  async #fetchNew(
    ingest: (draft: ChannelInboundDraft) => void | Promise<void>,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.#exists <= this.#fetchedUpTo) {
      return;
    }
    const from = this.#fetchedUpTo + 1;
    const to = this.#exists;
    this.#fetchParts = [];
    await this.#command(
      `FETCH ${from}:${to} (UID BODY.PEEK[TEXT])`,
      "FETCH",
      signal,
    );
    for (const part of this.#fetchParts) {
      const draft: ChannelInboundDraft = {
        text: part.text,
        destinationId: this.#mailbox,
        externalId: part.uid ? `imap:${part.uid}` : `imap-seq:${part.seq}`,
        receivedAt: new Date().toISOString(),
      };
      try {
        await ingest(draft);
      } catch {
        // A single draft must not tear down the mailbox session.
      }
    }
    this.#fetchedUpTo = to;
    this.#fetchParts = [];
  }

  async #appendNow(
    mailbox: string,
    text: string,
    signal?: AbortSignal,
  ): Promise<{ readonly externalId: string; readonly sentAt: string }> {
    this.#startLoop();
    const body = buildMessage(mailbox, text);
    const tag = this.#nextTag();
    const wait = this.#waitTagged(tag);
    const continuation = this.#waitContinuation();
    await this.#writeText(
      `${tag} APPEND ${quoteMailbox(mailbox)} {${body.byteLength}}${CRLF}`,
    );
    await withAbort(continuation, signal);
    await this.#writeBytes(body);
    const result = await withAbort(wait, signal);
    if (!result.ok) {
      throw new ImapError("IMAP APPEND was rejected");
    }
    const sentAt = new Date().toISOString();
    const uid = /\[APPENDUID \d+ (\d+)\]/i.exec(result.raw)?.[1];
    return {
      externalId: uid ? `imap:${uid}` : `imap-out:${sentAt}`,
      sentAt,
    };
  }

  #parkUntilIdleShouldEnd(signal: AbortSignal): Promise<void> {
    if (signal.aborted || this.#exists > this.#fetchedUpTo || !this.#idling) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const done = (): void => {
        signal.removeEventListener("abort", done);
        this.#park.delete(done);
        resolve();
      };
      this.#park.add(done);
      signal.addEventListener("abort", done, { once: true });
    });
  }

  #wakePark(): void {
    for (const resolve of [...this.#park]) {
      resolve();
    }
    this.#park.clear();
  }

  #nextTag(): string {
    this.#tagSeq += 1;
    return `A${String(this.#tagSeq).padStart(4, "0")}`;
  }

  #waitTagged(tag: string): Promise<ImapLine> {
    return new Promise<ImapLine>((resolve, reject) => {
      this.#pending.set(tag, { resolve, reject });
      if (this.#closed) {
        this.#pending.delete(tag);
        reject(new ImapError("IMAP connection closed"));
      }
    });
  }

  #waitContinuation(): Promise<ImapLine> {
    return new Promise<ImapLine>((resolve, reject) => {
      this.#continuation = { resolve, reject };
      if (this.#closed) {
        this.#continuation = undefined;
        reject(new ImapError("IMAP connection closed"));
      }
    });
  }

  #failWaiters(error: Error): void {
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    const continuation = this.#continuation;
    this.#continuation = undefined;
    const greeting = this.#greeting;
    this.#greeting = undefined;
    this.#wakePark();
    for (const waiter of pending) {
      waiter.reject(error);
    }
    continuation?.reject(error);
    if (greeting) {
      greeting({ raw: "* BYE closed", literals: [] });
    }
  }

  async #writeText(text: string): Promise<void> {
    await this.#writeBytes(encoder.encode(text));
  }

  async #writeBytes(bytes: Uint8Array): Promise<void> {
    await this.#writer.write(bytes);
  }

  #runExclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#mutex.then(work, work);
    this.#mutex = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
