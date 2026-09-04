import { channelInboundMessage, type BusEnvelope } from "@borg/contracts";
import type {
  ChannelAdapter,
  ChannelAdapterReceipt,
  ChannelInboundDraft,
  ChannelSendRequest,
  ConfigStoreProvider,
  DataClassification,
  JsonValue,
  StoreEntry,
  StoreTransactionOperation,
} from "@borg/plugin-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CommandEventBus,
  InteractionService,
  PersistenceRegistry,
  StoreFacade,
} from "../src";
import { ClassificationService } from "../src/classification-service";
import { ScannerRegistry } from "../src/scanner-registry";
import { TrustAuthorizer } from "../src/trust-authorizer";
import {
  CommunicationService,
  type CommunicationClassificationService,
  type CommunicationScannerRegistry,
  type CommunicationServiceOptions,
  type CommunicationTrustAuthorizer,
} from "../src/communication-service";
import type {
  PromptScanReport,
  PromptScanRequest,
} from "../src/scanner-registry";
import type {
  AuthorizationRequest,
  AuthorizationResult,
} from "../src/trust-authorizer";

class MemoryConfigStore implements ConfigStoreProvider {
  readonly entries = new Map<string, JsonValue>();
  failWrites = false;
  failReads = false;
  failWriteAt: number | undefined;
  writeCount = 0;

  async readConfig(): Promise<unknown | undefined> {
    return undefined;
  }

  async writeConfig(): Promise<void> {}

  async getStore(namespace: string, key: string): Promise<JsonValue | undefined> {
    if (this.failReads) {
      throw new Error("store read failed");
    }
    return this.entries.get(`${namespace}\u0000${key}`);
  }

  async listStore(
    namespace: string,
    prefix: string,
  ): Promise<readonly StoreEntry[]> {
    if (this.failReads) {
      throw new Error("store list failed");
    }
    const scope = `${namespace}\u0000`;
    return [...this.entries]
      .filter(
        ([key]) => key.startsWith(scope) && key.slice(scope.length).startsWith(prefix),
      )
      .map(([key, value]) => ({ key: key.slice(scope.length), value }));
  }

  async applyStoreTransaction(
    namespace: string,
    operations: readonly StoreTransactionOperation[],
  ): Promise<void> {
    this.writeCount += 1;
    if (this.failWrites || this.writeCount === this.failWriteAt) {
      throw new Error("store write failed");
    }
    for (const operation of operations) {
      const key = `${namespace}\u0000${operation.key}`;
      if (operation.type === "set") {
        this.entries.set(key, operation.value);
      } else {
        this.entries.delete(key);
      }
    }
  }
}

interface Fixture {
  readonly service: CommunicationService;
  readonly bus: CommandEventBus;
  readonly provider: MemoryConfigStore;
  readonly store: StoreFacade;
  readonly classification: CommunicationClassificationService & {
    readonly raised: {
      readonly runId: string;
      readonly level: DataClassification;
    }[];
    level: DataClassification;
    readonly openRuns: Set<string>;
  };
  readonly scanners: CommunicationScannerRegistry & {
    readonly requests: PromptScanRequest[];
    report: PromptScanReport;
    failure?: Error | undefined;
  };
  readonly trust: CommunicationTrustAuthorizer & {
    readonly requests: AuthorizationRequest[];
    result: AuthorizationResult;
  };
  readonly events: {
    readonly payload: unknown;
    readonly envelope: BusEnvelope;
  }[];
}

const services: CommunicationService[] = [];

function cleanReport(
  overrides: Partial<PromptScanReport> = {},
): PromptScanReport {
  return {
    stage: "inbound_message",
    findings: [],
    failures: [],
    coverage: "complete",
    truncated: false,
    unavailableAction: "review",
    ...overrides,
  };
}

