import { randomUUID } from "node:crypto";
import { modelOperationPrefixSchema } from "@borg-agent/contracts";
import { definePlugin, defineTool, z, type PluginContext } from "@borg-agent/plugin-sdk";
import { SHOP, evaluate, placeOnBed, type Body, type Inspection } from "./domain.js";
import {
  actInputSchema,
  addToolId,
  bodySchema,
  deleteToolId,
  designerPersonaId,
  feedbackAskToolId,
  effectSchema,
  placeInputSchema,
  placeToolId,
  primitiveSchema,
  printBenchAct,
  printBenchSnapshot,
  promptToolId,
  selectToolId,
  sendQuoteToolId,
  snapshotSchema,
  startMachineToolId,
  transformToolId,
  usePersonaToolId,
  type PlacedPart,
  type Primitive,
} from "./contract.js";
import { createJobWriter, withScene, type Job, type JobWriter } from "./job.js";
import { benchPersonas } from "./personas.js";
import { registerScriptedModel } from "./provider.js";

type Effect = z.output<typeof effectSchema>;

const emptyInput = z.object({}).strict();
const personaInput = z.object({ personaId: z.string().min(1) }).strict();
const startInput = z.object({ revision: z.number().int() }).strict();
const idInput = z.object({ id: z.string().uuid() }).strict();
const selectInput = z.object({ id: z.string().uuid().nullable() }).strict();
const promptInput = z.object({ text: z.string().min(1) }).strict();

const pluginId = "example.print-bench";

export default definePlugin({
  id: pluginId,
  version: "0.1.0",
  engines: { borg: "^0.1.0" },
  permissions: [
    "tools.register",
    "tools.invoke",
    "models.register",
    "loops.start",
    "channels.send",
    "personas.read",
    "personas.write",
    "ui.workspace",
  ],
  contributes: {
    commands: [printBenchSnapshot.id, printBenchAct.id],
    kinds: ["tool", "llmProvider", "workspaceView"],
  },
  async activate(context) {
    const jobs = createJobWriter(context.store);
    const tools = [
      addTool(jobs),
      placeTool(jobs),
      transformTool(jobs),
      deleteTool(jobs),
      selectTool(jobs),
      promptTool(context, jobs),
      sendTool(context, jobs),
      startTool(jobs),
      personaTool(context, jobs),
    ].map((tool) => context.tools.register(tool));
    const model = registerScriptedModel(context);
    for (const persona of benchPersonas) {
      if (!context.personas.get(persona.id)) {
        await context.personas.create({
          id: persona.id,
          name: persona.name,
          instructions: persona.instructions,
          preferredModels: [...persona.preferredModels],
          allowedTools: [...persona.allowedTools],
        });
      }
    }
    await context.personas.setDefault(designerPersonaId);
    const snapshotCommand = context.bus.handle(printBenchSnapshot, async () =>
      project(context, await jobs.read()),
    );
    const actCommand = context.bus.handle(printBenchAct, async (input, signal) => {
      signal.throwIfAborted();
      const action = actInputSchema.parse(input);
      const effect = await apply(context, jobs, action);
      return {
        snapshot: await project(context, await jobs.read()),
        effect,
      };
    });
    return {
      async dispose() {
        snapshotCommand.dispose();
        actCommand.dispose();
        model.dispose();
        for (const tool of tools) {
          tool.dispose();
        }
      },
    };
  },
});

function addTool(jobs: JobWriter) {
  return defineTool({
    id: addToolId,
    description: "Add a box, cylinder, sphere, or cone to the bed.",
    input: primitiveSchema,
    output: effectSchema,
    approval: "auto",
    sideEffect: true,
    async execute(input): Promise<Effect> {
      await jobs.run(async (session) => {
        const body = placeOnBed(materialize(input, randomUUID()), session.job.scene.bodies.length);
        session.commit(
          withScene(session.job, {
            bodies: [...session.job.scene.bodies, body],
            selectedId: body.id,
          }, ""),
        );
      });
      return { type: "revised" };
    },
  });
}

