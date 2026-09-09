import { z, type JsonValue } from "@borg/plugin-sdk";
import type { StoreFacade } from "./persistence";

const STORE_NAMESPACE = "kernel.approval-grants";
const ALWAYS_PREFIX = "always/";

const alwaysGrantSchema = z
  .object({
    pluginId: z.string().min(1),
    feature: z.string().min(1),
    grantId: z.string().min(1),
  })
  .strict();

export type ApprovalDuration = "once" | "session" | "always";

export interface ApprovalGrantKey {
  readonly pluginId: string;
  readonly feature: string;
  readonly grantId: string;
  readonly sessionId?: string | undefined;
}

function alwaysKey(grant: ApprovalGrantKey): string {
  return `${ALWAYS_PREFIX}${encodeURIComponent(grant.pluginId)}/${encodeURIComponent(grant.feature)}/${encodeURIComponent(grant.grantId)}`;
}

function sessionKey(grant: ApprovalGrantKey): string | undefined {
  if (!grant.sessionId) {
    return undefined;
  }
  return `session:${grant.sessionId}:${grant.pluginId}:${grant.feature}:${grant.grantId}`;
}

export class ApprovalGrantStore {
  readonly #session = new Set<string>();
  readonly #always = new Set<string>();
  readonly #store: StoreFacade | undefined;
  #loaded = false;

  constructor(store?: StoreFacade) {
    this.#store = store;
  }

  async has(grant: ApprovalGrantKey): Promise<boolean> {
    await this.#ensureLoaded();
    const session = sessionKey(grant);
    return (
      this.#always.has(alwaysKey(grant)) ||
      (session !== undefined && this.#session.has(session))
    );
  }

  async remember(
    grant: ApprovalGrantKey,
    duration: ApprovalDuration,
  ): Promise<void> {
    if (duration === "once") {
      return;
    }
    await this.#ensureLoaded();
    if (duration === "session") {
      const session = sessionKey(grant);
      if (session) {
        this.#session.add(session);
      }
      return;
    }
    const key = alwaysKey(grant);
    this.#always.add(key);
    await this.#store?.set(
      STORE_NAMESPACE,
      key,
      alwaysGrantSchema.parse({
        pluginId: grant.pluginId,
        feature: grant.feature,
        grantId: grant.grantId,
      }) as JsonValue,
    );
  }

  async #ensureLoaded(): Promise<void> {
    if (this.#loaded) {
      return;
    }
    this.#loaded = true;
    if (!this.#store) {
      return;
    }
    const entries = await this.#store.list(STORE_NAMESPACE, ALWAYS_PREFIX);
    for (const entry of entries) {
      const parsed = alwaysGrantSchema.safeParse(entry.value);
      if (!parsed.success) {
        continue;
      }
      this.#always.add(alwaysKey(parsed.data));
    }
  }
}
