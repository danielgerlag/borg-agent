import {
  channelAttachmentHandleSchema,
  channelCapacitySchema,
  channelInboundMessage,
  dataClassificationSchema,
  type ChannelCapacity,
  type ChannelInboundMessage,
  type DataClassification,
  type EventDefinition,
  type EventPayload,
} from "@borg/contracts";
import {
  z,
  type ChannelAdapter,
  type ChannelAdapterReceipt,
  type ChannelAttachmentHandle,
  type ChannelInboundDraft,
  type ChannelSendReceipt,
  type ChannelSendRequest,
  type Disposable,
  type JsonValue,
  type StoreEntry,
  type StoreTransactionOperation,
} from "@borg/plugin-sdk";
import { createHash } from "node:crypto";
import {
  maxClassification,
  type ClassificationSnapshot,
} from "./classification-service";
import {
  scanReportAction,
  type PromptScanReport,
  type PromptScanRequest,
} from "./scanner-registry";
import type {
  AuthorizationRequest,
  AuthorizationResult,
} from "./trust-authorizer";

const COMMUNICATION_NAMESPACE = "system.communication";
const INBOUND_PREFIX = "inbound/";
const OUTBOUND_PREFIX = "outbound/";
const ADAPTER_ID = /^[a-z0-9]+(?:[.-][a-z0-9-]+)+$/;
const MAX_ADAPTER_ID_LENGTH = 200;
const MAX_DESTINATIONS = 64;
const MAX_DESTINATION_ID_LENGTH = 256;
const MAX_EXTERNAL_ID_LENGTH = 256;
const MAX_TEXT_LENGTH = 65_536;
const MAX_ATTACHMENTS = 16;
const MAX_METADATA_KEYS = 32;
const MAX_METADATA_KEY_LENGTH = 64;
const MAX_METADATA_BYTES = 8_192;
const MAX_SENDER_LENGTH = 256;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
const MAX_CORRELATION_ID_LENGTH = 200;
const MAX_AUDIT_REASONS = 8;
const MAX_AUDIT_REASON_LENGTH = 200;
const MAX_AUDIT_SCAN_CODES = 8;
const DEFAULT_AUDIT_CAPACITY = 256;
const DEFAULT_DEDUP_CAPACITY = 1_000;
const SCAN_RANK = Object.freeze({
  allow: 0,
  review: 1,
  failed: 2,
  block: 3,
});

export type CommunicationScanOutcome = keyof typeof SCAN_RANK;

export class CommunicationError extends Error {
  constructor(
    readonly code: "invalid" | "unavailable" | "failed",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CommunicationError";
  }
}

export interface KernelEventEmitter {
  emitKernel<TEvent extends EventDefinition>(
    event: TEvent,
    payload: EventPayload<TEvent>,
  ): Promise<void>;
}

export interface CommunicationStore {
  get(namespace: string, key: string): Promise<JsonValue | undefined>;
  list(namespace: string, prefix?: string): Promise<readonly StoreEntry[]>;
  transaction(
    namespace: string,
    operations: readonly StoreTransactionOperation[],
  ): Promise<void>;
}

export interface CommunicationClassificationService {
  isOpen(runId: string): boolean;
  snapshot(runId?: string): ClassificationSnapshot;
  raise(runId: string, level: DataClassification, reason: string): unknown;
}

export interface CommunicationScannerRegistry {
  scan(request: PromptScanRequest): Promise<PromptScanReport>;
}

export interface CommunicationTrustAuthorizer {
  authorize(request: AuthorizationRequest): Promise<AuthorizationResult>;
}

export interface CommunicationServiceOptions {
  readonly auditCapacity?: number | undefined;
  readonly dedupCapacity?: number | undefined;
  readonly maxDestinations?: number | undefined;
}

export interface CommunicationAuditRecord {
  readonly direction: "inbound" | "outbound";
  readonly pluginId: string;
  readonly adapterId: string;
  readonly destinationId?: string | undefined;
  readonly outcome: string;
  readonly digest?: string | undefined;
  readonly messageId?: string | undefined;
  readonly classification?: DataClassification | undefined;
  readonly capacity?: ChannelCapacity | undefined;
  readonly scan?: CommunicationScanOutcome | undefined;
  readonly scanCodes?: readonly string[] | undefined;
  readonly interactionUsed?: boolean | undefined;
}

export interface CommunicationAdapterSummary {
  readonly pluginId: string;
  readonly adapterId: string;
  readonly capacity: ChannelCapacity;
  readonly destinations: readonly string[];
}

interface RegisteredAdapter {
  readonly pluginId: string;
  readonly adapter: ChannelAdapter;
  readonly capacity: ChannelCapacity;
  readonly destinations: ReadonlySet<string>;
  readonly controller: AbortController;
  disposed: boolean;
  started?: Disposable | undefined;
}

interface NormalizedInbound {
  readonly text: string;
  readonly destinationId: string;
  readonly externalId: string;
  readonly sender?: string | undefined;
  readonly classification?: DataClassification | undefined;
  readonly attachments: readonly ChannelAttachmentHandle[];
  readonly metadata: Readonly<Record<string, JsonValue>>;
  readonly receivedAt: string;
}

interface ScanSummary {
  readonly outcome: CommunicationScanOutcome;
  readonly codes: readonly string[];
  readonly report?: PromptScanReport | undefined;
}

