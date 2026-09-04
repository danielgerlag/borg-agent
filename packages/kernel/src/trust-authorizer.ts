import type {
  ChannelCapacity,
  DataClassification,
  ToolApproval,
} from "@borg/contracts";
import {
  UNCLASSIFIED_SNAPSHOT,
  capacityCeiling,
  exceedsCapacity,
  maxClassification,
  type ClassificationService,
  type ClassificationSnapshot,
} from "./classification-service";
import type { InteractionService } from "./interaction-service";
import { scanReportAction, type PromptScanReport } from "./scanner-registry";

const MAX_PROMPT_REASONS = 20;
const SECOND_PROMPT_REASON =
  "One request may only ask you once, so this step was denied instead.";
const USER_DENIED_REASON = "You denied this request.";

export interface AuthorizationRequest {
  readonly pluginId: string;
  readonly feature: string;
  readonly title: string;
  readonly approval: ToolApproval;
  readonly runId?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly toolCallId?: string | undefined;
  readonly payloadClassification?: DataClassification | undefined;
  readonly capacity?: ChannelCapacity | undefined;
  readonly scanReport?: PromptScanReport | undefined;
  readonly interactionUsed?: boolean | undefined;
  readonly signal?: AbortSignal | undefined;
  onInteraction?(interactionId: string): void;
}

export interface ClassificationCommitment {
  readonly runId?: string | undefined;
  readonly level: DataClassification;
  readonly version: number;
  /** False once the run's high-water mark moved past the approved point. */
  recheck(): boolean;
}

export interface AuthorizationResult {
  readonly allowed: boolean;
  readonly interactionUsed: boolean;
  readonly reasons: readonly string[];
  readonly commitment?: ClassificationCommitment | undefined;
}

export interface TrustAuthorizerOptions {
  readonly classification?: ClassificationService | undefined;
}

/**
 * The only caller of InteractionService.requestSafety for tool calls and
 * outbound sends. Approval policy, data classification, and prompt-scan
 * verdicts are combined here so one request costs at most one prompt.
 */
export class TrustAuthorizer {
  readonly #interactions: InteractionService;
  readonly #classification: ClassificationService | undefined;
  readonly #inFlight = new Map<string, Promise<AuthorizationResult>>();

  constructor(
    interactions: InteractionService,
    options: TrustAuthorizerOptions = {},
  ) {
    this.#interactions = interactions;
    this.#classification = options.classification;
  }

  async authorize(request: AuthorizationRequest): Promise<AuthorizationResult> {
    request.signal?.throwIfAborted();
    const interactionUsed = request.interactionUsed === true;
    const snapshot: ClassificationSnapshot =
      this.#classification?.snapshot(request.runId) ?? UNCLASSIFIED_SNAPSHOT;
    const effective = maxClassification(
      request.payloadClassification ?? "public",
      snapshot.level,
    );

    const policyReasons: string[] = [];
    if (request.approval === "deny") {
      policyReasons.push(`Policy denies this ${request.feature} request.`);
    } else if (request.approval === "ask") {
      policyReasons.push(`This ${request.feature} request needs your approval.`);
    }

    const classificationReasons: string[] = [];
    if (request.capacity !== undefined && exceedsCapacity(effective, request.capacity)) {
      classificationReasons.push(
        `${effective} data exceeds the ${request.capacity} channel ceiling of ${capacityCeiling(request.capacity)}.`,
      );
    }

    const scanReasons = describeScan(request.scanReport);
    const scanAction = request.scanReport
      ? scanReportAction(request.scanReport)
      : "allow";
    const reasons = [
      ...policyReasons,
      ...classificationReasons,
      ...scanReasons,
    ];

    if (request.approval === "deny" || scanAction === "block") {
      return freezeResult({ allowed: false, interactionUsed, reasons });
    }

    const commitment = createCommitment(
      this.#classification,
      request.runId,
      snapshot,
    );
    const needsReview =
      request.approval === "ask" ||
      classificationReasons.length > 0 ||
      scanAction === "review";
    if (!needsReview) {
      return freezeResult({
        allowed: true,
        interactionUsed,
        reasons,
        commitment,
      });
    }
    if (interactionUsed) {
      return freezeResult({
        allowed: false,
        interactionUsed: true,
        reasons: [...reasons, SECOND_PROMPT_REASON],
      });
    }

    const kind =
      classificationReasons.length > 0 || scanReasons.length > 0
        ? "classification"
        : "tool_approval";
    const key = JSON.stringify([
      kind,
      request.pluginId,
      request.feature,
      request.runId ?? null,
      request.sessionId ?? null,
      request.toolCallId ?? null,
      reasons,
    ]);
    const existing = this.#inFlight.get(key);
    if (existing) {
      return await existing;
    }
    const pending = this.#prompt(request, kind, reasons, commitment);
    this.#inFlight.set(key, pending);
    try {
      return await pending;
    } finally {
      if (this.#inFlight.get(key) === pending) {
        this.#inFlight.delete(key);
      }
    }
  }