function placeTool(jobs: JobWriter) {
  return defineTool({
    id: placeToolId,
    description: "Place one or more solids, each with its own position and rotation, in one edit.",
    input: placeInputSchema,
    output: effectSchema,
    approval: "auto",
    sideEffect: true,
    async execute(input): Promise<Effect> {
      await jobs.run(async (session) => {
        const added = input.parts.map((part) => placedBody(part, randomUUID()));
        session.commit(
          withScene(
            session.job,
            {
              bodies: [...session.job.scene.bodies, ...added],
              selectedId: added.at(-1)?.id ?? session.job.scene.selectedId,
            },
            "",
          ),
        );
      });
      return { type: "revised" };
    },
  });
}

function transformTool(jobs: JobWriter) {
  return defineTool({
    id: transformToolId,
    description: "Move, rotate, or resize one solid.",
    input: bodySchema,
    output: effectSchema,
    approval: "auto",
    sideEffect: true,
    async execute(input): Promise<Effect> {
      await jobs.run(async (session) => {
        if (!session.job.scene.bodies.some((body) => body.id === input.id)) {
          return;
        }
        session.commit(
          withScene(
            session.job,
            {
              bodies: session.job.scene.bodies.map((body) => (body.id === input.id ? input : body)),
              selectedId: input.id,
            },
            "",
          ),
        );
      });
      return { type: "revised" };
    },
  });
}

function deleteTool(jobs: JobWriter) {
  return defineTool({
    id: deleteToolId,
    description: "Remove one solid from the bed.",
    input: idInput,
    output: effectSchema,
    approval: "auto",
    sideEffect: true,
    async execute(input): Promise<Effect> {
      await jobs.run(async (session) => {
        const bodies = session.job.scene.bodies.filter((body) => body.id !== input.id);
        session.commit(
          withScene(session.job, {
            bodies,
            selectedId: bodies.at(-1)?.id ?? null,
          }, ""),
        );
      });
      return { type: "revised" };
    },
  });
}

function selectTool(jobs: JobWriter) {
  return defineTool({
    id: selectToolId,
    description: "Choose the solid the palette and the prompt edit.",
    input: selectInput,
    output: effectSchema,
    approval: "auto",
    sideEffect: true,
    async execute(input): Promise<Effect> {
      await jobs.run(async (session) => {
        const selectedId =
          input.id !== null && session.job.scene.bodies.some((body) => body.id === input.id)
            ? input.id
            : null;
        session.commit(withScene(session.job, { ...session.job.scene, selectedId }));
      });
      return { type: "revised" };
    },
  });
}

function promptTool(context: PluginContext, jobs: JobWriter) {
  return defineTool({
    id: promptToolId,
    description: "Build or edit solids from a description.",
    input: promptInput,
    output: effectSchema,
    approval: "auto",
    sideEffect: true,
    async execute(input, toolContext): Promise<Effect> {
      await jobs.run(async (session) => {
        session.commit({
          ...session.job,
          turns: [...session.job.turns, { role: "user", text: input.text }],
        });
      });
      const job = await jobs.read();
      // The loop calls the solid tools and feedback.ask, which must not wait behind this writer.
      const started = await context.loops.start({
        prompt: [
          input.text,
          `Selection: ${job.scene.selectedId ?? "none"}`,
          `Scene: ${JSON.stringify(job.scene.bodies)}`,
        ].join("\n"),
        personaId: designerPersonaId,
        allowedTools: [
          addToolId,
          placeToolId,
          transformToolId,
          deleteToolId,
          selectToolId,
          feedbackAskToolId,
        ],
        providerId: "example.print-bench",
        modelId: "scripted",
        security: {
          kind: "root",
          // A repeated subject resumes the same root, and the loop closes that root when the turn ends.
          subject: { kind: "print-bench", id: randomUUID() },
          classification: "confidential",
          provenance: { kind: "user", id: "bench" },
          operationPrefix: modelOperationPrefixSchema.parse("example.print-bench"),
        },
      });
      let reply = "Done.";
      try {
        await waitForLoop(context, started.id, toolContext.signal);
        const output = context.loops.get(started.id)?.output?.trim() ?? "";
        if (output.length > 0) {
          reply = output;
        }
      } catch (error) {
        reply = error instanceof Error && error.message.trim().length > 0
          ? error.message
          : "The designer stopped.";
        await remember(jobs, reply);
        throw error;
      }
      await remember(jobs, reply);
      return { type: "asked" };
    },
  });
}