function createFixture(
  options: CommunicationServiceOptions = {},
  provider = new MemoryConfigStore(),
): Fixture {
  const registry = new PersistenceRegistry();
  registry.registerConfigStore("test.store", provider);
  const store = new StoreFacade(registry);
  const bus = new CommandEventBus();
  const events: Fixture["events"] = [];
  bus.onById("test.listener", channelInboundMessage.id, (payload, envelope) => {
    events.push({ payload, envelope });
  });

  const classification = {
    level: "internal" as DataClassification,
    raised: [] as {
      readonly runId: string;
      readonly level: DataClassification;
    }[],
    openRuns: new Set<string>(),
    snapshot(runId?: string) {
      void runId;
      return { level: classification.level, version: 1 };
    },
    isOpen(runId: string) {
      return classification.openRuns.has(runId);
    },
    raise(runId: string, level: DataClassification) {
      classification.raised.push({ runId, level });
      classification.level = level;
      return undefined;
    },
  };

  const scanners = {
    requests: [] as PromptScanRequest[],
    report: cleanReport(),
    failure: undefined as Error | undefined,
    async scan(request: PromptScanRequest): Promise<PromptScanReport> {
      scanners.requests.push(request);
      if (scanners.failure) {
        throw scanners.failure;
      }
      return { ...scanners.report, stage: request.stage };
    },
  };

  const trust = {
    requests: [] as AuthorizationRequest[],
    result: {
      allowed: true,
      interactionUsed: false,
      reasons: [],
    } as AuthorizationResult,
    async authorize(request: AuthorizationRequest): Promise<AuthorizationResult> {
      trust.requests.push(request);
      return trust.result;
    },
  };

  const service = new CommunicationService(
    bus,
    store,
    classification,
    scanners,
    trust,
    options,
  );
  services.push(service);
  return {
    service,
    bus,
    provider,
    store,
    classification,
    scanners,
    trust,
    events,
  };
}

interface AdapterHarness {
  readonly adapter: ChannelAdapter;
  readonly state: {
    ingest?: ((draft: ChannelInboundDraft) => void | Promise<void>) | undefined;
    signal?: AbortSignal | undefined;
    scopeKeys: readonly string[];
    disposed: number;
    readonly sends: ChannelSendRequest[];
  };
}

function createAdapter(
  options: {
    readonly id?: string;
    readonly capacity?: ChannelAdapter["capacity"];
    readonly destinations?: readonly string[];
    readonly send?: (
      request: ChannelSendRequest,
      attempt: number,
    ) => ChannelAdapterReceipt | Promise<ChannelAdapterReceipt>;
  } = {},
): AdapterHarness {
  const state: AdapterHarness["state"] = {
    scopeKeys: [],
    disposed: 0,
    sends: [],
  };
  const adapter: ChannelAdapter = {
    id: options.id ?? "test.channel",
    capacity: options.capacity ?? "internal",
    destinations: options.destinations ?? ["room-1"],
    start: (scope) => {
      state.scopeKeys = Object.keys(scope);
      state.ingest = scope.ingest;
      state.signal = scope.signal;
      return {
        dispose: () => {
          state.disposed += 1;
        },
      };
    },
    send: async (request) => {
      state.sends.push(request);
      const attempt = state.sends.length;
      return options.send
        ? options.send(request, attempt)
        : {
            externalId: `remote-${attempt}`,
            sentAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
          };
    },
  };
  return { adapter, state };
}

function draftOf(
  overrides: Partial<ChannelInboundDraft> = {},
): ChannelInboundDraft {
  return {
    text: "hello from the outside",
    destinationId: "room-1",
    externalId: "external-1",
    ...overrides,
  };
}

function sendRequest(
  overrides: Partial<ChannelSendRequest> = {},
): ChannelSendRequest {
  return {
    adapterId: "test.channel",
    destinationId: "room-1",
    text: "outbound body",
    idempotencyKey: "key-1",
    ...overrides,
  };
}