  async #prompt(
    request: AuthorizationRequest,
    kind: "tool_approval" | "classification",
    reasons: readonly string[],
    commitment: ClassificationCommitment,
  ): Promise<AuthorizationResult> {
    const wait = this.#interactions.requestSafety(
      {
        kind,
        title: request.title,
        prompt: buildPrompt(request, reasons),
        source: {
          pluginId: request.pluginId,
          feature: request.feature,
          runId: request.runId,
          sessionId: request.sessionId,
          toolCallId: request.toolCallId,
        },
      },
      request.signal,
    );
    request.onInteraction?.(wait.interaction.id);
    const response = await wait.response;
    const allowed =
      response.kind === "approval" && response.decision === "allow";
    if (!allowed) {
      return freezeResult({
        allowed: false,
        interactionUsed: true,
        reasons: [...reasons, USER_DENIED_REASON],
      });
    }
    return freezeResult({
      allowed: true,
      interactionUsed: true,
      reasons,
      commitment,
    });
  }
}

function describeScan(report: PromptScanReport | undefined): readonly string[] {
  if (!report) {
    return [];
  }
  const reasons: string[] = [];
  for (const finding of report.findings) {
    if (finding.action === "allow") {
      continue;
    }
    reasons.push(
      `Prompt scan ${finding.action === "block" ? "blocked" : "flagged"} ${report.stage} content: ${finding.reason} (${finding.scannerId}/${finding.code}).`,
    );
  }
  for (const failure of report.failures) {
    reasons.push(
      `Prompt scanner ${failure.scannerId} ${failure.kind === "timeout" ? "timed out" : "failed"}, so ${report.stage} coverage is ${report.coverage}: ${failure.message}`,
    );
  }
  if (report.coverage === "none" && report.failures.length === 0) {
    reasons.push(
      `No prompt scanner covers ${report.stage}, so it needs ${report.unavailableAction}.`,
    );
  }
  return reasons;
}

function createCommitment(
  classification: ClassificationService | undefined,
  runId: string | undefined,
  snapshot: ClassificationSnapshot,
): ClassificationCommitment {
  return Object.freeze({
    runId,
    level: snapshot.level,
    version: snapshot.version,
    recheck: () => {
      if (!classification || runId === undefined) {
        return true;
      }
      const current = classification.snapshot(runId);
      return (
        current.version === snapshot.version && current.level === snapshot.level
      );
    },
  });
}

function buildPrompt(
  request: AuthorizationRequest,
  reasons: readonly string[],
): string {
  const listed = reasons.slice(0, MAX_PROMPT_REASONS);
  const hidden = reasons.length - listed.length;
  const lines = [
    ...listed.map((reason) => `- ${reason}`),
    ...(hidden > 0 ? [`- and ${hidden} more reason(s).`] : []),
  ];
  const head = `Allow this ${request.feature} request to continue?`;
  return lines.length === 0 ? head : `${head}\n${lines.join("\n")}`;
}

function freezeResult(result: AuthorizationResult): AuthorizationResult {
  return Object.freeze({
    ...result,
    reasons: Object.freeze([...result.reasons]),
  });
}