const inboundRecordSchema = z
  .object({
    version: z.literal(1),
    id: z.string().min(1),
    adapterId: z.string().min(1),
    destinationId: z.string().min(1),
    digest: z.string().min(1),
    classification: dataClassificationSchema,
    scan: z.enum(["allow", "review", "block", "failed"]),
    receivedAt: z.string().min(1),
    seq: z.number().int().nonnegative(),
  })
  .strict();

const outboundRecordSchema = z
  .object({
    version: z.literal(1),
    status: z.enum(["pending", "sent", "unknown"]),
    messageId: z.string().min(1),
    pluginId: z.string().min(1),
    adapterId: z.string().min(1),
    destinationId: z.string().min(1),
    payloadHash: z.string().min(1),
    classification: dataClassificationSchema,
    externalId: z.string().min(1).optional(),
    sentAt: z.string().min(1).optional(),
    updatedAt: z.string().min(1),
  })
  .strict();

type OutboundRecord = z.infer<typeof outboundRecordSchema>;

function digestOf(...parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(part);
    hash.update("\u0000");
  }
  return hash.digest("hex");
}

function uuidFrom(...parts: readonly string[]): string {
  const bytes = createHash("sha256").update(parts.join("\u0000")).digest();
  const uuid = Buffer.from(bytes.subarray(0, 16));
  uuid[6] = ((uuid[6] ?? 0) & 0x0f) | 0x50;
  uuid[8] = ((uuid[8] ?? 0) & 0x3f) | 0x80;
  const hex = uuid.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

function asJson(value: object): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function asDisposable(value: unknown): Disposable | undefined {
  return typeof value === "object" &&
    value !== null &&
    typeof (value as Disposable).dispose === "function"
    ? (value as Disposable)
    : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function worseScan(
  left: CommunicationScanOutcome,
  right: CommunicationScanOutcome,
): CommunicationScanOutcome {
  return SCAN_RANK[left] >= SCAN_RANK[right] ? left : right;
}

function summarizeScanReport(report: PromptScanReport): {
  readonly outcome: CommunicationScanOutcome;
  readonly codes: readonly string[];
} {
  let outcome: CommunicationScanOutcome;
  try {
    outcome = scanReportAction(report);
  } catch (error) {
    console.error("[kernel] prompt scan report could not be read", error);
    return { outcome: "failed", codes: [] };
  }
  if (Array.isArray(report.failures) && report.failures.length > 0) {
    outcome = worseScan(outcome, "failed");
  }
  const codes: string[] = [];
  for (const finding of Array.isArray(report.findings) ? report.findings : []) {
    if (
      isPlainObject(finding) &&
      typeof finding.code === "string" &&
      codes.length < MAX_AUDIT_SCAN_CODES
    ) {
      codes.push(finding.code.slice(0, 64));
    }
  }
  return { outcome, codes };
}

function boundedReasons(reasons: unknown): readonly string[] {
  if (!Array.isArray(reasons)) {
    return [];
  }
  return reasons
    .slice(0, MAX_AUDIT_REASONS)
    .map((reason) =>
      typeof reason === "string"
        ? reason.slice(0, MAX_AUDIT_REASON_LENGTH)
        : "unspecified",
    );
}

function assertBoundedId(
  value: unknown,
  maxLength: number,
  description: string,
): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    /[\0\r\n]/.test(value)
  ) {
    throw new CommunicationError("invalid", `${description} is invalid`);
  }
  return value;
}

function assertIsoTimestamp(value: string, description: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new CommunicationError("invalid", `${description} is invalid`);
  }
  return new Date(parsed).toISOString();
}

function normalizeAttachments(
  candidate: readonly ChannelAttachmentHandle[] | undefined,
): readonly ChannelAttachmentHandle[] {
  if (candidate === undefined) {
    return [];
  }
  if (!Array.isArray(candidate) || candidate.length > MAX_ATTACHMENTS) {
    throw new CommunicationError("invalid", "Channel attachments are invalid");
  }
  return candidate.map((attachment) => {
    const parsed = channelAttachmentHandleSchema.safeParse(attachment);
    if (!parsed.success) {
      throw new CommunicationError("invalid", "Channel attachment is invalid", {
        cause: parsed.error,
      });
    }
    return parsed.data;
  });
}

function normalizeMetadata(
  candidate: Readonly<Record<string, JsonValue>> | undefined,
): Readonly<Record<string, JsonValue>> {
  if (candidate === undefined) {
    return {};
  }
  if (!isPlainObject(candidate)) {
    throw new CommunicationError("invalid", "Channel metadata must be an object");
  }
  const entries = Object.entries(candidate);
  if (entries.length > MAX_METADATA_KEYS) {
    throw new CommunicationError("invalid", "Channel metadata has too many keys");
  }
  for (const [key] of entries) {
    if (key.length === 0 || key.length > MAX_METADATA_KEY_LENGTH) {
      throw new CommunicationError("invalid", "Channel metadata key is invalid");
    }
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(candidate) ?? "";
  } catch (error) {
    throw new CommunicationError(
      "invalid",
      "Channel metadata is not serializable",
      { cause: error },
    );
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_METADATA_BYTES) {
    throw new CommunicationError("invalid", "Channel metadata is too large");
  }
  return Object.fromEntries(entries) as Readonly<Record<string, JsonValue>>;
}

