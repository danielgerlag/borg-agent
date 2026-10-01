import { z } from "zod";
import {
  CONNECTOR_ACCOUNT_ID_MAX,
  DEFAULT_CONNECTOR_ACCOUNT_ID,
  connectorAccountIdSchema,
} from "./index";

export const MAX_CONNECTOR_ACCOUNTS = 8;
export const CONNECTOR_ACCOUNT_NAME_MAX = 80;

export const connectorAccountNameSchema = z
  .string()
  .min(1)
  .max(CONNECTOR_ACCOUNT_NAME_MAX);

export const connectorCommandInputSchema = z
  .object({
    accountId: connectorAccountIdSchema.optional(),
  })
  .strict();

export type ConnectorCommandInput = z.input<typeof connectorCommandInputSchema>;

export function slugifyConnectorAccountName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, CONNECTOR_ACCOUNT_ID_MAX)
    .replace(/-+$/g, "");
}

export function allocateConnectorAccountId(
  name: string,
  taken: readonly string[],
): string {
  const takenSet = new Set(taken);
  takenSet.add(DEFAULT_CONNECTOR_ACCOUNT_ID);
  let base = slugifyConnectorAccountName(name);
  if (base.length === 0) {
    base = "account";
  }
  if (!takenSet.has(base) && connectorAccountIdSchema.safeParse(base).success) {
    return base;
  }
  for (let n = 2; n < Number.MAX_SAFE_INTEGER; n += 1) {
    const suffix = `-${n}`;
    const truncated = base
      .slice(0, CONNECTOR_ACCOUNT_ID_MAX - suffix.length)
      .replace(/-+$/g, "");
    const candidate = `${truncated.length > 0 ? truncated : "account"}${suffix}`;
    if (
      !takenSet.has(candidate) &&
      connectorAccountIdSchema.safeParse(candidate).success
    ) {
      return candidate;
    }
  }
  throw new Error("Connector account id is invalid");
}
