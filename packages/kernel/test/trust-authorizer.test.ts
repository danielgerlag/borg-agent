import { describe, expect, it, vi } from "vitest";
import { ClassificationService } from "../src/classification-service";
import { ScannerRegistry } from "../src/scanner-registry";
import { InteractionService } from "../src/interaction-service";
import {
  TrustAuthorizer,
  type AuthorizationRequest,
} from "../src/trust-authorizer";

function baseRequest(
  overrides: Partial<AuthorizationRequest> = {},
): AuthorizationRequest {
  return {
    pluginId: "borg.chat",
    feature: "tool",
    title: "Approve tools.echo",
    approval: "auto",
    ...overrides,
  };
}

async function reportFor(
  findings: readonly Record<string, unknown>[],
  stage: "tool_result" | "user_input" = "tool_result",
) {
  const registry = new ScannerRegistry();
  registry.register("borg.security", {
    id: "borg.security.injection",
    stages: [stage],
    scan: async () => findings as never,
  });
  return await registry.scan({
    stage,
    text: "tool output",
    source: { kind: "tool", id: "tools.fetch" },
  });
}

async function emptyReport(stage: "tool_result" = "tool_result") {
  return await new ScannerRegistry().scan({
    stage,
    text: "tool output",
    source: { kind: "tool", id: "tools.fetch" },
  });
}

function approveFirst(interactions: InteractionService): void {
  const pending = interactions.listPending();
  interactions.respond(pending[0]!.id, { kind: "approval", decision: "allow" });
}

describe("TrustAuthorizer decisions without a prompt", () => {
  it("allows an auto request and hands back a commitment", async () => {
    const interactions = new InteractionService();
    const classification = new ClassificationService();
    classification.openRun("run-a");
    const authorizer = new TrustAuthorizer(interactions, { classification });

    const result = await authorizer.authorize(
      baseRequest({ runId: "run-a", capacity: "internal" }),
    );
    expect(result).toMatchObject({
      allowed: true,
      interactionUsed: false,
      reasons: [],
    });
    expect(result.commitment).toMatchObject({
      runId: "run-a",
      level: "internal",
      version: 1,
    });
    expect(interactions.listPending()).toEqual([]);
  });

  it("denies a deny policy with no new interaction", async () => {
    const interactions = new InteractionService();
    const authorizer = new TrustAuthorizer(interactions);

    const result = await authorizer.authorize(
      baseRequest({ approval: "deny" }),
    );
    expect(result.allowed).toBe(false);
    expect(result.interactionUsed).toBe(false);
    expect(result.reasons).toEqual(["Policy denies this tool request."]);
    expect(interactions.listPending()).toEqual([]);
  });

  it("denies a scan block with no new interaction", async () => {
    const interactions = new InteractionService();
    const authorizer = new TrustAuthorizer(interactions);
    const scanReport = await reportFor([
      {
        code: "injection.exfiltration",
        action: "block",
        reason: "Text tries to exfiltrate secrets",
      },
    ]);

    const result = await authorizer.authorize(
      baseRequest({ approval: "ask", scanReport }),
    );
    expect(result.allowed).toBe(false);
    expect(result.reasons).toEqual([
      "This tool request needs your approval.",
      "Prompt scan blocked tool_result content: Text tries to exfiltrate secrets (borg.security.injection/injection.exfiltration).",
    ]);
    expect(interactions.listPending()).toEqual([]);
  });

  it("denies instead of prompting twice when an interaction was already used", async () => {
    const interactions = new InteractionService();
    const authorizer = new TrustAuthorizer(interactions);
    const scanReport = await reportFor([
      {
        code: "injection.instruction-override",
        action: "review",
        reason: "Text asks the agent to ignore instructions",
      },
    ]);

    const result = await authorizer.authorize(
      baseRequest({ scanReport, interactionUsed: true }),
    );
    expect(result.allowed).toBe(false);
    expect(result.interactionUsed).toBe(true);
    expect(result.reasons.at(-1)).toMatch(/only ask you once/);
    expect(interactions.listPending()).toEqual([]);
  });
});