export class CommunicationService {
  readonly #bus: KernelEventEmitter;
  readonly #store: CommunicationStore;
  readonly #classification: CommunicationClassificationService;
  readonly #scanners: CommunicationScannerRegistry;
  readonly #trust: CommunicationTrustAuthorizer;
  readonly #auditCapacity: number;
  readonly #dedupCapacity: number;
  readonly #maxDestinations: number;
  readonly #adapters = new Map<string, RegisteredAdapter>();
  readonly #audit: CommunicationAuditRecord[] = [];
  readonly #locks = new Map<string, Promise<void>>();
  readonly #shutdown = new AbortController();
  #inboundCount: number | undefined;
  #sequence = 0;

  constructor(
    bus: KernelEventEmitter,
    store: CommunicationStore,
    classification: CommunicationClassificationService,
    scanners: CommunicationScannerRegistry,
    trust: CommunicationTrustAuthorizer,
    options: CommunicationServiceOptions = {},
  ) {
    this.#bus = bus;
    this.#store = store;
    this.#classification = classification;
    this.#scanners = scanners;
    this.#trust = trust;
    this.#auditCapacity = positiveBound(
      options.auditCapacity,
      DEFAULT_AUDIT_CAPACITY,
      "Communication audit capacity",
    );
    this.#dedupCapacity = positiveBound(
      options.dedupCapacity,
      DEFAULT_DEDUP_CAPACITY,
      "Communication dedup capacity",
    );
    this.#maxDestinations = Math.min(
      positiveBound(
        options.maxDestinations,
        MAX_DESTINATIONS,
        "Communication destination bound",
      ),
      MAX_DESTINATIONS,
    );
  }

  register(pluginId: string, adapter: ChannelAdapter): Disposable {
    if (this.#shutdown.signal.aborted) {
      throw new CommunicationError(
        "unavailable",
        "Communication service is shut down",
      );
    }
    const adapterId = assertBoundedId(
      adapter?.id,
      MAX_ADAPTER_ID_LENGTH,
      "Channel adapter id",
    );
    if (!ADAPTER_ID.test(adapterId)) {
      throw new CommunicationError(
        "invalid",
        `Channel adapter id ${adapterId} is not a namespaced identifier`,
      );
    }
    if (adapterId !== pluginId && !adapterId.startsWith(`${pluginId}.`)) {
      throw new CommunicationError(
        "invalid",
        `Channel adapter ${adapterId} is outside namespace ${pluginId}`,
      );
    }
    const capacity = channelCapacitySchema.safeParse(adapter.capacity);
    if (!capacity.success) {
      throw new CommunicationError(
        "invalid",
        `Channel adapter ${adapterId} declared an unknown capacity`,
      );
    }
    if (
      !Array.isArray(adapter.destinations) ||
      adapter.destinations.length === 0 ||
      adapter.destinations.length > this.#maxDestinations
    ) {
      throw new CommunicationError(
        "invalid",
        `Channel adapter ${adapterId} declared an invalid destination list`,
      );
    }
    const destinations = new Set<string>();
    for (const destination of adapter.destinations) {
      const validated = assertBoundedId(
        destination,
        MAX_DESTINATION_ID_LENGTH,
        `Channel destination for ${adapterId}`,
      );
      if (destinations.has(validated)) {
        throw new CommunicationError(
          "invalid",
          `Channel adapter ${adapterId} declared duplicate destinations`,
        );
      }
      destinations.add(validated);
    }
    if (typeof adapter.send !== "function") {
      throw new CommunicationError(
        "invalid",
        `Channel adapter ${adapterId} does not implement send`,
      );
    }
    if (this.#adapters.has(adapterId)) {
      throw new CommunicationError(
        "invalid",
        `Channel adapter ${adapterId} is already registered`,
      );
    }

    const registration: RegisteredAdapter = {
      pluginId,
      adapter,
      capacity: capacity.data,
      destinations,
      controller: new AbortController(),
      disposed: false,
    };
    this.#adapters.set(adapterId, registration);

    if (typeof adapter.start === "function") {
      const scope = Object.freeze({
        ingest: (draft: ChannelInboundDraft): Promise<void> =>
          this.#ingest(registration, draft),
        signal: registration.controller.signal,
      });
      try {
        const started: unknown = adapter.start(scope);
        if (
          typeof started === "object" &&
          started !== null &&
          typeof (started as PromiseLike<unknown>).then === "function"
        ) {
          void Promise.resolve(started)
            .then((resolved: unknown) => {
              const disposable = asDisposable(resolved);
              if (!disposable) {
                return;
              }
              if (registration.disposed) {
                void disposeQuietly(adapterId, disposable);
                return;
              }
              registration.started = disposable;
            })
            .catch((error: unknown) => {
              console.error(
                `[kernel] channel adapter ${adapterId} failed to start`,
                error,
              );
            });
        } else {
          registration.started = asDisposable(started);
        }
      } catch (error) {
        this.#adapters.delete(adapterId);
        registration.disposed = true;
        registration.controller.abort(
          new Error(`Channel adapter ${adapterId} failed to start`),
        );
        throw new CommunicationError(
          "failed",
          `Channel adapter ${adapterId} failed to start`,
          { cause: error },
        );
      }
    }

    return {
      dispose: () => {
        if (this.#adapters.get(adapterId) === registration) {
          this.#adapters.delete(adapterId);
        }
        this.#tearDown(adapterId, registration, "unregistered");
      },
    };
  }

  removePlugin(pluginId: string): void {
    for (const [adapterId, registration] of [...this.#adapters]) {
      if (registration.pluginId !== pluginId) {
        continue;
      }
      this.#adapters.delete(adapterId);
      this.#tearDown(adapterId, registration, "deactivated");
    }
  }

  shutdown(): void {
    if (!this.#shutdown.signal.aborted) {
      this.#shutdown.abort(new Error("Communication service is shutting down"));
    }
    for (const [adapterId, registration] of [...this.#adapters]) {
      this.#adapters.delete(adapterId);
      this.#tearDown(adapterId, registration, "shutdown");
    }
  }

  listAdapters(): readonly CommunicationAdapterSummary[] {
    return [...this.#adapters].map(([adapterId, registration]) =>
      Object.freeze({
        pluginId: registration.pluginId,
        adapterId,
        capacity: registration.capacity,
        destinations: Object.freeze([...registration.destinations]),
      }),
    );
  }

  listAudit(): readonly CommunicationAuditRecord[] {
    return this.#audit.map((record) => Object.freeze({ ...record }));
  }

  async send(
    callerPluginId: string,
    request: ChannelSendRequest,
  ): Promise<ChannelSendReceipt> {
    if (this.#shutdown.signal.aborted) {
      throw new CommunicationError(
        "unavailable",
        "Communication service is shut down",
      );
    }
    if (!isPlainObject(request)) {
      throw new CommunicationError("invalid", "Channel send request is invalid");
    }
    const adapterId = assertBoundedId(
      request.adapterId,
      MAX_ADAPTER_ID_LENGTH,
      "Channel adapter id",
    );
    const destinationId = assertBoundedId(
      request.destinationId,
      MAX_DESTINATION_ID_LENGTH,
      "Channel destination id",
    );
    const idempotencyKey = assertBoundedId(
      request.idempotencyKey,
      MAX_IDEMPOTENCY_KEY_LENGTH,
      "Channel idempotency key",
    );
    if (typeof request.text !== "string" || request.text.length > MAX_TEXT_LENGTH) {
      throw new CommunicationError("invalid", "Channel message text is invalid");
    }
    const attachments = normalizeAttachments(request.attachments);
    const runId =
      request.runId === undefined
        ? undefined
        : assertBoundedId(request.runId, MAX_CORRELATION_ID_LENGTH, "Run id");
    const sessionId =
      request.sessionId === undefined
        ? undefined
        : assertBoundedId(
            request.sessionId,
            MAX_CORRELATION_ID_LENGTH,
            "Session id",
          );
    const explicit =
      request.classification === undefined
        ? undefined
        : dataClassificationSchema.parse(request.classification);
    if (runId !== undefined && !this.#classification.isOpen(runId)) {
      this.#record({
        direction: "outbound",
        pluginId: callerPluginId,
        adapterId,
        destinationId,
        outcome: "unknown-run",
      });
      return denied(["channel_run_classification_unavailable"]);
    }

    const registration = this.#adapters.get(adapterId);
    if (!registration || registration.disposed) {
      this.#record({
        direction: "outbound",
        pluginId: callerPluginId,
        adapterId,
        destinationId,
        outcome: "unknown-adapter",
      });
      return denied(["channel_adapter_unavailable"]);
    }
    if (!registration.destinations.has(destinationId)) {
      this.#record({
        direction: "outbound",
        pluginId: callerPluginId,
        adapterId,
        destinationId,
        outcome: "unknown-destination",
      });
      return denied(["channel_destination_not_registered"]);
    }

    const digest = digestOf(request.text);
    const recordKey = `${OUTBOUND_PREFIX}${digestOf(adapterId, idempotencyKey)}`;
    const messageId = uuidFrom("outbound", adapterId, idempotencyKey);
    const payloadHash = digestOf(
      destinationId,
      request.text,
      explicit ?? "",
      ...attachments.map((attachment) =>
        [
          attachment.id,
          attachment.name,
          attachment.mimeType,
          String(attachment.size ?? ""),
        ].join("\u0001"),
      ),
    );

    return this.#withLock(recordKey, async () =>
      this.#sendLocked({
        callerPluginId,
        registration,
        adapterId,
        destinationId,
        text: request.text,
        idempotencyKey,
        attachments,
        runId,
        sessionId,
        explicit,
        digest,
        recordKey,
        messageId,
        payloadHash,
        signal: request.signal,
      }),
    );
  }

  async #sendLocked(context: {
    readonly callerPluginId: string;
    readonly registration: RegisteredAdapter;
    readonly adapterId: string;
    readonly destinationId: string;
    readonly text: string;
    readonly idempotencyKey: string;
    readonly attachments: readonly ChannelAttachmentHandle[];
    readonly runId?: string | undefined;
    readonly sessionId?: string | undefined;
    readonly explicit?: DataClassification | undefined;
    readonly digest: string;
    readonly recordKey: string;
    readonly messageId: string;
    readonly payloadHash: string;
    readonly signal?: AbortSignal | undefined;
  }): Promise<ChannelSendReceipt> {
    const {
      callerPluginId,
      registration,
      adapterId,
      destinationId,
      digest,
      recordKey,
      messageId,
      payloadHash,
    } = context;

    let existing: OutboundRecord | undefined;
    let unreadable = false;
    try {
      const stored = await this.#store.get(COMMUNICATION_NAMESPACE, recordKey);
      if (stored !== undefined) {
        const parsed = outboundRecordSchema.safeParse(stored);
        if (parsed.success) {
          existing = parsed.data;
        } else {
          unreadable = true;
        }
      }
    } catch (error) {
      this.#record({
        direction: "outbound",
        pluginId: callerPluginId,
        adapterId,
        destinationId,
        outcome: "store-unavailable",
        digest,
      });
      throw new CommunicationError(
        "failed",
        `Channel idempotency record for ${adapterId} could not be read`,
        { cause: error },
      );
    }

    if (unreadable) {
      this.#record({
        direction: "outbound",
        pluginId: callerPluginId,
        adapterId,
        destinationId,
        outcome: "record-unreadable",
        digest,
        messageId,
      });
      return denied(["channel_idempotency_record_unreadable"]);
    }

    if (existing) {
      if (existing.payloadHash !== payloadHash) {
        this.#record({
          direction: "outbound",
          pluginId: callerPluginId,
          adapterId,
          destinationId,
          outcome: "idempotency-conflict",
          digest,
          messageId,
        });
        return denied(["channel_idempotency_payload_mismatch"]);
      }
      if (existing.status === "sent") {
        this.#record({
          direction: "outbound",
          pluginId: callerPluginId,
          adapterId,
          destinationId,
          outcome: "duplicate",
          digest,
          messageId: existing.messageId,
        });
        return Object.freeze({
          status: "duplicate" as const,
          messageId: existing.messageId,
          ...(existing.externalId !== undefined
            ? { externalId: existing.externalId }
            : {}),
        });
      }
      this.#record({
        direction: "outbound",
        pluginId: callerPluginId,
        adapterId,
        destinationId,
        outcome: "outcome-unknown",
        digest,
        messageId: existing.messageId,
      });
      return denied(["channel_send_outcome_unknown"]);
    }

    const operationSignal = AbortSignal.any([
      ...(context.signal ? [context.signal] : []),
      registration.controller.signal,
      this.#shutdown.signal,
    ]);
    const scan = await this.#scan({
      stage: "outbound_message",
      text: context.text,
      source: { kind: "model", id: callerPluginId },
      ...(context.runId !== undefined ? { runId: context.runId } : {}),
      ...(context.sessionId !== undefined ? { sessionId: context.sessionId } : {}),
      signal: operationSignal,
    });
    if (
      scan.outcome !== "allow" &&
      !(await this.#raise(
        context.runId,
        `outbound scan ${scan.outcome} on ${adapterId}`,
      ))
    ) {
      this.#record({
        direction: "outbound",
        pluginId: callerPluginId,
        adapterId,
        destinationId,
        outcome: "classification-failed",
        digest,
        messageId,
        scan: scan.outcome,
      });
      return denied(["channel_classification_update_failed"]);
    }
    if (scan.outcome === "block") {
      this.#record({
        direction: "outbound",
        pluginId: callerPluginId,
        adapterId,
        destinationId,
        outcome: "scan-blocked",
        digest,
        messageId,
        scan: scan.outcome,
        scanCodes: scan.codes,
        capacity: registration.capacity,
      });
      return denied(["outbound_scan_blocked"]);
    }

    const watermark = this.#watermark(context.runId);
    let classification = maxClassification(
      context.explicit ?? "internal",
      watermark,
    );
    if (scan.outcome !== "allow") {
      classification = maxClassification(classification, "restricted");
    }

    let authorization: AuthorizationResult;
    try {
      authorization = await this.#trust.authorize({
        pluginId: callerPluginId,
        feature: "channel_send",
        title: `Send a message through ${adapterId}`,
        approval: "auto",
        payloadClassification: classification,
        capacity: registration.capacity,
        scanReport: scan.report,
        signal: operationSignal,
        toolCallId: messageId,
        ...(context.runId !== undefined ? { runId: context.runId } : {}),
        ...(context.sessionId !== undefined
          ? { sessionId: context.sessionId }
          : {}),
      });
    } catch (error) {
      this.#record({
        direction: "outbound",
        pluginId: callerPluginId,
        adapterId,
        destinationId,
        outcome: "authorization-failed",
        digest,
        messageId,
        classification,
        capacity: registration.capacity,
        scan: scan.outcome,
      });
      throw new CommunicationError(
        "failed",
        `Channel send authorization for ${adapterId} failed`,
        { cause: error },
      );
    }

    if (!authorization.allowed) {
      const reasons = boundedReasons(authorization.reasons);
      this.#record({
        direction: "outbound",
        pluginId: callerPluginId,
        adapterId,
        destinationId,
        outcome: "denied",
        digest,
        messageId,
        classification,
        capacity: registration.capacity,
        scan: scan.outcome,
        scanCodes: scan.codes,
        interactionUsed: authorization.interactionUsed === true,
      });
      return denied(reasons.length > 0 ? reasons : ["channel_send_denied"]);
    }

    const pending: OutboundRecord = {
      version: 1,
      status: "pending",
      messageId,
      pluginId: callerPluginId,
      adapterId,
      destinationId,
      payloadHash,
      classification,
      updatedAt: new Date().toISOString(),
    };
    try {
      await this.#persist(recordKey, pending);
    } catch (error) {
      this.#record({
        direction: "outbound",
        pluginId: callerPluginId,
        adapterId,
        destinationId,
        outcome: "persist-failed",
        digest,
        messageId,
        classification,
        capacity: registration.capacity,
        scan: scan.outcome,
      });
      throw new CommunicationError(
        "failed",
        `Channel send for ${adapterId} could not be recorded before sending`,
        { cause: error },
      );
    }

    if (
      authorization.commitment !== undefined &&
      authorization.commitment.recheck() !== true
    ) {
      await this.#forget(recordKey);
      this.#record({
        direction: "outbound",
        pluginId: callerPluginId,
        adapterId,
        destinationId,
        outcome: "commitment-expired",
        digest,
        messageId,
        classification,
        capacity: registration.capacity,
        scan: scan.outcome,
        interactionUsed: authorization.interactionUsed === true,
      });
      return denied(["channel_send_approval_expired"]);
    }

    if (
      this.#adapters.get(adapterId) !== registration ||
      registration.disposed ||
      operationSignal.aborted
    ) {
      await this.#forget(recordKey);
      this.#record({
        direction: "outbound",
        pluginId: callerPluginId,
        adapterId,
        destinationId,
        outcome: "stale",
        digest,
        messageId,
        classification,
      });
      return denied(["channel_adapter_unavailable"]);
    }

    let receipt: ChannelAdapterReceipt;
    try {
      const result = await registration.adapter.send({
        adapterId,
        destinationId,
        text: context.text,
        idempotencyKey: context.idempotencyKey,
        classification,
        signal: operationSignal,
        ...(context.runId !== undefined ? { runId: context.runId } : {}),
        ...(context.sessionId !== undefined
          ? { sessionId: context.sessionId }
          : {}),
        ...(context.attachments.length > 0
          ? { attachments: context.attachments }
          : {}),
      });
      receipt = {
        externalId: assertBoundedId(
          result?.externalId,
          MAX_EXTERNAL_ID_LENGTH,
          `Channel receipt from ${adapterId}`,
        ),
        sentAt: assertIsoTimestamp(
          typeof result?.sentAt === "string" ? result.sentAt : "",
          `Channel receipt timestamp from ${adapterId}`,
        ),
      };
    } catch (error) {
      await this.#persistQuietly(recordKey, {
        ...pending,
        status: "unknown",
        updatedAt: new Date().toISOString(),
      });
      this.#record({
        direction: "outbound",
        pluginId: callerPluginId,
        adapterId,
        destinationId,
        outcome: "send-failed",
        digest,
        messageId,
        classification,
        capacity: registration.capacity,
        scan: scan.outcome,
        interactionUsed: authorization.interactionUsed === true,
      });
      throw new CommunicationError(
        "failed",
        `Channel adapter ${adapterId} failed to send`,
        { cause: error },
      );
    }

    try {
      await this.#persist(recordKey, {
        ...pending,
        status: "sent",
        externalId: receipt.externalId,
        sentAt: receipt.sentAt,
        updatedAt: new Date().toISOString(),
      });
    } catch (error) {
      this.#record({
        direction: "outbound",
        pluginId: callerPluginId,
        adapterId,
        destinationId,
        outcome: "receipt-persist-failed",
        digest,
        messageId,
        classification,
        capacity: registration.capacity,
        scan: scan.outcome,
        interactionUsed: authorization.interactionUsed === true,
      });
      throw new CommunicationError(
        "failed",
        `Channel send for ${adapterId} completed but its receipt could not be recorded`,
        { cause: error },
      );
    }
    this.#record({
      direction: "outbound",
      pluginId: callerPluginId,
      adapterId,
      destinationId,
      outcome: "sent",
      digest,
      messageId,
      classification,
      capacity: registration.capacity,
      scan: scan.outcome,
      interactionUsed: authorization.interactionUsed === true,
    });
    return Object.freeze({
      status: "sent" as const,
      messageId,
      externalId: receipt.externalId,
      sentAt: receipt.sentAt,
    });
  }

  async #ingest(
    registration: RegisteredAdapter,
    draft: ChannelInboundDraft,
  ): Promise<void> {
    const adapterId = registration.adapter.id;
    if (
      this.#shutdown.signal.aborted ||
      registration.disposed ||
      this.#adapters.get(adapterId) !== registration
    ) {
      this.#record({
        direction: "inbound",
        pluginId: registration.pluginId,
        adapterId,
        outcome: "stale",
      });
      return;
    }

    let normalized: NormalizedInbound;
    try {
      normalized = normalizeInbound(registration, draft);
    } catch (error) {
      this.#record({
        direction: "inbound",
        pluginId: registration.pluginId,
        adapterId,
        outcome: "rejected",
      });
      throw error instanceof CommunicationError
        ? error
        : new CommunicationError(
            "invalid",
            `Inbound message from ${adapterId} is invalid`,
            { cause: error },
          );
    }

    const messageId = uuidFrom(
      "inbound",
      adapterId,
      normalized.destinationId,
      normalized.externalId,
    );
    const recordKey = `${INBOUND_PREFIX}${messageId}`;
    await this.#withLock(recordKey, async () =>
      this.#ingestLocked(registration, normalized, messageId, recordKey),
    );
  }

  async #ingestLocked(
    registration: RegisteredAdapter,
    normalized: NormalizedInbound,
    messageId: string,
    recordKey: string,
  ): Promise<void> {
    const adapterId = registration.adapter.id;
    const digest = digestOf(normalized.text);
    let stored: JsonValue | undefined;
    try {
      stored = await this.#store.get(COMMUNICATION_NAMESPACE, recordKey);
    } catch (error) {
      this.#record({
        direction: "inbound",
        pluginId: registration.pluginId,
        adapterId,
        destinationId: normalized.destinationId,
        outcome: "store-unavailable",
        digest,
        messageId,
      });
      throw new CommunicationError(
        "failed",
        `Inbound dedup record for ${adapterId} could not be read`,
        { cause: error },
      );
    }
    if (stored !== undefined) {
      this.#record({
        direction: "inbound",
        pluginId: registration.pluginId,
        adapterId,
        destinationId: normalized.destinationId,
        outcome: "duplicate",
        digest,
        messageId,
      });
      return;
    }

    const scan = await this.#scan({
      stage: "inbound_message",
      text: normalized.text,
      source: { kind: "channel", id: adapterId },
      signal: AbortSignal.any([
        registration.controller.signal,
        this.#shutdown.signal,
      ]),
    });
    let classification = normalized.classification ?? "internal";
    if (scan.outcome !== "allow") {
      classification = maxClassification(classification, "restricted");
    }

    const record = {
      version: 1 as const,
      id: messageId,
      adapterId,
      destinationId: normalized.destinationId,
      digest,
      classification,
      scan: scan.outcome,
      receivedAt: normalized.receivedAt,
      seq: (this.#sequence += 1),
    };
    const authorization = await this.#trust.authorize({
      pluginId: registration.pluginId,
      feature: "channel_inbound",
      title: `Review a message from ${adapterId}`,
      approval: "auto",
      toolCallId: messageId,
      payloadClassification: classification,
      scanReport: scan.report,
      signal: AbortSignal.any([
        registration.controller.signal,
        this.#shutdown.signal,
      ]),
    });
    if (!authorization.allowed) {
      try {
        inboundRecordSchema.parse(record);
        await this.#persist(recordKey, record);
        await this.#pruneInbound();
      } catch (error) {
        throw new CommunicationError(
          "failed",
          `Rejected inbound message from ${adapterId} could not be recorded`,
          { cause: error },
        );
      }
      this.#record({
        direction: "inbound",
        pluginId: registration.pluginId,
        adapterId,
        destinationId: normalized.destinationId,
        outcome: scan.outcome === "block" ? "scan-blocked" : "denied",
        digest,
        messageId,
        classification,
        capacity: registration.capacity,
        scan: scan.outcome,
        scanCodes: scan.codes,
        interactionUsed: authorization.interactionUsed === true,
      });
      return;
    }
    try {
      inboundRecordSchema.parse(record);
      await this.#persist(recordKey, record);
    } catch (error) {
      this.#record({
        direction: "inbound",
        pluginId: registration.pluginId,
        adapterId,
        destinationId: normalized.destinationId,
        outcome: "persist-failed",
        digest,
        messageId,
        classification,
        scan: scan.outcome,
      });
      throw new CommunicationError(
        "failed",
        `Inbound message from ${adapterId} could not be recorded`,
        { cause: error },
      );
    }
    await this.#pruneInbound();

    const payload: ChannelInboundMessage = {
      id: messageId,
      channelId: `${adapterId}:${normalized.destinationId}`,
      text: normalized.text,
      externalId: normalized.externalId,
      adapterId,
      destinationId: normalized.destinationId,
      classification,
      metadata: JSON.parse(
        JSON.stringify(normalized.metadata),
      ) as ChannelInboundMessage["metadata"],
      receivedAt: normalized.receivedAt,
      ...(normalized.sender !== undefined ? { sender: normalized.sender } : {}),
      ...(normalized.attachments.length > 0
        ? { attachments: [...normalized.attachments] }
        : {}),
    };
    try {
      await this.#bus.emitKernel(channelInboundMessage, payload);
    } catch (error) {
      this.#record({
        direction: "inbound",
        pluginId: registration.pluginId,
        adapterId,
        destinationId: normalized.destinationId,
        outcome: "emit-failed",
        digest,
        messageId,
        classification,
        scan: scan.outcome,
      });
      throw new CommunicationError(
        "failed",
        `Inbound message from ${adapterId} could not be published`,
        { cause: error },
      );
    }
    this.#record({
      direction: "inbound",
      pluginId: registration.pluginId,
      adapterId,
      destinationId: normalized.destinationId,
      outcome: "emitted",
      digest,
      messageId,
      classification,
      capacity: registration.capacity,
      scan: scan.outcome,
      scanCodes: scan.codes,
    });
  }

  async #scan(request: PromptScanRequest): Promise<ScanSummary> {
    try {
      const report = await this.#scanners.scan(request);
      const summary = summarizeScanReport(report);
      return { outcome: summary.outcome, codes: summary.codes, report };
    } catch {
      console.error("[kernel] channel scan failed");
      return {
        outcome: "failed",
        codes: [],
        report: {
          stage: request.stage,
          findings: [],
          failures: [
            {
              scannerId: "kernel.communication",
              kind: "error",
              message: "Prompt scanning failed",
            },
          ],
          coverage: "none",
          truncated: false,
          unavailableAction: "review",
        },
      };
    }
  }

  #watermark(runId: string | undefined): DataClassification {
    try {
      const snapshot = this.#classification.snapshot(runId);
      const parsed = dataClassificationSchema.safeParse(snapshot?.level);
      return parsed.success ? parsed.data : "restricted";
    } catch (error) {
      console.error("[kernel] classification snapshot failed", error);
      return "restricted";
    }
  }

  async #raise(runId: string | undefined, reason: string): Promise<boolean> {
    if (runId === undefined) {
      return true;
    }
    try {
      const result = this.#classification.raise(runId, "restricted", reason);
      if (
        result &&
        typeof (result as PromiseLike<unknown>).then === "function"
      ) {
        await result;
      }
      return true;
    } catch (error) {
      console.error("[kernel] classification escalation failed", error);
      return false;
    }
  }

  async #persist(key: string, value: object): Promise<void> {
    await this.#store.transaction(COMMUNICATION_NAMESPACE, [
      { type: "set", key, value: asJson(value) },
    ]);
  }

  async #persistQuietly(key: string, value: object): Promise<void> {
    try {
      await this.#persist(key, value);
    } catch (error) {
      console.error("[kernel] channel record could not be persisted", error);
    }
  }

  async #forget(key: string): Promise<void> {
    try {
      await this.#store.transaction(COMMUNICATION_NAMESPACE, [
        { type: "delete", key },
      ]);
    } catch (error) {
      console.error("[kernel] channel record could not be released", error);
    }
  }

  async #pruneInbound(): Promise<void> {
    try {
      if (this.#inboundCount === undefined) {
        this.#inboundCount = (
          await this.#store.list(COMMUNICATION_NAMESPACE, INBOUND_PREFIX)
        ).length;
      } else {
        this.#inboundCount += 1;
      }
      if (this.#inboundCount <= this.#dedupCapacity) {
        return;
      }
      const entries = await this.#store.list(
        COMMUNICATION_NAMESPACE,
        INBOUND_PREFIX,
      );
      const ordered = entries
        .map((entry) => {
          const parsed = inboundRecordSchema.safeParse(entry.value);
          return {
            key: entry.key,
            seq: parsed.success ? parsed.data.seq : 0,
            receivedAt: parsed.success ? parsed.data.receivedAt : "",
          };
        })
        .sort(
          (left, right) =>
            left.receivedAt.localeCompare(right.receivedAt) ||
            left.seq - right.seq ||
            left.key.localeCompare(right.key),
        );
      const overflow = ordered.length - this.#dedupCapacity;
      if (overflow <= 0) {
        this.#inboundCount = ordered.length;
        return;
      }
      await this.#store.transaction(
        COMMUNICATION_NAMESPACE,
        ordered.slice(0, overflow).map((entry) => ({
          type: "delete" as const,
          key: entry.key,
        })),
      );
      this.#inboundCount = ordered.length - overflow;
    } catch (error) {
      this.#inboundCount = undefined;
      console.error("[kernel] inbound dedup pruning failed", error);
    }
  }

  async #withLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(key) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#locks.set(key, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
      if (this.#locks.get(key) === tail) {
        this.#locks.delete(key);
      }
    }
  }

  #tearDown(
    adapterId: string,
    registration: RegisteredAdapter,
    reason: string,
  ): void {
    if (registration.disposed) {
      return;
    }
    registration.disposed = true;
    if (!registration.controller.signal.aborted) {
      registration.controller.abort(
        new Error(`Channel adapter ${adapterId} was ${reason}`),
      );
    }
    const started = registration.started;
    registration.started = undefined;
    if (started) {
      void disposeQuietly(adapterId, started);
    }
  }

  #record(record: CommunicationAuditRecord): void {
    this.#audit.push(Object.freeze({ ...record }));
    const overflow = this.#audit.length - this.#auditCapacity;
    if (overflow > 0) {
      this.#audit.splice(0, overflow);
    }
  }
}

