import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Kernel } from "@borg-agent/kernel";
import type { PendingInteraction } from "@borg-agent/contracts";
import { z } from "@borg-agent/plugin-sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startPrintBench } from "../src/boot.js";
import { meshSpan, SHOP } from "../src/domain.js";
import { handleProviderCall } from "../src/provider-bridge.js";
import { connectModelMessage } from "../src/contract.js";
import {
  createJobWriter,
  designTitle,
  newDesignTitle,
  readCatalog,
} from "../src/job.js";
import type { JsonValue } from "@borg-agent/plugin-sdk";
import {
  addedReply,
  cylinderFromGearAnswer,
  designerModelPreference,
  GEAR_QUESTION,
  installDesignerFetch,
} from "./model-double.js";
import {
  addToolId,
  addToolInput,
  deleteDesignToolId,
  translateToolId,
  translateToolInput,
  deleteToolId,
  designerPersonaId,
  newDesignToolId,
  openDesignToolId,
  preferModelToolId,
  printBenchAct,
  printBenchSnapshot,
  promptToolId,
  transformToolId,
  transformToolInput,
} from "../src/contract.js";

let dataDirectory: string | undefined;
let kernel: Kernel | undefined;
let fetchDouble: ReturnType<typeof installDesignerFetch> | undefined;

beforeEach(() => {
  fetchDouble = installDesignerFetch();
});

afterEach(async () => {
  await kernel?.stop();
  kernel = undefined;
  fetchDouble?.restore();
  fetchDouble = undefined;
  if (dataDirectory) {
    await rm(dataDirectory, { recursive: true, force: true });
    dataDirectory = undefined;
  }
});