describe("TrustAuthorizer prompts", () => {
  it("asks once for a plain tool approval", async () => {
    const interactions = new InteractionService();
    const authorizer = new TrustAuthorizer(interactions);
    const seen: string[] = [];

    const pending = authorizer.authorize(
      baseRequest({
        approval: "ask",
        runId: "run-a",
        sessionId: "session-a",
        toolCallId: "call-1",
        onInteraction: (id) => seen.push(id),
      }),
    );
    await vi.waitFor(() => expect(interactions.listPending()).toHaveLength(1));
    const [interaction] = interactions.listPending();
    expect(interaction).toMatchObject({
      kind: "tool_approval",
      title: "Approve tools.echo",
      source: {
        pluginId: "borg.chat",
        feature: "tool",
        runId: "run-a",
        sessionId: "session-a",
        toolCallId: "call-1",
      },
    });
    expect(seen).toEqual([interaction!.id]);

    approveFirst(interactions);
    await expect(pending).resolves.toMatchObject({
      allowed: true,
      interactionUsed: true,
    });
  });

  it("combines an approval and a classification breach into one classification prompt", async () => {
    const interactions = new InteractionService();
    const classification = new ClassificationService();
    classification.openRun("run-a");
    classification.raise("run-a", "confidential", "read a secret");
    const authorizer = new TrustAuthorizer(interactions, { classification });

    const pending = authorizer.authorize(
      baseRequest({ approval: "ask", runId: "run-a", capacity: "public" }),
    );
    await vi.waitFor(() => expect(interactions.listPending()).toHaveLength(1));
    const [interaction] = interactions.listPending();
    expect(interaction?.kind).toBe("classification");
    expect(interaction?.prompt).toContain("This tool request needs your approval.");
    expect(interaction?.prompt).toContain(
      "confidential data exceeds the public channel ceiling of public.",
    );

    approveFirst(interactions);
    const result = await pending;
    expect(result.allowed).toBe(true);
    expect(result.reasons).toHaveLength(2);
    expect(interactions.listPending()).toEqual([]);
  });

  it("reviews restricted data on a public channel instead of hard-blocking it", async () => {
    const interactions = new InteractionService();
    const authorizer = new TrustAuthorizer(interactions);

    const pending = authorizer.authorize(
      baseRequest({ payloadClassification: "restricted", capacity: "public" }),
    );
    await vi.waitFor(() => expect(interactions.listPending()).toHaveLength(1));
    expect(interactions.listPending()[0]?.kind).toBe("classification");
    approveFirst(interactions);
    await expect(pending).resolves.toMatchObject({
      allowed: true,
      interactionUsed: true,
    });
  });

  it("reviews degraded scanner coverage as a classification decision", async () => {
    const interactions = new InteractionService();
    const authorizer = new TrustAuthorizer(interactions);
    const scanReport = await emptyReport();
    const seen: string[] = [];

    const pending = authorizer.authorize(
      baseRequest({
        scanReport,
        onInteraction: (id) => seen.push(id),
      }),
    );
    await vi.waitFor(() => expect(interactions.listPending()).toHaveLength(1));
    expect(interactions.listPending()[0]?.kind).toBe("classification");
    expect(interactions.listPending()[0]?.prompt).toContain(
      "No prompt scanner covers tool_result",
    );
    expect(seen).toHaveLength(1);
    approveFirst(interactions);
    await expect(pending).resolves.toMatchObject({ allowed: true });
  });

  it("honours a user denial", async () => {
    const interactions = new InteractionService();
    const authorizer = new TrustAuthorizer(interactions);

    const pending = authorizer.authorize(baseRequest({ approval: "ask" }));
    await vi.waitFor(() => expect(interactions.listPending()).toHaveLength(1));
    interactions.respond(interactions.listPending()[0]!.id, {
      kind: "approval",
      decision: "deny",
    });
    const result = await pending;
    expect(result.allowed).toBe(false);
    expect(result.interactionUsed).toBe(true);
    expect(result.reasons.at(-1)).toBe("You denied this request.");
    expect(result.commitment).toBeUndefined();
  });

  it("shares one prompt between duplicate concurrent authorizations", async () => {
    const interactions = new InteractionService();
    const authorizer = new TrustAuthorizer(interactions);
    const request = baseRequest({
      approval: "ask",
      runId: "run-a",
      toolCallId: "call-1",
    });

    const first = authorizer.authorize(request);
    const second = authorizer.authorize(request);
    await vi.waitFor(() => expect(interactions.listPending()).toHaveLength(1));
    approveFirst(interactions);

    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { allowed: true, interactionUsed: true },
      { allowed: true, interactionUsed: true },
    ]);
    expect(interactions.listPending()).toEqual([]);

    const third = authorizer.authorize(request);
    await vi.waitFor(() => expect(interactions.listPending()).toHaveLength(1));
    approveFirst(interactions);
    await expect(third).resolves.toMatchObject({ allowed: true });
  });

  it("does not share a prompt across distinct tool call ids", async () => {
    const interactions = new InteractionService();
    const authorizer = new TrustAuthorizer(interactions);
    const first = authorizer.authorize(
      baseRequest({ approval: "ask", runId: "run-a", toolCallId: "call-1" }),
    );
    const second = authorizer.authorize(
      baseRequest({ approval: "ask", runId: "run-a", toolCallId: "call-2" }),
    );
    await vi.waitFor(() => expect(interactions.listPending()).toHaveLength(2));
    for (const pending of interactions.listPending()) {
      interactions.respond(pending.id, {
        kind: "approval",
        decision: "allow",
      });
    }
    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { allowed: true },
      { allowed: true },
    ]);
  });
});

describe("TrustAuthorizer commitments", () => {
  it("invalidates a commitment once the run watermark moves", async () => {
    const interactions = new InteractionService();
    const classification = new ClassificationService();
    classification.openRun("run-a");
    const authorizer = new TrustAuthorizer(interactions, { classification });

    const granted = await authorizer.authorize(baseRequest({ runId: "run-a" }));
    expect(granted.commitment?.recheck()).toBe(true);

    classification.raise("run-a", "restricted", "read a secret");
    expect(granted.commitment?.recheck()).toBe(false);
  });

  it("keeps commitments valid for callers without a run", async () => {
    const interactions = new InteractionService();
    const classification = new ClassificationService();
    const authorizer = new TrustAuthorizer(interactions, { classification });

    const granted = await authorizer.authorize(baseRequest());
    expect(granted.commitment).toMatchObject({ level: "public", version: 0 });
    expect(granted.commitment?.recheck()).toBe(true);
  });
});