function sendTool(context: PluginContext, jobs: JobWriter) {
  return defineTool({
    id: sendQuoteToolId,
    description: "Send the quote for the current passing revision.",
    input: emptyInput,
    output: effectSchema,
    approval: "auto",
    sideEffect: true,
    async execute(_input, toolContext): Promise<Effect> {
      return jobs.run(async (session) => {
        const inspection = evaluate(session.job.scene);
        if (inspection.kind !== "pass") {
          return { type: "unquotable" };
        }
        if (session.job.quoteSent?.revision === session.job.revision) {
          return { type: "duplicate", messageId: session.job.quoteSent.messageId };
        }
        const receipt = await context.channels.send({
          adapterId: "borg.channel.mock",
          destinationId: "default",
          classification: "confidential",
          idempotencyKey: `quote-${session.job.revision}`,
          text: `${inspection.quote.grams} g, ${inspection.quote.hours} h, ${inspection.quote.price.amount} USD`,
          ...(toolContext.runId ? { runId: toolContext.runId } : {}),
          signal: toolContext.signal,
        });
        if (receipt.status === "denied") {
          return { type: "denied", reasons: [...receipt.reasons] };
        }
        const sentAt = receipt.status === "sent" ? receipt.sentAt : new Date().toISOString();
        session.commit({
          ...session.job,
          quoteSent: {
            revision: session.job.revision,
            messageId: receipt.messageId,
            sentAt,
          },
        });
        return receipt.status === "sent"
          ? { type: "sent", messageId: receipt.messageId }
          : { type: "duplicate", messageId: receipt.messageId };
      });
    },
  });
}

function startTool(jobs: JobWriter) {
  return defineTool({
    id: startMachineToolId,
    description: "Start the printer on the current passing revision.",
    input: startInput,
    output: effectSchema,
    approval: "ask",
    sideEffect: true,
    async execute(input): Promise<Effect> {
      return jobs.run(async (session) => {
        const inspection = evaluate(session.job.scene);
        if (inspection.kind !== "pass" || session.job.revision !== input.revision) {
          return { type: "not-printable" };
        }
        session.commit({
          ...session.job,
          machine: { status: "running", revision: session.job.revision },
        });
        return { type: "running" };
      });
    },
  });
}

function personaTool(context: PluginContext, jobs: JobWriter) {
  return defineTool({
    id: usePersonaToolId,
    description: "Sit as a shop persona.",
    input: personaInput,
    output: effectSchema,
    approval: "auto",
    sideEffect: true,
    async execute(input): Promise<Effect> {
      if (input.personaId.startsWith("system/")) {
        throw new Error(`Persona ${input.personaId} is not a bench seat`);
      }
      const persona = context.personas.get(input.personaId);
      if (!persona) {
        throw new Error(`Persona ${input.personaId} is unavailable`);
      }
      await jobs.run(async (session) => {
        if (session.job.personaId === persona.id) {
          return;
        }
        session.commit({ ...session.job, personaId: persona.id });
      });
      return { type: "persona" };
    },
  });
}

function placedBody(part: PlacedPart, id: string): Body {
  switch (part.kind) {
    case "box":
    case "cylinder":
    case "cone":
    case "sphere":
      return { id, ...part };
    default: {
      const unreachable: never = part;
      return unreachable;
    }
  }
}