describe("print bench", () => {
  it("publishes object schemas for the solid tools", () => {
    for (const schema of [addToolInput, transformToolInput, translateToolInput]) {
      expect(z.toJSONSchema(schema)).toMatchObject({ type: "object" });
    }
  });

  it("adopts a saved job as the first design", async () => {
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const legacy = {
      revision: 2,
      personaId: designerPersonaId,
      sessionId,
      scene: { bodies: [], selectedId: null },
      reply: "LLM provider borg.azure failed",
      turns: [{ role: "user" as const, text: "draw a gear" }],
      machine: { status: "idle" as const },
      quoteSent: null,
    };
    const values = new Map<string, JsonValue>();
    const jobs = createJobWriter({
      async get(key) {
        return values.get(key);
      },
      async set(key, value) {
        values.set(key, value);
      },
    });
    values.set("job", legacy);
    const current = await jobs.read();
    expect(current.id).toBe(sessionId);
    expect(current.title).toBe("draw a gear");
    expect(current.reply).toBe(legacy.reply);
    expect(current).not.toHaveProperty("quoteSent");
    expect(current).not.toHaveProperty("machine");
    expect(JSON.stringify(values.get("job"))).not.toContain("quoteSent");
    expect(values.get("job")).toMatchObject({ currentId: sessionId });
    expect(designTitle(newDesignTitle, ` ${"a".repeat(80)} `)).toBe("a".repeat(48));
    expect(designTitle("Bracket", "draw a gear")).toBe("Bracket");
    expect(() => readCatalog({ revision: 1 })).toThrow("Print bench job is corrupt");
  });

  it("builds a solid from the palette and a prompt", async () => {
    dataDirectory = await mkdtemp(join(tmpdir(), "print-bench-"));
    kernel = await startPrintBench(dataDirectory);
    const opened = await kernel.bus.invoke(printBenchSnapshot, {});
    expect(opened.persona.id).toBe(designerPersonaId);
    expect(opened.scene.bodies).toEqual([]);
    expect(opened.inspection.kind).toBe("fail");
    expect(opened.inspection.findings.map((finding) => finding.code)).toEqual(["empty"]);

    const added = await kernel.bus.invoke(printBenchAct, {
      tool: addToolId,
      solid: { kind: "box", widthMm: 40, depthMm: 30, heightMm: 20 },
    });
    expect(added.snapshot.scene.bodies).toHaveLength(1);
    expect(added.snapshot.inspection.kind).toBe("pass");

    await connectDesigner(kernel);
    const prompted = await kernel.bus.invoke(printBenchAct, {
      tool: promptToolId,
      text: "add a sphere radius 15",
    });
    expect(prompted.effect.type).toBe("asked");
    expect(prompted.snapshot.design.title).toBe("add a sphere radius 15");
    expect(prompted.snapshot.scene.bodies.map((body) => body.kind)).toEqual(["box", "sphere"]);
    expect(prompted.snapshot.inspection.kind).toBe("fail");
    expect(prompted.snapshot.inspection.findings.map((finding) => finding.code)).toContain(
      "overhang",
    );
    const sphereId = prompted.snapshot.scene.selectedId;
    expect(sphereId).toEqual(expect.any(String));
    if (sphereId === null) {
      return;
    }

    const deleted = await kernel.bus.invoke(printBenchAct, {
      tool: deleteToolId,
      id: sphereId,
    });
    expect(deleted.snapshot.scene.bodies).toHaveLength(1);
    expect(deleted.snapshot.inspection.kind).toBe("pass");
  }, 60_000);

  it("asks for a missing size, then adds the solid", async () => {
    dataDirectory = await mkdtemp(join(tmpdir(), "print-bench-"));
    kernel = await startPrintBench(dataDirectory);
    await connectDesigner(kernel);
    const asked = kernel.bus.invoke(printBenchAct, {
      tool: promptToolId,
      text: "a sphere",
    });
    void asked.catch(() => undefined);
    const question = await waitForKind(kernel, "human_input", asked);
    expect(question.prompt).toMatch(/radius/i);
    expect(
      kernel.interactions.respond(question.id, { kind: "text", text: "15" }),
    ).toBe(true);
    const done = await withTimeout(asked, 10_000, "designer did not finish after the answer");
    expect(done.snapshot.design.title).toBe("a sphere");
    expect(done.snapshot.scene.bodies.map((body) => body.kind)).toEqual(["sphere"]);
    expect(done.snapshot.turns.map((turn) => turn.role)).toEqual(["user", "designer"]);
    expect(done.snapshot.inspection.kind).toBe("fail");
    expect(done.snapshot.inspection.findings.map((finding) => finding.code)).toContain("overhang");
  }, 60_000);

  it("asks about a gear, then adds the solid the model returns", async () => {
    dataDirectory = await mkdtemp(join(tmpdir(), "print-bench-"));
    kernel = await startPrintBench(dataDirectory);
    await connectDesigner(kernel);
    const drawn = kernel.bus.invoke(printBenchAct, {
      tool: promptToolId,
      text: "draw a gear",
    });
    void drawn.catch(() => undefined);
    const question = await waitForKind(kernel, "human_input", drawn);
    expect(question.prompt).toBe(GEAR_QUESTION);
    const mid = await kernel.bus.invoke(printBenchSnapshot, {});
    expect(mid.scene.bodies).toEqual([]);
    const answer = "8 teeth, 40 mm";
    expect(kernel.interactions.respond(question.id, { kind: "text", text: answer })).toBe(true);
    const done = await withTimeout(drawn, 10_000, "gear did not finish");
    expect(done.snapshot.reply).toBe(addedReply("cylinder"));
    expect(done.snapshot.scene.bodies).toEqual([
      expect.objectContaining(cylinderFromGearAnswer(answer)),
    ]);
    expect(done.snapshot.turns.map((turn) => turn.role)).toEqual(["user", "designer"]);
    expect(JSON.stringify(fetchDouble?.requests[0])).toContain("draw a gear");
    expect(JSON.stringify(fetchDouble?.requests[0])).toContain("x 0, y 0 is that corner, not the centre");
    expect(JSON.stringify(fetchDouble?.requests[0])).toContain("x 125, y 105");
    expect(JSON.stringify(fetchDouble?.requests[0])).toContain("feedback_ask");
    expect(JSON.stringify(fetchDouble?.requests[0])).toContain("example_print-bench_add");
  }, 60_000);

  it("moves every solid when asked to centre the object", async () => {
    dataDirectory = await mkdtemp(join(tmpdir(), "print-bench-"));
    kernel = await startPrintBench(dataDirectory);
    await connectDesigner(kernel);
    await kernel.bus.invoke(printBenchAct, {
      tool: addToolId,
      solid: { kind: "box", widthMm: 10, depthMm: 10, heightMm: 10 },
    });
    const placed = await kernel.bus.invoke(printBenchAct, {
      tool: addToolId,
      solid: { kind: "box", widthMm: 10, depthMm: 10, heightMm: 10 },
    });
    const before = placed.snapshot.scene.bodies;
    expect(before).toHaveLength(2);
    expect(placed.snapshot.scene.selectedId).toBe(before[1]?.id);
    const moved = await kernel.bus.invoke(printBenchAct, {
      tool: promptToolId,
      text: "move it to the centre of the build plate",
    });
    const after = moved.snapshot.scene.bodies;
    expect(moved.snapshot.reply).toBe("Moved the whole object.");
    expect(after.map((body) => body.id)).toEqual(before.map((body) => body.id));
    expect(after[1]?.position.x).toBe((after[0]?.position.x ?? 0) + 45);
    expect(after[0]?.position.z).toBe(before[0]?.position.z);
    expect(after[1]?.position.z).toBe(before[1]?.position.z);
    expect(after[0]?.position.x).not.toBe(before[0]?.position.x);
    expect(after[1]?.position.x).not.toBe(before[1]?.position.x);
    const centred = meshSpan(after);
    expect(centred?.centre.x).toBe(SHOP.bedMm.x / 2);
    expect(centred?.centre.y).toBe(SHOP.bedMm.y / 2);
    const request = JSON.stringify(fetchDouble?.requests[0]);
    expect(request).toContain("call translate with dxMm");
    expect(request).toContain("example_print-bench_translate");
    expect(request).toContain("Selection is one solid, not the object.");
  }, 60_000);

  it("refreshes designer tools without clearing the chosen model", async () => {
    dataDirectory = await mkdtemp(join(tmpdir(), "print-bench-"));
    kernel = await startPrintBench(dataDirectory);
    await connectDesigner(kernel);
    await kernel.personas.update(designerPersonaId, {
      instructions: "old designer instructions",
      allowedTools: [addToolId, transformToolId],
    });
    await kernel.stop();
    kernel = await startPrintBench(dataDirectory);
    const designer = kernel.personas.get(designerPersonaId);
    expect(designer?.instructions).toContain("example.print-bench.translate");
    expect(designer?.allowedTools).toContain(translateToolId);
    expect(designer?.preferredModels).toEqual([designerModelPreference]);
  });

  it("asks about a gear after an earlier designer turn", async () => {
    dataDirectory = await mkdtemp(join(tmpdir(), "print-bench-"));
    kernel = await startPrintBench(dataDirectory);
    await connectDesigner(kernel);
    const first = await kernel.bus.invoke(printBenchAct, {
      tool: promptToolId,
      text: "add a sphere radius 15",
    });
    expect(first.snapshot.scene.bodies.map((body) => body.kind)).toEqual(["sphere"]);
    const drawn = kernel.bus.invoke(printBenchAct, {
      tool: promptToolId,
      text: "draw a gear",
    });
    void drawn.catch(() => undefined);
    const question = await waitForKind(kernel, "human_input", drawn);
    expect(question.prompt).toBe(GEAR_QUESTION);
    const answer = "12 teeth, 50 mm";
    expect(kernel.interactions.respond(question.id, { kind: "text", text: answer })).toBe(true);
    const done = await withTimeout(drawn, 10_000, "second designer turn did not finish");
    expect(done.snapshot.reply).toBe(addedReply("cylinder"));
    expect(done.snapshot.design.title).toBe("add a sphere radius 15");
    expect(done.snapshot.scene.bodies.filter((body) => body.kind === "sphere")).toHaveLength(1);
    expect(done.snapshot.scene.bodies.find((body) => body.kind === "cylinder")).toMatchObject(
      cylinderFromGearAnswer(answer),
    );
  }, 60_000);

  it("says when no model is chosen and does not invent a solid", async () => {
    dataDirectory = await mkdtemp(join(tmpdir(), "print-bench-"));
    kernel = await startPrintBench(dataDirectory);
    const result = await kernel.bus.invoke(printBenchAct, {
      tool: promptToolId,
      text: "draw a gear",
    });
    expect(result.snapshot.designerModel).toBeNull();
    expect(result.snapshot.design.title).toBe("draw a gear");
    expect(result.snapshot.reply).toBe(connectModelMessage);
    expect(result.snapshot.scene.bodies).toEqual([]);
    expect(fetchDouble?.requests).toEqual([]);
  });

  it("keeps each design's model and transcript apart", async () => {
    dataDirectory = await mkdtemp(join(tmpdir(), "print-bench-"));
    kernel = await startPrintBench(dataDirectory);
    const opened = await kernel.bus.invoke(printBenchSnapshot, {});
    expect(opened.design.title).toBe(newDesignTitle);
    expect(opened.designs).toHaveLength(1);

    const box = { kind: "box" as const, widthMm: 40, depthMm: 30, heightMm: 20 };
    const added = await kernel.bus.invoke(printBenchAct, { tool: addToolId, solid: box });
    const firstId = added.snapshot.design.id;
    expect(added.snapshot.scene.bodies).toHaveLength(1);

    const second = await kernel.bus.invoke(printBenchAct, { tool: newDesignToolId });
    expect(second.effect.type).toBe("design");
    const secondId = second.snapshot.design.id;
    expect(secondId).not.toBe(firstId);
    expect(second.snapshot.scene.bodies).toEqual([]);
    expect(second.snapshot.designs).toHaveLength(2);

    const named = await kernel.bus.invoke(printBenchAct, {
      tool: promptToolId,
      text: "gear sketch",
    });
    expect(named.snapshot.design.id).toBe(secondId);
    expect(named.snapshot.design.title).toBe("gear sketch");
    expect(named.snapshot.reply).toBe(connectModelMessage);
    expect(named.snapshot.scene.bodies).toEqual([]);

    const back = await kernel.bus.invoke(printBenchAct, {
      tool: openDesignToolId,
      designId: firstId,
    });
    expect(back.snapshot.design.title).toBe(newDesignTitle);
    expect(back.snapshot.scene.bodies).toHaveLength(1);
    expect(back.snapshot.turns).toEqual([]);
    expect(back.snapshot.reply).toBe("");
    expect(back.snapshot.persona.id).toBe(designerPersonaId);

    const other = await kernel.bus.invoke(printBenchAct, {
      tool: openDesignToolId,
      designId: secondId,
    });
    expect(other.snapshot.design.title).toBe("gear sketch");
    expect(other.snapshot.scene.bodies).toEqual([]);
    expect(other.snapshot.turns.map((turn) => turn.text)).toEqual(["gear sketch", connectModelMessage]);

    await kernel.bus.invoke(printBenchAct, { tool: addToolId, solid: box });
    const firstAgain = await kernel.bus.invoke(printBenchAct, {
      tool: openDesignToolId,
      designId: firstId,
    });
    expect(firstAgain.snapshot.scene.bodies).toHaveLength(1);

    const removed = await kernel.bus.invoke(printBenchAct, {
      tool: deleteDesignToolId,
      designId: secondId,
    });
    expect(removed.snapshot.design.id).toBe(firstId);
    expect(removed.snapshot.designs).toHaveLength(1);

    const emptied = await kernel.bus.invoke(printBenchAct, {
      tool: deleteDesignToolId,
      designId: firstId,
    });
    expect(emptied.snapshot.design.id).not.toBe(firstId);
    expect(emptied.snapshot.designs).toHaveLength(1);
    expect(emptied.snapshot.scene.bodies).toEqual([]);
  }, 60_000);

  it("lists the provider plugins and keeps their secrets on that plugin", async () => {
    dataDirectory = await mkdtemp(join(tmpdir(), "print-bench-"));
    kernel = await startPrintBench(dataDirectory);
    const plugins = await handleProviderCall(kernel, { method: "plugins" });
    expect(plugins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "borg.openai" }),
        expect.objectContaining({ id: "borg.anthropic" }),
        expect.objectContaining({ id: "borg.ollama" }),
      ]),
    );
    await expect(
      handleProviderCall(kernel, {
        method: "secrets.has",
        pluginId: "example.print-bench",
        key: "apiKey",
      }),
    ).rejects.toThrow("Plugin example.print-bench cannot read secrets");
    const models = await handleProviderCall(kernel, { method: "models.list" });
    expect(models).toEqual([
      expect.objectContaining({ preferenceId: "borg.mock-llm:mock:scripted" }),
    ]);
  });
});

async function connectDesigner(running: Kernel): Promise<void> {
  await running.secrets.set("borg.openai", "apiKey", "sk-test");
  await running.bus.invokeById("borg.openai.connect", {});
  const chosen = await running.bus.invoke(printBenchAct, {
    tool: preferModelToolId,
    preferenceId: designerModelPreference,
  });
  expect(chosen.effect.type).toBe("model");
  expect(chosen.snapshot.designerModel).toBe(designerModelPreference);
}

async function waitForKind(
  runningKernel: Kernel,
  kind: PendingInteraction["kind"],
  pending: Promise<unknown>,
): Promise<PendingInteraction> {
  const started = Date.now();
  while (Date.now() - started < 10_000) {
    const match = runningKernel.interactions.listPending().find((item) => item.kind === kind);
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
