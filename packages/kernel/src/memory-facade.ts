import {
  dataClassificationSchema,
  personaIdSchema,
  type DataClassification,
} from "@borg/contracts";
import {
  z,
  type Disposable,
  type MemoryProviderContribution,
  type MemoryQuery,
  type MemoryRecord,
  type MemoryWriteInput,
} from "@borg/plugin-sdk";
import { randomUUID } from "node:crypto";

const DEFAULT_RECALL_LIMIT = 8;
const MAX_RECALL_LIMIT = 32;
const pluginIdSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:[.-][a-z0-9-]+)+$/);
const memoryRecordSchema = z
  .object({
    id: z.string().uuid(),
    kind: z.literal("semantic"),
    text: z.string().min(1),
    personaId: personaIdSchema,
    sessionId: z.string().min(1).optional(),
    classification: dataClassificationSchema,
    provenance: z
      .object({
        kind: z.literal("plugin"),
        id: pluginIdSchema,
      })
      .strict(),
    createdAt: z.string().datetime(),
  })
  .strict();
const memoryWriteInputSchema = z
  .object({
    text: z.string().min(1),
    personaId: personaIdSchema,
    sessionId: z.string().min(1).optional(),
    classification: dataClassificationSchema.optional(),
  })
  .strict();
const memoryQuerySchema = z
  .object({
    personaId: personaIdSchema,
    sessionId: z.string().min(1).optional(),
    text: z.string().min(1).optional(),
    limit: z.number().int().positive().max(MAX_RECALL_LIMIT).optional(),
  })
  .strict();

interface RegisteredMemoryProvider {
  readonly pluginId: string;
  readonly provider: MemoryProviderContribution;
}

function tokenize(value: string): readonly string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

function scoreText(recordText: string, queryText: string): number {
  if (queryText.length === 0) {
    return 0;
  }
  const haystack = recordText.toLowerCase();
  const needle = queryText.toLowerCase();
  let score = haystack.includes(needle) ? needle.length : 0;
  const queryTokens = new Set(tokenize(needle));
  if (queryTokens.size === 0) {
    return score;
  }
  for (const token of tokenize(haystack)) {
    if (queryTokens.has(token)) {
      score += 1;
    }
  }
  return score;
}

function inScope(record: MemoryRecord, query: MemoryQuery): boolean {
  if (record.personaId !== query.personaId) {
    return false;
  }
  if (query.sessionId === undefined) {
    return record.sessionId === undefined;
  }
  return (
    record.sessionId === undefined || record.sessionId === query.sessionId
  );
}

export class MemoryFacade {
  #provider: RegisteredMemoryProvider | undefined;

  hasProvider(): boolean {
    return this.#provider !== undefined;
  }

  registerProvider(
    pluginId: string,
    provider: MemoryProviderContribution,
  ): Disposable {
    const ownerPluginId = pluginIdSchema.parse(pluginId);
    if (
      typeof provider !== "object" ||
      provider === null ||
      typeof provider.write !== "function" ||
      typeof provider.retrieve !== "function"
    ) {
      throw new Error("Memory provider is invalid");
    }
    const providerId = pluginIdSchema.parse(provider.id);
    if (providerId !== ownerPluginId && !providerId.startsWith(`${ownerPluginId}.`)) {
      throw new Error(
        `Memory provider ${providerId} must use the ${ownerPluginId} namespace`,
      );
    }
    if (this.#provider) {
      throw new Error(
        `Memory provider is already registered by ${this.#provider.pluginId}`,
      );
    }
    const registration: RegisteredMemoryProvider = {
      pluginId: ownerPluginId,
      provider,
    };
    this.#provider = registration;
    return {
      dispose: () => {
        if (this.#provider === registration) {
          this.#provider = undefined;
        }
      },
    };
  }

  removePlugin(pluginId: string): void {
    if (this.#provider?.pluginId === pluginId) {
      this.#provider = undefined;
    }
  }

  async write(
    ownerPluginId: string,
    input: MemoryWriteInput,
  ): Promise<MemoryRecord> {
    const provider = this.#requireProvider();
    const parsed = memoryWriteInputSchema.parse(input);
    const classification: DataClassification =
      parsed.classification ?? "internal";
    const record = Object.freeze(
      memoryRecordSchema.parse({
        id: randomUUID(),
        kind: "semantic",
        text: parsed.text,
        personaId: parsed.personaId,
        ...(parsed.sessionId === undefined
          ? {}
          : { sessionId: parsed.sessionId }),
        classification,
        provenance: { kind: "plugin", id: pluginIdSchema.parse(ownerPluginId) },
        createdAt: new Date().toISOString(),
      }),
    );
    await provider.write(record);
    return record;
  }

  async retrieve(query: MemoryQuery): Promise<readonly MemoryRecord[]> {
    const provider = this.#requireProvider();
    const parsed = memoryQuerySchema.parse(query);
    const records = await provider.retrieve(parsed);
    if (!Array.isArray(records)) {
      throw new Error("Memory provider retrieve result is invalid");
    }
    const queryText = parsed.text ?? parsed.sessionId ?? "";
    const ranked = records
      .flatMap((candidate) => {
        const parsedRecord = memoryRecordSchema.safeParse(candidate);
        return parsedRecord.success && inScope(parsedRecord.data, parsed)
          ? [parsedRecord.data]
          : [];
      })
      .sort((left, right) => {
        const scoreDelta =
          scoreText(right.text, queryText) - scoreText(left.text, queryText);
        if (scoreDelta !== 0) {
          return scoreDelta;
        }
        const createdDelta = right.createdAt.localeCompare(left.createdAt);
        if (createdDelta !== 0) {
          return createdDelta;
        }
        return left.id.localeCompare(right.id);
      });
    const limit = parsed.limit ?? DEFAULT_RECALL_LIMIT;
    return Object.freeze(
      ranked.slice(0, limit).map((record) => Object.freeze(record)),
    );
  }

  #requireProvider(): MemoryProviderContribution {
    if (!this.#provider) {
      throw new Error("Memory provider is unavailable");
    }
    return this.#provider.provider;
  }
}