function normalizeInbound(
  registration: RegisteredAdapter,
  draft: ChannelInboundDraft,
): NormalizedInbound {
  if (!isPlainObject(draft)) {
    throw new CommunicationError("invalid", "Inbound draft must be an object");
  }
  const destinationId = assertBoundedId(
    draft.destinationId,
    MAX_DESTINATION_ID_LENGTH,
    "Inbound destination id",
  );
  if (!registration.destinations.has(destinationId)) {
    throw new CommunicationError(
      "invalid",
      `Inbound destination ${destinationId} is not registered for ${registration.adapter.id}`,
    );
  }
  const externalId = assertBoundedId(
    draft.externalId,
    MAX_EXTERNAL_ID_LENGTH,
    "Inbound external id",
  );
  if (typeof draft.text !== "string" || draft.text.length > MAX_TEXT_LENGTH) {
    throw new CommunicationError("invalid", "Inbound text is invalid");
  }
  if (
    draft.sender !== undefined &&
    (typeof draft.sender !== "string" ||
      draft.sender.length === 0 ||
      draft.sender.length > MAX_SENDER_LENGTH)
  ) {
    throw new CommunicationError("invalid", "Inbound sender is invalid");
  }
  const classification =
    draft.classification === undefined
      ? undefined
      : dataClassificationSchema.parse(draft.classification);
  return {
    text: draft.text,
    destinationId,
    externalId,
    attachments: normalizeAttachments(draft.attachments),
    metadata: normalizeMetadata(draft.metadata),
    receivedAt:
      draft.receivedAt === undefined
        ? new Date().toISOString()
        : assertIsoTimestamp(draft.receivedAt, "Inbound receivedAt"),
    ...(draft.sender !== undefined ? { sender: draft.sender } : {}),
    ...(classification !== undefined ? { classification } : {}),
  };
}

function positiveBound(
  candidate: number | undefined,
  fallback: number,
  description: string,
): number {
  if (candidate === undefined) {
    return fallback;
  }
  if (!Number.isInteger(candidate) || candidate < 1) {
    throw new CommunicationError("invalid", `${description} is invalid`);
  }
  return candidate;
}

function denied(reasons: readonly string[]): ChannelSendReceipt {
  return Object.freeze({
    status: "denied" as const,
    reasons: Object.freeze([...reasons]),
  });
}

async function disposeQuietly(
  adapterId: string,
  disposable: Disposable,
): Promise<void> {
  try {
    await disposable.dispose();
  } catch (error) {
    console.error(`[kernel] channel adapter ${adapterId} dispose failed`, error);
  }
}
