import {
  promptScanFindingSchema,
  promptScanStageSchema,
  type PromptScanAction,
  type PromptScanFinding,
  type PromptScanStage,
} from "@borg/contracts";
import type {
  Disposable,
  PromptScanContext,
  PromptScannerContribution,
} from "@borg/plugin-sdk";

const SCANNER_ID = /^[a-z0-9]+(?:[.-][a-z0-9-]+)*$/;
const MAX_SCANNER_ID_LENGTH = 200;

export const MAX_SCAN_TEXT_LENGTH = 65_536;
export const MAX_SCAN_FINDINGS = 64;
export const DEFAULT_SCANNER_TIMEOUT_MS = 2_000;

const MAX_SCANNER_CANDIDATES = MAX_SCAN_FINDINGS * 8;

export const UNAVAILABLE_SCAN_ACTION = "review" as const;

export type PromptScanCoverage = "complete" | "partial" | "none";

export interface PromptScanFindingRecord extends PromptScanFinding {
  readonly scannerId: string;
}

export interface PromptScanFailure {
  readonly scannerId: string;
  readonly kind: "timeout" | "error" | "invalid";
  readonly message: string;
}

export interface PromptScanReport {
  readonly stage: PromptScanStage;
  readonly findings: readonly PromptScanFindingRecord[];
  readonly failures: readonly PromptScanFailure[];
  readonly coverage: PromptScanCoverage;
  readonly truncated: boolean;
  readonly unavailableAction: typeof UNAVAILABLE_SCAN_ACTION;
}

export interface PromptScanRequest {
  readonly stage: PromptScanStage;
  readonly text: string;
  readonly source: PromptScanContext["source"];
  readonly runId?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface ScannerRegistryOptions {
  readonly timeoutMs?: number | undefined;
}

interface RegisteredScanner {
  readonly pluginId: string;
  readonly scanner: PromptScannerContribution;
  readonly stages: ReadonlySet<PromptScanStage>;
  readonly controller: AbortController;
}

interface ScannerOutcome {
  readonly findings: readonly PromptScanFindingRecord[];
  readonly failure?: PromptScanFailure | undefined;
}

class PromptScanTimeoutError extends Error {
  constructor(scannerId: string, timeoutMs: number) {
    super(`Prompt scanner ${scannerId} timed out after ${timeoutMs}ms`);
    this.name = "PromptScanTimeoutError";
  }
}

const ACTION_SEVERITY: Readonly<Record<PromptScanAction, number>> = Object.freeze(
  { block: 0, review: 1, allow: 2 },
);

export function scanReportAction(report: PromptScanReport): PromptScanAction {
  if (report.findings.some(({ action }) => action === "block")) {
    return "block";
  }
  if (report.findings.some(({ action }) => action === "review")) {
    return "review";
  }
  if (report.coverage !== "complete") {
    return report.unavailableAction;
  }
  return "allow";
}

export class ScannerRegistry {
  readonly #scanners = new Map<string, RegisteredScanner>();
  readonly #timeoutMs: number;

