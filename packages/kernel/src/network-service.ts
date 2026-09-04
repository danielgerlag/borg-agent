export interface NetworkAuditRecord {
  readonly pluginId: string;
  readonly method: string;
  readonly origin: string;
  readonly status?: number;
  readonly failure?: string;
}

export interface NetworkServiceOptions {
  readonly fetch?: typeof fetch;
  readonly auditCapacity?: number;
}

const DEFAULT_AUDIT_CAPACITY = 256;

export class NetworkService {
  readonly #fetch: typeof fetch;
  readonly #auditCapacity: number;
  readonly #shutdown = new AbortController();
  readonly #owned = new Map<string, AbortController>();
  readonly #audit: NetworkAuditRecord[] = [];

  constructor(options: NetworkServiceOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    const auditCapacity = options.auditCapacity ?? DEFAULT_AUDIT_CAPACITY;
    if (!Number.isInteger(auditCapacity) || auditCapacity < 1) {
      throw new Error("Network audit capacity is invalid");
    }
    this.#auditCapacity = auditCapacity;
  }

  async fetch(
    pluginId: string,
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    if (this.#shutdown.signal.aborted) {
      throw new Error("Network service is shut down");
    }

    const request = input instanceof Request ? input : undefined;
    let url: URL;
    try {
      url =
        input instanceof URL
          ? new URL(input.href)
          : new URL(request?.url ?? String(input));
    } catch {
      throw new Error("Request URL is invalid");
    }

    const method = (
      init?.method ??
      request?.method ??
      "GET"
    ).toUpperCase();
    const origin = url.origin;

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      this.#record({
        pluginId,
        method,
        origin,
        failure: "unsupported-protocol",
      });
      throw new Error("Only http and https URLs are allowed");
    }

    if (url.username !== "" || url.password !== "") {
      this.#record({
        pluginId,
        method,
        origin,
        failure: "url-credentials",
      });
      throw new Error("Request URLs must not include credentials");
    }

    const requestSignal = init?.signal ?? request?.signal ?? undefined;
    const pluginController = this.#controllerFor(pluginId);
    const signal = AbortSignal.any([
      ...(requestSignal ? [requestSignal] : []),
      pluginController.signal,
      this.#shutdown.signal,
    ]);

    const fetchInit: RequestInit = {
      redirect: "error",
      signal,
      method,
    };
    const headers = init?.headers ?? request?.headers;
    if (headers !== undefined) {
      fetchInit.headers = headers;
    }
    const body = init?.body ?? (request && !request.bodyUsed ? request.body : undefined);
    if (body !== undefined) {
      fetchInit.body = body;
    }

    try {
      const response = await this.#fetch(url, fetchInit);
      this.#record({
        pluginId,
        method,
        origin,
        status: response.status,
      });
      return response;
    } catch (error) {
      this.#record({
        pluginId,
        method,
        origin,
        failure: signal.aborted ? "aborted" : "failed",
      });
      throw error;
    }
  }

  abortOwned(pluginId: string): void {
    const controller = this.#owned.get(pluginId);
    if (!controller) {
      return;
    }
    this.#owned.delete(pluginId);
    if (!controller.signal.aborted) {
      controller.abort(
        new Error(`Plugin ${pluginId} network requests were aborted`),
      );
    }
  }

  shutdown(): void {
    if (!this.#shutdown.signal.aborted) {
      this.#shutdown.abort(new Error("Network service is shutting down"));
    }
    for (const pluginId of [...this.#owned.keys()]) {
      this.abortOwned(pluginId);
    }
  }

  listAudit(): readonly NetworkAuditRecord[] {
    return this.#audit.map((record) => Object.freeze({ ...record }));
  }

  #controllerFor(pluginId: string): AbortController {
    const existing = this.#owned.get(pluginId);
    if (existing && !existing.signal.aborted) {
      return existing;
    }
    const controller = new AbortController();
    this.#owned.set(pluginId, controller);
    return controller;
  }

  #record(record: NetworkAuditRecord): void {
    this.#audit.push(Object.freeze(record));
    const overflow = this.#audit.length - this.#auditCapacity;
    if (overflow > 0) {
      this.#audit.splice(0, overflow);
    }
  }
}
