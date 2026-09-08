export interface AzureUserErrorShape {
  readonly headline: string;
  readonly nextStep: string;
}

export interface AzureHttpErrorBody {
  readonly code?: string;
  readonly message?: string;
}

export class AzureUserError extends Error implements AzureUserErrorShape {
  readonly headline: string;
  readonly nextStep: string;

  constructor(parts: AzureUserErrorShape) {
    const headline = collapseWhitespace(parts.headline);
    const nextStep = collapseWhitespace(parts.nextStep);
    super(formatAzureUserError({ headline, nextStep }));
    this.name = "AzureUserError";
    this.headline = headline;
    this.nextStep = nextStep;
  }
}

export const SAFE_AZURE_ERRORS = Object.freeze({
  cancelled: Object.freeze({
    headline: "The Azure request was cancelled.",
    nextStep: "Try Verify and connect again.",
  }),
  timeout: Object.freeze({
    headline: "The Azure request timed out.",
    nextStep: "Check the network and endpoint, then try again.",
  }),
  missingKey: Object.freeze({
    headline: "Azure needs an API key.",
    nextStep: "Save an API key in Settings, then try Verify and connect again.",
  }),
  missingEndpoint: Object.freeze({
    headline: "Azure needs a resource endpoint.",
    nextStep:
      "Enter an Azure AI Foundry or Azure OpenAI https endpoint, then try again.",
  }),
  missingCredential: Object.freeze({
    headline: "Azure could not find credentials.",
    nextStep: "Run az login or azd auth login, or switch to an API key.",
  }),
  rejectedKey: Object.freeze({
    headline: "Azure rejected the credentials.",
    nextStep:
      "Replace the API key, or run az login, then try Verify and connect again.",
  }),
  rateLimited: Object.freeze({
    headline: "Azure rate-limited the request.",
    nextStep: "Wait a moment, then try Verify and connect again.",
  }),
  unavailable: Object.freeze({
    headline: "Azure is temporarily unavailable.",
    nextStep: "Wait a moment, then try Verify and connect again.",
  }),
  rejected: Object.freeze({
    headline: "Azure rejected the request.",
    nextStep: "Check the endpoint, API version, and deployment, then try again.",
  }),
  rejectedApiVersion: Object.freeze({
    headline: "Azure rejected the API version.",
    nextStep:
      "Try v1. Dated versions such as 2024-10-21 are not accepted on this endpoint.",
  }),
  protocol: Object.freeze({
    headline: "Azure returned an unreadable response.",
    nextStep: "Check the endpoint and API version, then try again.",
  }),
  unknownTool: Object.freeze({
    headline: "Azure returned an unknown tool.",
    nextStep: "Try the request again.",
  }),
  invalidEndpoint: Object.freeze({
    headline: "Azure endpoint must be an https resource URL.",
    nextStep: "Use an https Azure AI Foundry or Azure OpenAI endpoint.",
  }),
  emptyCatalog: Object.freeze({
    headline: "Azure returned no models.",
    nextStep:
      "Deploy a model in Azure AI Foundry or Azure OpenAI, then try Verify and connect again.",
  }),
});

export type AzureSafeErrorKey = keyof typeof SAFE_AZURE_ERRORS;

const KERNEL_CONNECT_FAILURE: AzureUserErrorShape = Object.freeze({
  headline: "Azure could not connect.",
  nextStep:
    "Check the endpoint, API version, and credentials, then try Verify and connect again.",
});

const SAFE_AZURE_ERROR_BY_MESSAGE: ReadonlyMap<string, AzureUserErrorShape> =
  new Map(
    Object.values(SAFE_AZURE_ERRORS).map((parts) => [
      formatAzureUserError(parts),
      parts,
    ]),
  );

export const SAFE_AZURE_ERROR_MESSAGES: ReadonlySet<string> = new Set(
  SAFE_AZURE_ERROR_BY_MESSAGE.keys(),
);

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function formatAzureUserError(parts: AzureUserErrorShape): string {
  return `${collapseWhitespace(parts.headline)}\n${collapseWhitespace(parts.nextStep)}`;
}

export function azureUserError(key: AzureSafeErrorKey): AzureUserError {
  return new AzureUserError(SAFE_AZURE_ERRORS[key]);
}

export function parseAzureUserError(message: string): AzureUserErrorShape {
  const trimmed = message.trim();
  const known = SAFE_AZURE_ERROR_BY_MESSAGE.get(trimmed);
  if (known) {
    return known;
  }
  if (isKernelCommandMessage(trimmed)) {
    return KERNEL_CONNECT_FAILURE;
  }
  const split = trimmed.search(/\r?\n/);
  if (split > 0) {
    const headline = collapseWhitespace(trimmed.slice(0, split));
    const nextStep = collapseWhitespace(trimmed.slice(split + 1));
    if (headline.length > 0 && nextStep.length > 0) {
      return { headline, nextStep };
    }
  }
  if (trimmed.length > 0) {
    return {
      headline: collapseWhitespace(trimmed),
      nextStep: SAFE_AZURE_ERRORS.rejected.nextStep,
    };
  }
  return KERNEL_CONNECT_FAILURE;
}

export function parseAzureErrorBody(payload: unknown): AzureHttpErrorBody {
  if (!isRecord(payload)) {
    return {};
  }
  const error = isRecord(payload.error) ? payload.error : payload;
  const inner = isRecord(error.innererror) ? error.innererror : undefined;
  const code =
    asNonEmptyString(error.code) ?? asNonEmptyString(inner?.code);
  const message =
    asNonEmptyString(error.message) ?? asNonEmptyString(payload.message);
  return {
    ...(code === undefined ? {} : { code }),
    ...(message === undefined ? {} : { message }),
  };
}

export function azureErrorLooksLikeApiVersion(
  body: AzureHttpErrorBody,
): boolean {
  return /api[\s._-]*version/i.test(`${body.code ?? ""} ${body.message ?? ""}`);
}

export function classifyAzureStatus(
  status: number,
  body?: unknown,
): AzureUserError {
  if (status === 401 || status === 403) {
    return azureUserError("rejectedKey");
  }
  if (status === 429) {
    return azureUserError("rateLimited");
  }
  if (status === 400) {
    if (azureErrorLooksLikeApiVersion(parseAzureErrorBody(body))) {
      return azureUserError("rejectedApiVersion");
    }
    return azureUserError("rejected");
  }
  if (status === 529 || status >= 500) {
    return azureUserError("unavailable");
  }
  return azureUserError("rejected");
}

function isKernelCommandMessage(message: string): boolean {
  return /^Command \S+ (failed|was cancelled|exceeded its \d+ms timeout)$/.test(
    message,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