  constructor(options: ScannerRegistryOptions = {}) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_SCANNER_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) {
      throw new Error("Prompt scanner timeout is invalid");
    }
    this.#timeoutMs = timeoutMs;
  }

  register(pluginId: string, scanner: PromptScannerContribution): Disposable {
    if (typeof pluginId !== "string" || pluginId.length === 0) {
      throw new Error("Prompt scanner owner is invalid");
    }
    if (
      typeof scanner?.id !== "string" ||
      !SCANNER_ID.test(scanner.id) ||
      scanner.id.length > MAX_SCANNER_ID_LENGTH ||
      typeof scanner.scan !== "function"
    ) {
      throw new Error(`Invalid prompt scanner contribution ${String(scanner?.id)}`);
    }
    if (scanner.id !== pluginId && !scanner.id.startsWith(`${pluginId}.`)) {
      throw new Error(
        `Prompt scanner ${scanner.id} must use the ${pluginId} namespace`,
      );
    }
    if (!Array.isArray(scanner.stages) || scanner.stages.length === 0) {
      throw new Error(`Prompt scanner ${scanner.id} declares no stages`);
    }
    const stages = new Set<PromptScanStage>();
    for (const candidate of scanner.stages) {
      const parsed = promptScanStageSchema.safeParse(candidate);
      if (!parsed.success) {
        throw new Error(
          `Prompt scanner ${scanner.id} declares unknown stage ${String(candidate)}`,
        );
      }
      if (stages.has(parsed.data)) {
        throw new Error(
          `Prompt scanner ${scanner.id} declares stage ${parsed.data} twice`,
        );
      }
      stages.add(parsed.data);
    }
    if (this.#scanners.has(scanner.id)) {
      throw new Error(`Prompt scanner ${scanner.id} is already registered`);
    }
    const scannerId = scanner.id;
    const registration: RegisteredScanner = {
      pluginId,
      scanner: Object.freeze({
        id: scannerId,
        stages: Object.freeze([...stages]),
        scan: scanner.scan.bind(scanner),
      }),
      stages,
      controller: new AbortController(),
    };
    this.#scanners.set(scannerId, registration);
    return {
      dispose: () => {
        if (this.#scanners.get(scannerId) === registration) {
          this.#remove(scannerId, registration);
        }
      },
    };
  }

  removePlugin(pluginId: string): void {
    for (const [scannerId, registration] of [...this.#scanners]) {
      if (registration.pluginId === pluginId) {
        this.#remove(scannerId, registration);
      }
    }
  }

  listScanners(stage?: PromptScanStage): readonly string[] {
    return [...this.#scanners.values()]
      .filter(
        (registration) => stage === undefined || registration.stages.has(stage),
      )
      .map(({ scanner }) => scanner.id)
      .sort((left, right) => left.localeCompare(right));
  }

  async scan(request: PromptScanRequest): Promise<PromptScanReport> {
    const stage = promptScanStageSchema.parse(request.stage);
    request.signal?.throwIfAborted();

    const text = typeof request.text === "string" ? request.text : "";
    const truncated = text.length > MAX_SCAN_TEXT_LENGTH;
    const bounded = truncated ? text.slice(0, MAX_SCAN_TEXT_LENGTH) : text;
    const selected = [...this.#scanners.values()].filter((registration) =>
      registration.stages.has(stage),
    );
    if (selected.length === 0) {
      return freezeReport({
        stage,
        findings: [],
        failures: [],
        coverage: "none",
        truncated,
        unavailableAction: UNAVAILABLE_SCAN_ACTION,
      });
    }

    const outcomes = await Promise.all(
      selected.map((registration) =>
        this.#runScanner(registration, stage, bounded, truncated, request),
      ),
    );
    request.signal?.throwIfAborted();

    const failures = outcomes.flatMap(({ failure }) =>
      failure ? [failure] : [],
    );
    const healthy = outcomes.filter(({ failure }) => failure === undefined).length;
    const scannedCoverage: PromptScanCoverage =
      healthy === 0 ? "none" : failures.length > 0 ? "partial" : "complete";
    const coverage: PromptScanCoverage =
      truncated && scannedCoverage === "complete" ? "partial" : scannedCoverage;

    const findings = outcomes
      .flatMap(({ findings: scanned }) => scanned)
      .sort(
        (left, right) =>
          ACTION_SEVERITY[left.action] - ACTION_SEVERITY[right.action],
      )
      .slice(0, MAX_SCAN_FINDINGS);

    return freezeReport({
      stage,
      findings,
      failures,
      coverage,
      truncated,
      unavailableAction: UNAVAILABLE_SCAN_ACTION,
    });
  }

  async #runScanner(
    registration: RegisteredScanner,
    stage: PromptScanStage,
    text: string,
    truncated: boolean,
    request: PromptScanRequest,
  ): Promise<ScannerOutcome> {
    const scannerId = registration.scanner.id;
    const timeout = new AbortController();
    const signal = AbortSignal.any([
      ...(request.signal ? [request.signal] : []),
      registration.controller.signal,
      timeout.signal,
    ]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new PromptScanTimeoutError(scannerId, this.#timeoutMs);
        timeout.abort(error);
        reject(error);
      }, this.#timeoutMs);
    });
    const context: PromptScanContext = {
      stage,
      text,
      truncated,
      source: request.source,
      runId: request.runId,
      sessionId: request.sessionId,
      signal,
    };
    try {
      const pending = Promise.resolve().then(() =>
        registration.scanner.scan(context),
      );
      // The loser of the race still settles; keep it from going unhandled.
      pending.catch(() => {});
      const raw = await Promise.race([pending, deadline]);
      return parseFindings(scannerId, raw);
    } catch (error) {
      return {
        findings: [],
        failure: Object.freeze({
          scannerId,
          kind:
            error instanceof PromptScanTimeoutError
              ? ("timeout" as const)
              : ("error" as const),
          message:
            error instanceof PromptScanTimeoutError
              ? error.message
              : `Prompt scanner ${scannerId} failed`,
        }),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  #remove(scannerId: string, registration: RegisteredScanner): void {
    this.#scanners.delete(scannerId);
    registration.controller.abort(
      new Error(`Prompt scanner ${scannerId} was unregistered`),
    );
  }
}

function parseFindings(scannerId: string, raw: unknown): ScannerOutcome {
  if (!Array.isArray(raw)) {
    return {
      findings: [],
      failure: Object.freeze({
        scannerId,
        kind: "invalid" as const,
        message: `Prompt scanner ${scannerId} did not return findings`,
      }),
    };
  }
  const parsedFindings: PromptScanFindingRecord[] = [];
  let rejected = 0;
  // Parse a bounded window, then keep the most severe: a scanner cannot bury a
  // block behind filler findings.
  for (const candidate of raw.slice(0, MAX_SCANNER_CANDIDATES)) {
    const parsed = promptScanFindingSchema.safeParse(candidate);
    if (!parsed.success) {
      rejected += 1;
      continue;
    }
    parsedFindings.push(
      Object.freeze({
        scannerId,
        code: parsed.data.code,
        action: parsed.data.action,
        reason: parsed.data.reason,
        ...(parsed.data.evidence !== undefined
          ? { evidence: parsed.data.evidence }
          : {}),
      }),
    );
  }
  const findings = parsedFindings
    .sort(
      (left, right) =>
        ACTION_SEVERITY[left.action] - ACTION_SEVERITY[right.action],
    )
    .slice(0, MAX_SCAN_FINDINGS);
  const overflow = raw.length - MAX_SCAN_FINDINGS;
  if (rejected === 0 && overflow <= 0) {
    return { findings };
  }
  const parts = [
    ...(rejected > 0 ? [`${rejected} malformed finding(s)`] : []),
    ...(overflow > 0 ? [`${overflow} finding(s) over the ${MAX_SCAN_FINDINGS} cap`] : []),
  ];
  return {
    findings,
    failure: Object.freeze({
      scannerId,
      kind: "invalid" as const,
      message: `Prompt scanner ${scannerId} returned ${parts.join(" and ")}`,
    }),
  };
}

function freezeReport(report: PromptScanReport): PromptScanReport {
  return Object.freeze({
    ...report,
    findings: Object.freeze([...report.findings]),
    failures: Object.freeze([...report.failures]),
  });
}