function materialize(input: Primitive, id: string): Body {
  const position = { x: 0, y: 0, z: 0 };
  const rotationDeg = { x: 0, y: 0, z: 0 };
  if (input.kind === "box") {
    return { id, ...input, position, rotationDeg };
  }
  if (input.kind === "sphere") {
    return { id, ...input, position, rotationDeg };
  }
  return { id, ...input, position, rotationDeg };
}

async function apply(
  context: PluginContext,
  jobs: JobWriter,
  action: z.output<typeof actInputSchema>,
): Promise<Effect> {
  if (action.tool === startMachineToolId) {
    const job = await jobs.read();
    if (evaluate(job.scene).kind !== "pass") {
      return { type: "not-printable" };
    }
    return effectSchema.parse(
      await scopedInvoke(context, job, action.tool, { revision: job.revision }),
    );
  }
  const job = await jobs.read();
  const input =
    action.tool === addToolId
      ? action.solid
      : action.tool === transformToolId
        ? action.body
        : action.tool === deleteToolId
          ? { id: action.id }
          : action.tool === selectToolId
            ? { id: action.id }
            : action.tool === promptToolId
              ? { text: action.text }
              : action.tool === usePersonaToolId
                ? { personaId: action.personaId }
                : {};
  return effectSchema.parse(await scopedInvoke(context, job, action.tool, input));
}

async function scopedInvoke(
  context: PluginContext,
  job: Job,
  toolId: string,
  input: unknown,
): Promise<unknown> {
  const runId = randomUUID();
  const scope = context.tools.registerExecutionScope({
    runId,
    sessionId: job.sessionId,
    personaId: job.personaId,
  });
  try {
    await scope.prepare();
    return await context.tools.invoke(toolId, input, { runId });
  } finally {
    scope.dispose();
  }
}

async function project(context: PluginContext, job: Job) {
  const persona = context.personas.get(job.personaId);
  if (!persona) {
    throw new Error(`Persona ${job.personaId} is unavailable`);
  }
  const inspection = wire(evaluate(job.scene));
  return snapshotSchema.parse({
    revision: job.revision,
    persona: {
      id: persona.id,
      name: persona.name,
      allowedTools: [...persona.allowedTools],
    },
    personas: context.personas
      .list()
      .filter((seat) => seat.id.startsWith("print-bench/"))
      .map((seat) => ({ id: seat.id, name: seat.name })),
    scene: job.scene,
    reply: job.reply,
    turns: job.turns.map((turn) => ({ role: turn.role, text: turn.text })),
    inspection,
    machine: job.machine,
    quoteSent: job.quoteSent
      ? { revision: job.quoteSent.revision, messageId: job.quoteSent.messageId }
      : null,
    bedMm: SHOP.bedMm,
  });
}

function wire(inspection: Inspection) {
  const solid = {
    boundsMm: inspection.solid.boundsMm,
    volumeCm3: inspection.solid.volumeCm3,
    overhangDeg: inspection.solid.overhangDeg,
    mesh: {
      positions: [...inspection.solid.mesh.positions],
      indices: [...inspection.solid.mesh.indices],
    },
  };
  if (inspection.kind === "fail") {
    return {
      kind: "fail" as const,
      findings: inspection.findings.map((finding) => ({ ...finding })),
      solid,
    };
  }
  return {
    kind: "pass" as const,
    findings: [] as const,
    quote: inspection.quote,
    solid,
  };
}

async function remember(jobs: JobWriter, reply: string): Promise<void> {
  await jobs.run(async (session) => {
    session.commit({
      ...session.job,
      reply,
      turns: [...session.job.turns, { role: "designer", text: reply }],
    });
  });
}

async function waitForLoop(
  context: PluginContext,
  runId: string,
  signal: AbortSignal,
): Promise<void> {
  for (;;) {
    signal.throwIfAborted();
    const snapshot = context.loops.get(runId);
    if (!snapshot) {
      throw new Error(`Designer loop ${runId} disappeared`);
    }
    if (snapshot.status === "completed") {
      return;
    }
    if (snapshot.status === "failed" || snapshot.status === "cancelled") {
      throw new Error(snapshot.error ?? `Designer loop ${snapshot.status}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}
