import { afterEach, describe, expect, it, vi } from "vitest";
import { NetworkService } from "../src";

describe("NetworkService", () => {
  const services: NetworkService[] = [];

  afterEach(() => {
    for (const service of services.splice(0)) {
      service.shutdown();
    }
  });

  function createService(
    fetchImpl: typeof fetch = vi.fn(async () => new Response("ok", { status: 200 })),
  ): { service: NetworkService; fetch: typeof fetch } {
    const service = new NetworkService({ fetch: fetchImpl });
    services.push(service);
    return { service, fetch: fetchImpl };
  }

  it("rejects file URLs and URL credentials without calling fetch", async () => {
    const { service, fetch } = createService();
    await expect(
      service.fetch("test.http", "file:///tmp/secret-path"),
    ).rejects.toThrow(/http and https/);
    await expect(
      service.fetch("test.http", "https://user:hunter2@example.com/secret"),
    ).rejects.toThrow(/credentials/);
    expect(fetch).not.toHaveBeenCalled();
    const audit = service.listAudit();
    expect(audit).toEqual([
      expect.objectContaining({
        pluginId: "test.http",
        method: "GET",
        origin: "null",
        failure: "unsupported-protocol",
      }),
      expect.objectContaining({
        pluginId: "test.http",
        method: "GET",
        origin: "https://example.com",
        failure: "url-credentials",
      }),
    ]);
    const serialized = JSON.stringify(audit);
    expect(serialized).not.toContain("secret-path");
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("user:");
  });

  it("forces redirect error and records origin-only audit data", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.redirect).toBe("error");
      return new Response(null, { status: 204 });
    });
    const { service } = createService(fetch);
    await service.fetch(
      "test.http",
      "https://example.com/secret/path?token=abc",
      {
        method: "POST",
        headers: { Authorization: "Bearer secret-token" },
        body: "super-secret-body",
        redirect: "follow",
      },
    );
    expect(fetch).toHaveBeenCalledOnce();
    const audit = service.listAudit();
    expect(audit).toEqual([
      {
        pluginId: "test.http",
        method: "POST",
        origin: "https://example.com",
        status: 204,
      },
    ]);
    const serialized = JSON.stringify(audit);
    expect(serialized).not.toContain("secret/path");
    expect(serialized).not.toContain("token=abc");
    expect(serialized).not.toContain("Bearer");
    expect(serialized).not.toContain("super-secret-body");
  });

  it("rejects redirects from the injected fetch", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.redirect === "error") {
        throw new TypeError("redirect");
      }
      return new Response("followed", { status: 200 });
    });
    const { service } = createService(fetch);
    await expect(
      service.fetch("test.http", "https://example.com/moved"),
    ).rejects.toThrow(/redirect/);
    expect(service.listAudit()).toEqual([
      expect.objectContaining({
        origin: "https://example.com",
        failure: "failed",
      }),
    ]);
  });

  it("combines request and shutdown signals", async () => {
    const request = new AbortController();
    let seen: AbortSignal | undefined;
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seen = init?.signal ?? undefined;
      await new Promise<void>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason ?? new Error("aborted")),
          { once: true },
        );
      });
      return new Response("ok");
    });
    const { service } = createService(fetch);
    const pending = service.fetch("test.http", "https://example.com/wait", {
      signal: request.signal,
    });
    await vi.waitFor(() => expect(seen).toBeInstanceOf(AbortSignal));
    request.abort(new Error("request cancelled"));
    await expect(pending).rejects.toThrow(/request cancelled/);
    expect(seen?.aborted).toBe(true);
    expect(service.listAudit()[0]).toMatchObject({ failure: "aborted" });
  });

  it("evicts the oldest audit records once capacity is reached", async () => {
    const fetch = vi.fn(async () => new Response("ok", { status: 200 }));
    const service = new NetworkService({ fetch, auditCapacity: 2 });
    services.push(service);
    await service.fetch("test.http", "https://one.example/path-one");
    await service.fetch("test.http", "https://two.example/path-two");
    await service.fetch("test.http", "https://three.example/path-three");
    const audit = service.listAudit();
    expect(audit).toHaveLength(2);
    expect(audit).toEqual([
      {
        pluginId: "test.http",
        method: "GET",
        origin: "https://two.example",
        status: 200,
      },
      {
        pluginId: "test.http",
        method: "GET",
        origin: "https://three.example",
        status: 200,
      },
    ]);
    expect(Object.isFrozen(audit[0])).toBe(true);
    expect(JSON.stringify(audit)).not.toContain("path-");
    expect(() => {
      new NetworkService({ auditCapacity: 0 });
    }).toThrow(/audit capacity is invalid/);
  });

  it("scopes abortOwned to one plugin", async () => {
    const signals = new Map<string, AbortSignal>();
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const pluginId = url.includes("first") ? "test.first" : "test.second";
      signals.set(pluginId, init?.signal ?? new AbortController().signal);
      await new Promise<void>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason ?? new Error("aborted")),
          { once: true },
        );
      });
      return new Response("ok");
    });
    const { service } = createService(fetch);
    const first = service.fetch("test.first", "https://example.com/first");
    const second = service.fetch("test.second", "https://example.com/second");
    await vi.waitFor(() => expect(signals.size).toBe(2));
    service.abortOwned("test.first");
    await expect(first).rejects.toThrow(/test\.first/);
    expect(signals.get("test.first")?.aborted).toBe(true);
    expect(signals.get("test.second")?.aborted).toBe(false);
    service.abortOwned("test.second");
    await expect(second).rejects.toThrow(/test\.second/);
  });
});
