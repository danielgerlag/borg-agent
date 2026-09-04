import { MAX_DIAGNOSTIC_CHARS } from "./protocol";

export function redactSecrets(
  text: string,
  secrets: readonly string[],
): string {
  let result = text;
  for (const secret of secrets) {
    if (secret.length > 0) {
      result = result.split(secret).join("[redacted]");
    }
  }
  return result;
}

export function boundDiagnostic(
  text: string,
  secrets: readonly string[] = [],
): string {
  const redacted = redactSecrets(text, secrets).replace(/\s+/g, " ").trim();
  if (redacted.length <= MAX_DIAGNOSTIC_CHARS) {
    return redacted;
  }
  return `${redacted.slice(0, MAX_DIAGNOSTIC_CHARS)}…`;
}

export function safeErrorMessage(
  error: unknown,
  secrets: readonly string[] = [],
): string {
  if (error instanceof Error) {
    const message = boundDiagnostic(error.message, secrets);
    return message.length > 0 ? message : "MCP request failed";
  }
  return "MCP request failed";
}

export function assertNoSecrets(
  value: unknown,
  secrets: readonly string[],
): void {
  if (secrets.length === 0) {
    return;
  }
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  if (serialized === undefined) {
    return;
  }
  for (const secret of secrets) {
    if (secret.length > 0 && serialized.includes(secret)) {
      throw new Error("Secret value leaked into a public MCP surface");
    }
  }
}
