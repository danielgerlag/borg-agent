import { chatDocumentSchema, type ChatEntry } from "@borg/contracts";

type ChatDocument = ReturnType<typeof chatDocumentSchema.parse>;

function reusableEntry(
  previous: ChatEntry | undefined,
  next: ChatEntry,
): ChatEntry {
  if (
    previous !== undefined &&
    previous.role === next.role &&
    previous.content === next.content &&
    previous.createdAt === next.createdAt
  ) {
    return previous;
  }
  return next;
}

export function adoptChatDocument(input: {
  readonly current: ChatDocument | undefined;
  readonly next: ChatDocument;
}): ChatDocument {
  const { current, next } = input;
  if (current === undefined || current.session.id !== next.session.id) {
    return next;
  }
  const previous = new Map(
    current.entries.map((entry) => [entry.id, entry]),
  );
  return {
    session: next.session,
    entries: next.entries.map((entry) =>
      reusableEntry(previous.get(entry.id), entry),
    ),
  };
}
