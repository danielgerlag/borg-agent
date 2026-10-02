import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Kernel } from "@borg-agent/kernel";
import type { PendingInteraction } from "@borg-agent/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { startPrintBench } from "../src/boot.js";
import {
  askToolId,
  designerPersonaId,
  frontDeskPersonaId,
  operatorPersonaId,
  printBenchAct,
  printBenchSnapshot,
  reviseToolId,
  sendQuoteToolId,
  startMachineToolId,
  usePersonaToolId,
  acceptToolId,
} from "../src/contract.js";
import { OPENING_PARAMETERS } from "../src/domain.js";

let dataDirectory: string | undefined;
let kernel: Kernel | undefined;

afterEach(async () => {
  await kernel?.stop();
  kernel = undefined;
  if (dataDirectory) {
    await rm(dataDirectory, { recursive: true, force: true });
    dataDirectory = undefined;
  }
});

describe("print bench", () => {
  it("keeps a failing bracket unquoted until a person accepts a repair", async () => {
    dataDirectory = await mkdtemp(join(tmpdir(), "print-bench-"));
    kernel = await startPrintBench(dataDirectory);
    const opened = await kernel.bus.invoke(printBenchSnapshot, {});
    expect(opened.persona.id).toBe(designerPersonaId);
    expect(opened.inspection.kind).toBe("fail");
    expect(opened.inspection.findings.map((finding) => finding.code)).toEqual([
      "wall",
      "overhang",
    ]);
    expect("quote" in opened.inspection).toBe(false);

    const revised = await kernel.bus.invoke(printBenchAct, {
      tool: reviseToolId,
      parameters: { ...OPENING_PARAMETERS, wallMm: 1.6 },
    });
    expect(revised.snapshot.inspection.kind).toBe("fail");
    expect(
      revised.snapshot.inspection.findings.map((finding) => finding.code),
    ).toEqual(["overhang"]);
    expect("quote" in revised.snapshot.inspection).toBe(false);

    const asked = await kernel.bus.invoke(printBenchAct, { tool: askToolId });
    expect(asked.snapshot.parameters.chamferDeg).toBe(70);
    expect(asked.snapshot.proposal?.parameters).toMatchObject({
      wallMm: 1.6,
      holeMm: 5,
      chamferDeg: 30,
      footprint: { widthMm: 80, depthMm: 40 },
    });

    const accepted = await kernel.bus.invoke(printBenchAct, { tool: acceptToolId });
    expect(accepted.snapshot.proposal).toBeNull();
    expect(accepted.snapshot.inspection.kind).toBe("pass");
    if (accepted.snapshot.inspection.kind !== "pass") {
      return;
    }
    expect(accepted.snapshot.inspection.quote.price.amount).toBeGreaterThan(0);

    await expect(
      kernel.bus.invoke(printBenchAct, { tool: sendQuoteToolId }),
    ).rejects.toThrow(/not allowed/);

    await kernel.bus.invoke(printBenchAct, {
      tool: usePersonaToolId,
      personaId: frontDeskPersonaId,
    });
    const send = kernel.bus.invoke(printBenchAct, { tool: sendQuoteToolId });
    void send.catch(() => undefined);
    const classification = await waitForKind(kernel, "classification", send);
    expect(classification.kind).toBe("classification");
    expect(
      kernel.interactions.respond(classification.id, {
        kind: "approval",
        decision: "allow",
        duration: "once",
      }),
    ).toBe(true);
    const sent = await withTimeout(send, 10_000, "send did not finish after allow");
    expect(sent.effect.type).toBe("sent");
    if (sent.effect.type === "sent") {
      expect(sent.snapshot.quoteSent?.messageId).toBe(sent.effect.messageId);
    }

    const again = kernel.bus.invoke(printBenchAct, { tool: sendQuoteToolId });
    void again.catch(() => undefined);
    const duplicate = await withTimeout(
      again,
      2_000,
      "second send waited on a person",
    );
    expect(kernel.interactions.listPending()).toEqual([]);
    expect(duplicate.effect.type).toBe("duplicate");

    await kernel.bus.invoke(printBenchAct, {
      tool: usePersonaToolId,
      personaId: operatorPersonaId,
    });
    const start = kernel.bus.invoke(printBenchAct, { tool: startMachineToolId });
    void start.catch(() => undefined);
    const approval = await waitForKind(kernel, "tool_approval", start);
    expect(
      kernel.interactions.respond(approval.id, {
        kind: "approval",
        decision: "allow",
        duration: "once",
      }),
    ).toBe(true);
    const running = await withTimeout(start, 10_000, "start did not finish after allow");
    expect(running.effect.type).toBe("running");
    expect(running.snapshot.machine).toEqual({
      status: "running",
      revision: running.snapshot.revision,
    });

    await kernel.bus.invoke(printBenchAct, {
      tool: usePersonaToolId,
      personaId: designerPersonaId,
    });
    await expect(
      kernel.bus.invoke(printBenchAct, { tool: startMachineToolId }),
    ).rejects.toThrow(/not allowed/);
  }, 60_000);
});

async function waitForKind(
  runningKernel: Kernel,
  kind: PendingInteraction["kind"],
  pending: Promise<unknown>,
): Promise<PendingInteraction> {
  const started = Date.now();
  while (Date.now() - started < 10_000) {
    const match = runningKernel.interactions
      .listPending()
      .find((item) => item.kind === kind);
    if (match) {
      return match;
    }
    const settled = await Promise.race([
      pending.then((value) => ({ done: true as const, value })),
      delay(20).then(() => ({ done: false as const })),
    ]);
    if (settled.done) {
      throw new Error(`Act finished before ${kind}: ${JSON.stringify(settled.value)}`);
    }
  }
  throw new Error(`No ${kind} interaction`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(pending: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([pending, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}