describe("CommunicationService registration", () => {
  afterEach(() => {
    for (const service of services.splice(0)) {
      service.shutdown();
    }
  });

  it("rejects adapters that are not namespaced, bounded, or unique", () => {
    const { service } = createFixture();
    expect(() =>
      service.register("test.channel", createAdapter({ id: "channel" }).adapter),
    ).toThrow(/namespaced identifier/);
    expect(() =>
      service.register("other.plugin", createAdapter().adapter),
    ).toThrow(/outside namespace/);
    expect(() =>
      service.register("test.channel", {
        ...createAdapter().adapter,
        capacity: "everywhere" as ChannelAdapter["capacity"],
      }),
    ).toThrow(/unknown capacity/);
    expect(() =>
      service.register(
        "test.channel",
        createAdapter({ destinations: ["room-1", "room-1"] }).adapter,
      ),
    ).toThrow(/duplicate destinations/);
    expect(() =>
      service.register("test.channel", createAdapter({ destinations: [] }).adapter),
    ).toThrow(/invalid destination list/);
    expect(() =>
      service.register(
        "test.channel",
        createAdapter({
          destinations: Array.from({ length: 65 }, (_value, index) => `room-${index}`),
        }).adapter,
      ),
    ).toThrow(/invalid destination list/);

    service.register("test.channel", createAdapter().adapter);
    expect(() =>
      service.register("test.channel", createAdapter().adapter),
    ).toThrow(/already registered/);
    expect(service.listAdapters()).toEqual([
      {
        pluginId: "test.channel",
        adapterId: "test.channel",
        capacity: "internal",
        destinations: ["room-1"],
      },
    ]);
  });

  it("hands the adapter only an ingest callback and an abort signal", async () => {
    const { service } = createFixture();
    const { adapter, state } = createAdapter();
    const registration = service.register("test.channel", adapter);
    expect(state.scopeKeys).toEqual(["ingest", "signal"]);
    expect(state.signal?.aborted).toBe(false);

    await registration.dispose();
    expect(state.signal?.aborted).toBe(true);
    expect(state.disposed).toBe(1);
  });

  it("aborts and disposes adapters when a plugin is deactivated", async () => {
    const { service } = createFixture();
    const { adapter, state } = createAdapter();
    service.register("test.channel", adapter);
    service.removePlugin("test.channel");
    await vi.waitFor(() => expect(state.disposed).toBe(1));
    expect(state.signal?.aborted).toBe(true);
    expect(service.listAdapters()).toEqual([]);
  });
});

