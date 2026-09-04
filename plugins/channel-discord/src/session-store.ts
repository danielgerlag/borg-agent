import { z, type PluginLogger, type PluginStore } from "@borg/plugin-sdk";
import { MAX_RESUME_URL_LENGTH, MAX_SESSION_ID_LENGTH, normalizeGatewayUrl } from "./protocol";
import type { GatewaySessionRecord } from "./gateway";

export const GATEWAY_SESSION_KEY = "gateway/session";

/**
 * Only resume coordinates are persisted. The bot token stays in the secret
 * store and never reaches the plugin store.
 */
const storedSessionSchema = z
  .object({
    version: z.literal(1),
    sessionId: z
      .string()
      .min(1)
      .max(MAX_SESSION_ID_LENGTH)
      .refine((value) => !/[\s\0]/.test(value)),
    sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    resumeGatewayUrl: z.string().min(1).max(MAX_RESUME_URL_LENGTH),
  })
  .strict();

export interface GatewaySessionStore {
  load(): Promise<GatewaySessionRecord | undefined>;
  save(record: GatewaySessionRecord | null): Promise<void>;
}

export function createGatewaySessionStore(
  store: PluginStore,
  logger: PluginLogger,
): GatewaySessionStore {
  return {
    async load(): Promise<GatewaySessionRecord | undefined> {
      let stored: unknown;
      try {
        stored = await store.get(GATEWAY_SESSION_KEY);
      } catch {
        logger.warn("Discord gateway session could not be read");
        return undefined;
      }
      if (stored === undefined) {
        return undefined;
      }
      const parsed = storedSessionSchema.safeParse(stored);
      const resumeGatewayUrl = parsed.success
        ? normalizeGatewayUrl(parsed.data.resumeGatewayUrl)
        : undefined;
      if (!parsed.success || resumeGatewayUrl === undefined) {
        logger.warn("Discord gateway session was discarded as invalid");
        await store.delete(GATEWAY_SESSION_KEY).catch(() => undefined);
        return undefined;
      }
      return {
        sessionId: parsed.data.sessionId,
        sequence: parsed.data.sequence,
        resumeGatewayUrl,
      };
    },
    async save(record: GatewaySessionRecord | null): Promise<void> {
      if (record === null) {
        await store.delete(GATEWAY_SESSION_KEY);
        return;
      }
      await store.set(GATEWAY_SESSION_KEY, {
        version: 1,
        sessionId: record.sessionId,
        sequence: record.sequence,
        resumeGatewayUrl: record.resumeGatewayUrl,
      });
    },
  };
}
