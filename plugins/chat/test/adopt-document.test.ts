import { emptyChatUsage, type ChatEntry } from "@borg/contracts";
import { describe, expect, it } from "vitest";
import { adoptChatDocument } from "../src/adopt-document";

type ChatDocument = Parameters<typeof adoptChatDocument>[0]["next"];

const sessionId = "11111111-1111-4111-8111-111111111111";
const otherSessionId = "22222222-2222-4222-8222-222222222222";

function entry(
  id: string,
  content: string,
  role: ChatEntry["role"] = "event",
): ChatEntry {
  return {
    id,
    role,
    content,
    createdAt: "2026-09-05T00:00:00.000Z",
  };
}

function documentFor(
  id: string,
  entries: ChatEntry[],
  status: ChatDocument["session"]["status"] = "running",
): ChatDocument {
  return {
    session: {
      id,
      title: "Chat",
      personaId: "system/general",
      status,
      createdAt: "2026-09-05T00:00:00.000Z",
      updatedAt: "2026-09-05T00:00:01.000Z",
      usage: emptyChatUsage,
    },
    entries,
  };
}

describe("adoptChatDocument", () => {
  it("keeps prior entry objects when a later refresh adds a row", () => {
    const started = entry(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      'Graph “Quick start” started.',
    );
    const completed = entry(
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      'Graph “Quick start” completed.',
    );
    const current = documentFor(sessionId, [started]);
    const next = documentFor(sessionId, [{ ...started }, completed], "idle");

    const adopted = adoptChatDocument({ current, next });

    expect(adopted.entries[0]).toBe(started);
    expect(adopted.entries[1]).toBe(completed);
    expect(adopted.session).toBe(next.session);
  });

  it("replaces an entry when its content changes", () => {
    const prior = entry(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "Waiting for input",
    );
    const updated = entry(prior.id, "Input received");
    const adopted = adoptChatDocument({
      current: documentFor(sessionId, [prior]),
      next: documentFor(sessionId, [updated]),
    });

    expect(adopted.entries[0]).toBe(updated);
  });

  it("does not reuse entries across sessions", () => {
    const started = entry(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      'Graph “Quick start” started.',
    );
    const adopted = adoptChatDocument({
      current: documentFor(sessionId, [started]),
      next: documentFor(otherSessionId, [{ ...started }]),
    });

    expect(adopted.entries[0]).not.toBe(started);
  });
});