describe("CommunicationService inbound", () => {
  afterEach(() => {
    for (const service of services.splice(0)) {
      service.shutdown();
    }
  });

  it("emits one kernel-sourced event per message and replays only once", async () => {
    const fixture = createFixture();
    const { adapter, state } = createAdapter();
    fixture.service.register("test.channel", adapter);
    await state.ingest?.(draftOf({ metadata: { threadId: "t-1" } }));
    await state.ingest?.(draftOf({ metadata: { threadId: "t-1" } }));

    expect(fixture.events).toHaveLength(1);
    const [event] = fixture.events;
    expect(event?.envelope.source).toEqual({ kind: "kernel", id: "kernel" });
    expect(event?.payload).toMatchObject({
      channelId: "test.channel:room-1",
      text: "hello from the outside",
      adapterId: "test.channel",
      destinationId: "room-1",
      externalId: "external-1",
      classification: "internal",
      metadata: { threadId: "t-1" },
    });
    const emitted = event?.payload as { readonly id: string };
    expect(emitted.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(fixture.scanners.requests).toHaveLength(1);
    expect(fixture.scanners.requests[0]).toMatchObject({
      stage: "inbound_message",
      source: { kind: "channel", id: "test.channel" },
    });

    const restarted = createFixture({}, fixture.provider);
    const second = createAdapter();
    restarted.service.register("test.channel", second.adapter);
    await second.state.ingest?.(draftOf({ metadata: { threadId: "t-1" } }));
    expect(restarted.events).toHaveLength(0);
    expect(
      restarted.service
        .listAudit()
        .filter((record) => record.outcome === "duplicate"),
    ).toHaveLength(1);
  });

  it("derives the identity from adapter, destination, and external id", async () => {
    const fixture = createFixture();
    const { adapter, state } = createAdapter({
      destinations: ["room-1", "room-2"],
    });
    fixture.service.register("test.channel", adapter);
    await state.ingest?.(draftOf());
    await state.ingest?.(draftOf({ destinationId: "room-2" }));
    await state.ingest?.(draftOf({ externalId: "external-2" }));

    const ids = fixture.events.map(
      ({ payload }) => (payload as { readonly id: string }).id,
    );
    expect(new Set(ids).size).toBe(3);
  });

  it("persists and drops scanner-blocked inbound without leaking evidence", async () => {
    const fixture = createFixture();
    fixture.scanners.report = cleanReport({
      findings: [
        {
          scannerId: "test.scanner",
          code: "prompt.injection",
          action: "block",
          reason: "instruction override",
          evidence: "ignore-previous-instructions",
        },
      ],
    });
    fixture.trust.result = {
      allowed: false,
      interactionUsed: false,
      reasons: ["scanner blocked"],
    };
    const { adapter, state } = createAdapter();
    fixture.service.register("test.channel", adapter);
    await state.ingest?.(draftOf({ text: "secret body text" }));

    expect(fixture.events).toHaveLength(0);
    expect(fixture.trust.requests[0]).toMatchObject({
      feature: "channel_inbound",
      payloadClassification: "restricted",
    });
    expect(fixture.service.listAudit()[0]).toMatchObject({
      outcome: "scan-blocked",
      classification: "restricted",
    });
    const audit = JSON.stringify(fixture.service.listAudit());
    expect(audit).toContain("prompt.injection");
    expect(audit).not.toContain("ignore-previous-instructions");
    expect(audit).not.toContain("secret body text");
  });

  it("treats scanner failures and degraded coverage as an escalation", async () => {
    const fixture = createFixture();
    fixture.scanners.failure = new Error("scanner exploded");
    const { adapter, state } = createAdapter();
    fixture.service.register("test.channel", adapter);
    await state.ingest?.(draftOf());

    expect(fixture.trust.requests[0]?.scanReport).toMatchObject({
      coverage: "none",
      unavailableAction: "review",
      failures: [{ kind: "error", message: "Prompt scanning failed" }],
    });
    expect(fixture.events[0]?.payload).toMatchObject({
      classification: "restricted",
    });
    expect(fixture.service.listAudit()[0]).toMatchObject({
      outcome: "emitted",
      scan: "failed",
    });

    fixture.scanners.failure = undefined;
    fixture.scanners.report = cleanReport({ coverage: "none" });
    await state.ingest?.(draftOf({ externalId: "external-2" }));
    expect(fixture.events[1]?.payload).toMatchObject({
      classification: "restricted",
    });
    expect(fixture.service.listAudit()[1]).toMatchObject({
      outcome: "emitted",
      scan: "review",
    });
  });

  it("persists a denied review so replay cannot bypass the decision", async () => {
    const fixture = createFixture();
    fixture.scanners.report = cleanReport({
      findings: [
        {
          scannerId: "test.scanner",
          code: "prompt.review",
          action: "review",
          reason: "review inbound",
        },
      ],
    });
    fixture.trust.result = {
      allowed: false,
      interactionUsed: true,
      reasons: ["review denied"],
    };
    const { adapter, state } = createAdapter();
    fixture.service.register("test.channel", adapter);

    await state.ingest?.(draftOf());
    await state.ingest?.(draftOf());

    expect(fixture.events).toHaveLength(0);
    expect(fixture.trust.requests).toHaveLength(1);
    expect(fixture.service.listAudit()).toEqual([
      expect.objectContaining({ outcome: "denied", interactionUsed: true }),
      expect.objectContaining({ outcome: "duplicate" }),
    ]);
  });

  it("emits nothing when the dedup record cannot be persisted", async () => {
    const fixture = createFixture();
    const { adapter, state } = createAdapter();
    fixture.service.register("test.channel", adapter);
    fixture.provider.failWrites = true;

    await expect(state.ingest?.(draftOf())).rejects.toThrow(/could not be recorded/);
    expect(fixture.events).toHaveLength(0);
    expect(fixture.service.listAudit()).toEqual([
      expect.objectContaining({ outcome: "persist-failed" }),
    ]);

    fixture.provider.failWrites = false;
    await state.ingest?.(draftOf());
    expect(fixture.events).toHaveLength(1);
  });

  it("rejects drafts that exceed inbound bounds", async () => {
    const fixture = createFixture();
    const { adapter, state } = createAdapter();
    fixture.service.register("test.channel", adapter);

    await expect(
      state.ingest?.(draftOf({ text: "x".repeat(65_537) })),
    ).rejects.toThrow(/text is invalid/);
    await expect(
      state.ingest?.(draftOf({ destinationId: "room-9" })),
    ).rejects.toThrow(/not registered/);
    await expect(state.ingest?.(draftOf({ externalId: "" }))).rejects.toThrow(
      /external id is invalid/,
    );
    await expect(
      state.ingest?.(
        draftOf({
          attachments: Array.from({ length: 17 }, (_value, index) => ({
            id: `a-${index}`,
            name: `file-${index}`,
            mimeType: "text/plain",
          })),
        }),
      ),
    ).rejects.toThrow(/attachments are invalid/);
    await expect(
      state.ingest?.(
        draftOf({ metadata: { blob: "x".repeat(9_000) } }),
      ),
    ).rejects.toThrow(/metadata is too large/);
    expect(fixture.events).toHaveLength(0);
  });

  it("drops ingest attempts once the registration is disposed", async () => {
    const fixture = createFixture();
    const { adapter, state } = createAdapter();
    const registration = fixture.service.register("test.channel", adapter);
    await registration.dispose();
    await state.ingest?.(draftOf());

    expect(fixture.events).toHaveLength(0);
    expect(fixture.service.listAudit()).toEqual([
      expect.objectContaining({ direction: "inbound", outcome: "stale" }),
    ]);
  });

  it("prunes persistent dedup records beyond the configured bound", async () => {
    const fixture = createFixture({ dedupCapacity: 2 });
    const { adapter, state } = createAdapter();
    fixture.service.register("test.channel", adapter);
    for (const externalId of ["a", "b", "c", "d"]) {
      await state.ingest?.(
        draftOf({
          externalId,
          receivedAt: new Date(
            Date.parse("2026-01-01T00:00:00.000Z") +
              externalId.charCodeAt(0) * 1_000,
          ).toISOString(),
        }),
      );
    }
    const stored = [...fixture.provider.entries.keys()].filter((key) =>
      key.includes("inbound/"),
    );
    expect(stored).toHaveLength(2);
    expect(fixture.events).toHaveLength(4);
  });
});

describe("CommunicationService outbound", () => {
  afterEach(() => {
    for (const service of services.splice(0)) {
      service.shutdown();
    }
  });

  it("sends once and answers replays with a duplicate receipt", async () => {
    const fixture = createFixture();
    const { adapter, state } = createAdapter();
    fixture.service.register("test.channel", adapter);

    const first = await fixture.service.send("test.loop", sendRequest());
    const second = await fixture.service.send("test.loop", sendRequest());
    expect(state.sends).toHaveLength(1);
    expect(first).toMatchObject({
      status: "sent",
      externalId: "remote-1",
      sentAt: "2026-01-01T00:00:00.000Z",
    });
    expect(second).toEqual({
      status: "duplicate",
      messageId: (first as { readonly messageId: string }).messageId,
      externalId: "remote-1",
    });
  });

  it("denies unknown adapters, destinations, and mismatched payloads", async () => {
    const fixture = createFixture();
    const { adapter, state } = createAdapter();
    fixture.service.register("test.channel", adapter);

    await expect(
      fixture.service.send("test.loop", sendRequest({ adapterId: "test.other" })),
    ).resolves.toEqual({
      status: "denied",
      reasons: ["channel_adapter_unavailable"],
    });
    await expect(
      fixture.service.send("test.loop", sendRequest({ destinationId: "room-9" })),
    ).resolves.toEqual({
      status: "denied",
      reasons: ["channel_destination_not_registered"],
    });

    await fixture.service.send("test.loop", sendRequest());
    await expect(
      fixture.service.send("test.loop", sendRequest({ text: "different body" })),
    ).resolves.toEqual({
      status: "denied",
      reasons: ["channel_idempotency_payload_mismatch"],
    });
    expect(state.sends).toHaveLength(1);
    await expect(
      fixture.service.send("test.loop", sendRequest({ idempotencyKey: "" })),
    ).rejects.toThrow(/idempotency key is invalid/);
  });

  it("rejects a run id without an active classification watermark", async () => {
    const fixture = createFixture();
    const { adapter, state } = createAdapter();
    fixture.service.register("test.channel", adapter);

    await expect(
      fixture.service.send(
        "test.loop",
        sendRequest({ runId: "missing-run", classification: "public" }),
      ),
    ).resolves.toEqual({
      status: "denied",
      reasons: ["channel_run_classification_unavailable"],
    });
    expect(state.sends).toHaveLength(0);
    expect(fixture.trust.requests).toHaveLength(0);
  });

  it("serializes concurrent sends that share an idempotency key", async () => {
    const fixture = createFixture();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { adapter, state } = createAdapter({
      send: async (_request, attempt) => {
        await gate;
        return {
          externalId: `remote-${attempt}`,
          sentAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
        };
      },
    });
    fixture.service.register("test.channel", adapter);

    const first = fixture.service.send("test.loop", sendRequest());
    const second = fixture.service.send("test.loop", sendRequest());
    await vi.waitFor(() => expect(state.sends).toHaveLength(1));
    release?.();
    const [firstReceipt, secondReceipt] = await Promise.all([first, second]);
    expect(state.sends).toHaveLength(1);
    expect(firstReceipt.status).toBe("sent");
    expect(secondReceipt.status).toBe("duplicate");
  });

  it("never retries automatically after an unknown outcome", async () => {
    const fixture = createFixture();
    const { adapter, state } = createAdapter({
      send: () => {
        throw new Error("gateway exploded");
      },
    });
    fixture.service.register("test.channel", adapter);

    await expect(fixture.service.send("test.loop", sendRequest())).rejects.toThrow(
      /failed to send/,
    );
    await expect(
      fixture.service.send("test.loop", sendRequest()),
    ).resolves.toEqual({
      status: "denied",
      reasons: ["channel_send_outcome_unknown"],
    });
    expect(state.sends).toHaveLength(1);
  });

  it("does not call the adapter when the pending record cannot be persisted", async () => {
    const fixture = createFixture();
    const { adapter, state } = createAdapter();
    fixture.service.register("test.channel", adapter);
    fixture.provider.failWrites = true;

    await expect(fixture.service.send("test.loop", sendRequest())).rejects.toThrow(
      /could not be recorded before sending/,
    );
    expect(state.sends).toHaveLength(0);
    expect(fixture.service.listAudit()).toEqual([
      expect.objectContaining({ direction: "outbound", outcome: "persist-failed" }),
    ]);
  });

  it("reports an unknown outcome when the sent receipt cannot be persisted", async () => {
    const fixture = createFixture();
    const { adapter, state } = createAdapter();
    fixture.service.register("test.channel", adapter);
    fixture.provider.failWriteAt = 2;

    await expect(
      fixture.service.send("test.loop", sendRequest()),
    ).rejects.toThrow(/completed but its receipt could not be recorded/);
    expect(state.sends).toHaveLength(1);
    expect(fixture.service.listAudit()).toEqual([
      expect.objectContaining({
        direction: "outbound",
        outcome: "receipt-persist-failed",
      }),
    ]);

    fixture.provider.failWriteAt = undefined;
    await expect(
      fixture.service.send("test.loop", sendRequest()),
    ).resolves.toEqual({
      status: "denied",
      reasons: ["channel_send_outcome_unknown"],
    });
    expect(state.sends).toHaveLength(1);
  });

  it("authorizes against the run watermark and adapter capacity", async () => {
    const fixture = createFixture();
    fixture.classification.level = "restricted";
    fixture.classification.openRuns.add("run-1");
    fixture.trust.result = {
      allowed: true,
      interactionUsed: true,
      reasons: ["classification_downgrade_approved"],
    };
    const { adapter } = createAdapter({ capacity: "public" });
    fixture.service.register("test.channel", adapter);

    const receipt = await fixture.service.send(
      "test.loop",
      sendRequest({ runId: "run-1", classification: "internal" }),
    );
    expect(receipt.status).toBe("sent");
    expect(fixture.trust.requests[0]).toMatchObject({
      pluginId: "test.loop",
      feature: "channel_send",
      runId: "run-1",
      toolCallId: expect.any(String),
      payloadClassification: "restricted",
      capacity: "public",
    });
    expect(fixture.service.listAudit()[0]).toMatchObject({
      outcome: "sent",
      classification: "restricted",
      capacity: "public",
      interactionUsed: true,
    });
  });

  it("stamps a distinct toolCallId on each outbound authorization", async () => {
    const fixture = createFixture();
    const { adapter } = createAdapter({ capacity: "public" });
    fixture.service.register("test.channel", adapter);

    const [first, second] = await Promise.all([
      fixture.service.send(
        "test.loop",
        sendRequest({
          idempotencyKey: "key-a",
          classification: "confidential",
        }),
      ),
      fixture.service.send(
        "test.loop",
        sendRequest({
          idempotencyKey: "key-b",
          classification: "confidential",
        }),
      ),
    ]);

    expect(first.status).toBe("sent");
    expect(second.status).toBe("sent");
    expect(fixture.trust.requests).toHaveLength(2);
    expect(fixture.trust.requests[0]?.toolCallId).toMatch(/./);
    expect(fixture.trust.requests[1]?.toolCallId).toMatch(/./);
    expect(fixture.trust.requests[0]?.toolCallId).not.toBe(
      fixture.trust.requests[1]?.toolCallId,
    );
  });

  it("denies the send when trust withholds approval", async () => {
    const fixture = createFixture();
    fixture.trust.result = {
      allowed: false,
      interactionUsed: true,
      reasons: ["capacity_below_classification"],
    };
    const { adapter, state } = createAdapter();
    fixture.service.register("test.channel", adapter);

    await expect(
      fixture.service.send("test.loop", sendRequest()),
    ).resolves.toEqual({
      status: "denied",
      reasons: ["capacity_below_classification"],
    });
    expect(state.sends).toHaveLength(0);
  });

  it("rechecks the approval commitment immediately before sending", async () => {
    const fixture = createFixture();
    const recheck = vi.fn(() => false);
    fixture.trust.result = {
      allowed: true,
      interactionUsed: true,
      reasons: [],
      commitment: { level: "restricted", version: 2, recheck },
    };
    const { adapter, state } = createAdapter();
    fixture.service.register("test.channel", adapter);

    await expect(
      fixture.service.send("test.loop", sendRequest()),
    ).resolves.toEqual({
      status: "denied",
      reasons: ["channel_send_approval_expired"],
    });
    expect(recheck).toHaveBeenCalledOnce();
    expect(state.sends).toHaveLength(0);
    expect(
      [...fixture.provider.entries.keys()].filter((key) =>
        key.includes("outbound/"),
      ),
    ).toEqual([]);

    fixture.trust.result = { allowed: true, interactionUsed: false, reasons: [] };
    await expect(
      fixture.service.send("test.loop", sendRequest()),
    ).resolves.toMatchObject({ status: "sent" });
  });

  it("denies a send that a blocking outbound scan rejects", async () => {
    const fixture = createFixture();
    fixture.classification.openRuns.add("run-1");
    fixture.scanners.report = cleanReport({
      findings: [
        {
          scannerId: "test.scanner",
          code: "secret.exfiltration",
          action: "block",
          reason: "api key detected",
          evidence: "sk-live-4242",
        },
      ],
    });
    const { adapter, state } = createAdapter();
    fixture.service.register("test.channel", adapter);

    await expect(
      fixture.service.send(
        "test.loop",
        sendRequest({ text: "sk-live-4242", runId: "run-1" }),
      ),
    ).resolves.toEqual({
      status: "denied",
      reasons: ["outbound_scan_blocked"],
    });
    expect(state.sends).toHaveLength(0);
    expect(fixture.trust.requests).toHaveLength(0);
    expect(fixture.classification.raised).toEqual([
      { runId: "run-1", level: "restricted" },
    ]);
    expect(fixture.scanners.requests[0]).toMatchObject({
      stage: "outbound_message",
      source: { kind: "model", id: "test.loop" },
      runId: "run-1",
    });
    expect(JSON.stringify(fixture.service.listAudit())).not.toContain("sk-live-4242");
  });

  it("keeps the audit bounded, redacted, and frozen", async () => {
    const fixture = createFixture({ auditCapacity: 2 });
    const { adapter } = createAdapter({ destinations: ["room-1", "room-2"] });
    fixture.service.register("test.channel", adapter);

    for (const key of ["k1", "k2", "k3"]) {
      await fixture.service.send(
        "test.loop",
        sendRequest({ idempotencyKey: key, text: `body ${key}` }),
      );
    }
    const audit = fixture.service.listAudit();
    expect(audit).toHaveLength(2);
    expect(Object.isFrozen(audit[0])).toBe(true);
    const serialized = JSON.stringify(audit);
    expect(serialized).not.toContain("body k3");
    expect(serialized).not.toContain("k3");
    expect(audit[1]).toMatchObject({ outcome: "sent", digest: expect.any(String) });
  });

  it("works against the real classification, scanner, and trust services", async () => {
    const registry = new PersistenceRegistry();
    registry.registerConfigStore("test.store", new MemoryConfigStore());
    const bus = new CommandEventBus();
    const events: unknown[] = [];
    bus.onById("test.listener", channelInboundMessage.id, (payload) => {
      events.push(payload);
    });
    const interactions = new InteractionService();
    interactions.subscribe((pending) => {
      for (const interaction of pending) {
        interactions.respond(interaction.id, {
          kind: "approval",
          decision: "allow",
        });
      }
    });
    const classification = new ClassificationService();
    const scanners = new ScannerRegistry();
    const trust = new TrustAuthorizer(interactions, { classification });
    const service = new CommunicationService(
      bus,
      new StoreFacade(registry),
      classification,
      scanners,
      trust,
    );
    services.push(service);

    const { adapter, state } = createAdapter();
    service.register("test.channel", adapter);
    await state.ingest?.(draftOf());
    expect(events[0]).toMatchObject({ classification: "restricted" });

    const runId = "11111111-2222-4333-8444-555555555555";
    const run = classification.openRun(runId, "internal");
    const receipt = await service.send(
      "test.loop",
      sendRequest({ runId, classification: "confidential" }),
    );
    expect(receipt.status).toBe("sent");
    expect(classification.snapshot(runId).level).toBe("restricted");
    run.dispose();
  });

  it("stops accepting work after shutdown", async () => {
    const fixture = createFixture();
    const { adapter, state } = createAdapter();
    fixture.service.register("test.channel", adapter);
    fixture.service.shutdown();

    expect(state.signal?.aborted).toBe(true);
    await expect(fixture.service.send("test.loop", sendRequest())).rejects.toThrow(
      /shut down/,
    );
    expect(() =>
      fixture.service.register("test.channel", createAdapter().adapter),
    ).toThrow(/shut down/);
  });
});
