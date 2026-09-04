import {
  INTERNAL_ERROR,
  asJsonRpcMessage,
  type JsonRpcId,
  type JsonRpcMessage,
  type McpTransport,
  McpProtocolError,
} from "./protocol";
import { safeErrorMessage } from "./redact";

interface PendingCall {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  readonly onAbort: () => void;
  readonly signal?: AbortSignal | undefined;
}

export interface JsonRpcRequestOptions {
  readonly signal?: AbortSignal | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly decorate?: ((message: JsonRpcMessage) => JsonRpcMessage) | undefined;
}

export class JsonRpcPeer {
  readonly #transport: McpTransport;
  readonly #pending = new Map<string, PendingCall>();
  readonly #unsubscribe: () => void;
  readonly #unsubscribeClose: () => void;
  #nextId = 1;
  #closed = false;

  constructor(transport: McpTransport) {
    this.#transport = transport;
    this.#unsubscribe = transport.subscribe((message) => {
      this.#receive(message);
    });
    this.#unsubscribeClose =
      transport.onClose?.(() => {
        void this.close().catch(() => undefined);
      }) ?? (() => undefined);
  }

  async request(
    method: string,
    params?: unknown,
    options: JsonRpcRequestOptions = {},
  ): Promise<unknown> {
    if (this.#closed) {
      throw new McpProtocolError(INTERNAL_ERROR, "MCP transport is closed");
    }
    if (options.signal?.aborted) {
      throw abortError(options.signal);
    }
    const id = this.#nextId;
    this.#nextId += 1;
    const key = stringifyId(id);
    const request: JsonRpcMessage = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    };
    const wire = options.decorate ? options.decorate(request) : request;
    const cancellation: JsonRpcMessage = {
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: id },
    };
    const cancellationWire = options.decorate
      ? options.decorate(cancellation)
      : cancellation;
    return new Promise<unknown>((resolve, reject) => {
      const onAbort = (): void => {
        if (!this.#pending.has(key)) {
          return;
        }
        this.#pending.delete(key);
        void this.#transport
          .send(cancellationWire, {
            ...(options.headers ? { headers: options.headers } : {}),
          })
          .catch(() => undefined);
        reject(abortError(options.signal));
      };
      this.#pending.set(key, {
        resolve,
        reject,
        onAbort,
        signal: options.signal,
      });
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted) {
        onAbort();
        return;
      }
      void this.#transport
        .send(wire, {
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.headers ? { headers: options.headers } : {}),
        })
        .catch((error: unknown) => {
          const pending = this.#pending.get(key);
          if (!pending) {
            return;
          }
          this.#pending.delete(key);
          pending.signal?.removeEventListener("abort", pending.onAbort);
          pending.reject(
            error instanceof McpProtocolError
              ? error
              : new McpProtocolError(
                  INTERNAL_ERROR,
                  safeErrorMessage(error),
                ),
          );
        });
    });
  }

  async notify(
    method: string,
    params?: unknown,
    options: JsonRpcRequestOptions = {},
  ): Promise<void> {
    if (this.#closed) {
      throw new McpProtocolError(INTERNAL_ERROR, "MCP transport is closed");
    }
    if (options.signal?.aborted) {
      throw abortError(options.signal);
    }
    const notification: JsonRpcMessage = {
      jsonrpc: "2.0",
      method,
      ...(params !== undefined ? { params } : {}),
    };
    const wire = options.decorate ? options.decorate(notification) : notification;
    await this.#transport.send(wire, {
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.headers ? { headers: options.headers } : {}),
    });
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#unsubscribe();
    this.#unsubscribeClose();
    const error = new McpProtocolError(INTERNAL_ERROR, "MCP transport is closed");
    for (const [key, pending] of this.#pending) {
      this.#pending.delete(key);
      pending.signal?.removeEventListener("abort", pending.onAbort);
      pending.reject(error);
    }
    await this.#transport.close();
  }

  #receive(message: JsonRpcMessage): void {
    const parsed = asJsonRpcMessage(message);
    if (!parsed || !("id" in parsed) || !("result" in parsed || "error" in parsed)) {
      return;
    }
    const key = stringifyId(parsed.id);
    const pending = this.#pending.get(key);
    if (!pending) {
      return;
    }
    this.#pending.delete(key);
    pending.signal?.removeEventListener("abort", pending.onAbort);
    if ("error" in parsed) {
      pending.reject(
        new McpProtocolError(
          parsed.error.code,
          safeErrorMessage(new Error(parsed.error.message)),
        ),
      );
      return;
    }
    pending.resolve(parsed.result);
  }
}

function stringifyId(id: JsonRpcId): string {
  return `${typeof id}:${String(id)}`;
}

function abortError(signal: AbortSignal | undefined): Error {
  if (signal?.reason instanceof Error) {
    return signal.reason;
  }
  return new McpProtocolError(INTERNAL_ERROR, "MCP request was aborted");
}
