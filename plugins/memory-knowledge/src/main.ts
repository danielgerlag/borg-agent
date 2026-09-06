import {
  definePlugin,
  z,
  type JsonValue,
  type MemoryQuery,
  type MemoryRecord,
} from "@borg/plugin-sdk";

const RECORD_PREFIX = "records/";

const memoryRecordSchema = z
  .object({
    id: z.string().uuid(),
    kind: z.literal("semantic"),
    text: z.string().min(1),
    personaId: z.string().min(1),
    sessionId: z.string().min(1).optional(),
    classification: z.enum([
      "public",
      "internal",
      "confidential",
      "restricted",
    ]),
    provenance: z
      .object({
        kind: z.literal("plugin"),
        id: z.string().min(1),
      })
      .strict(),
    createdAt: z.string().datetime(),
  })
  .strict();

function asJsonValue(value: MemoryRecord): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

export default definePlugin({
  id: "borg.memory.knowledge",
  version: "0.1.0",
  engines: {
    borg: "^0.1.0",
  },
  permissions: ["memory.provide"],
  contributes: {
    kinds: ["memoryProvider"],
  },
  activate(context) {
    return context.memory.registerProvider({
      id: "borg.memory.knowledge",
      async write(record) {
        await context.store.set(
          `${RECORD_PREFIX}${record.id}`,
          asJsonValue(record),
        );
      },
      async retrieve(query: MemoryQuery) {
        const entries = await context.store.list(RECORD_PREFIX);
        return entries.flatMap((entry) => {
          const parsed = memoryRecordSchema.safeParse(entry.value);
          if (!parsed.success || parsed.data.personaId !== query.personaId) {
            return [];
          }
          if (
            query.sessionId !== undefined &&
            parsed.data.sessionId !== undefined &&
            parsed.data.sessionId !== query.sessionId
          ) {
            return [];
          }
          return [parsed.data];
        });
      },
    });
  },
});
