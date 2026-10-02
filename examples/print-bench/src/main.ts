import { randomUUID } from "node:crypto";
import { modelOperationPrefixSchema } from "@borg-agent/contracts";
import {
  definePlugin,
  defineTool,
  z,
  type PluginContext,
} from "@borg-agent/plugin-sdk";
import { SHOP, evaluate, type Inspection } from "./domain.js";
import {
  acceptToolId,
  actInputSchema,
  askToolId,
  designerPersonaId,
  effectSchema,
  parametersSchema,
  printBenchAct,
  printBenchSnapshot,
  proposeToolId,
  reviseToolId,
  sendQuoteToolId,
  snapshotSchema,
  startMachineToolId,
  usePersonaToolId,
} from "./contract.js";
import {
  createJobWriter,
  withParameters,
  type Job,
  type JobWriter,
} from "./job.js";
import { benchPersonas } from "./personas.js";
import { registerScriptedModel } from "./provider.js";

type Effect = z.output<typeof effectSchema>;

const emptyInput = z.object({}).strict();
const parametersInput = z.object({ parameters: parametersSchema }).strict();
const personaInput = z.object({ personaId: z.string().min(1) }).strict();
const startInput = z.object({ revision: z.number().int() }).strict();

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
      reviseTool(jobs),
      acceptTool(jobs),
      proposeTool(jobs),
      askTool(context, jobs),
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

function reviseTool(jobs: JobWriter) {
  return defineTool({
    id: reviseToolId,
    description: "Replace the current bracket parameters and recompile.",
    input: parametersInput,
    output: effectSchema,
    approval: "auto",
    sideEffect: true,
    async execute(input): Promise<Effect> {
      await jobs.run(async (session) => {
        session.commit(withParameters(session.job, input.parameters));
      });
      return { type: "revised" };
    },
  });
}

function acceptTool(jobs: JobWriter) {
  return defineTool({
    id: acceptToolId,
    description: "Accept the pending parameter proposal.",
    input: emptyInput,
    output: effectSchema,
    approval: "auto",
    sideEffect: true,
    async execute(): Promise<Effect> {
      await jobs.run(async (session) => {
        const proposal = session.job.proposal;
        if (!proposal) {
          return;
        }
        const revised = withParameters(session.job, proposal.parameters);
        session.commit({
          ...revised,
          proposal: null,
          acceptedProposalId: proposal.id,
        });
      });
      return { type: "accepted" };
    },
  });
}

function proposeTool(jobs: JobWriter) {
  return defineTool({
    id: proposeToolId,
    description: "Stage a parameter proposal without changing the current part.",
    input: parametersInput,
    output: effectSchema,
    approval: "auto",
    sideEffect: true,
    async execute(input): Promise<Effect> {
      await jobs.run(async (session) => {
        session.commit({
          ...session.job,
          proposal: { id: randomUUID(), parameters: input.parameters },
        });
      });
      return { type: "asked" };
    },
  });
}

function askTool(context: PluginContext, jobs: JobWriter) {
  return defineTool({
    id: askToolId,
    description: "Ask the designer persona to propose a printable revision.",
    input: emptyInput,
    output: effectSchema,
    approval: "auto",
    sideEffect: true,
    async execute(_input, toolContext): Promise<Effect> {
      const job = await jobs.read();
      // The loop calls propose, which writes this same job. Do not hold the writer here.
      const started = await context.loops.start({
        prompt: `Revise the fan bracket for PETG on the MK4. Current parameters: ${JSON.stringify(job.parameters)}`,
        personaId: designerPersonaId,
        allowedTools: [proposeToolId],
        providerId: "example.print-bench",
        modelId: "scripted",
        security: {
          kind: "root",
          subject: { kind: "print-bench", id: "fan-bracket" },
          classification: "confidential",
          provenance: { kind: "user", id: "bench" },
          operationPrefix: modelOperationPrefixSchema.parse("example.print-bench"),
        },
      });
      await waitForLoop(context, started.id, toolContext.signal);
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
        const inspection = evaluate(session.job.parameters);
        if (inspection.kind !== "pass") {
          return { type: "unquotable" };
        }
        if (session.job.quoteSent?.revision === session.job.revision) {
          return {
            type: "duplicate",
            messageId: session.job.quoteSent.messageId,
          };
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
        const inspection = evaluate(session.job.parameters);
        if (
          inspection.kind !== "pass" ||
          session.job.revision !== input.revision
        ) {
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

async function apply(
  context: PluginContext,
  jobs: JobWriter,
  action: import("@borg-agent/plugin-sdk").z.output<typeof actInputSchema>,
): Promise<Effect> {
  if (action.tool === startMachineToolId) {
    const job = await jobs.read();
    if (evaluate(job.parameters).kind !== "pass") {
      return { type: "not-printable" };
    }
    return effectSchema.parse(
      await scopedInvoke(context, job, action.tool, { revision: job.revision }),
    );
  }
  const job = await jobs.read();
  const input = action.tool === reviseToolId || action.tool === proposeToolId
    ? { parameters: action.parameters }
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
  const inspection = wire(evaluate(job.parameters));
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
    parameters: job.parameters,
    inspection,
    proposal: job.proposal
      ? {
          id: job.proposal.id,
          parameters: job.proposal.parameters,
          inspection: wire(evaluate(job.proposal.parameters)),
        }
      : null,
    machine: job.machine,
    quoteSent: job.quoteSent
      ? { revision: job.quoteSent.revision, messageId: job.quoteSent.messageId }
      : null,
    bedMm: SHOP.bedMm,
  });
}

function wire(inspection: Inspection) {
  const solid = {
    wallMm: inspection.solid.wallMm,
    holeMm: inspection.solid.holeMm,
    facetAngleDeg: inspection.solid.facetAngleDeg,
    boundsMm: inspection.solid.boundsMm,
    volumeCm3: inspection.solid.volumeCm3,
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

async function waitForLoop(
  context: PluginContext,
  runId: string,
  signal: AbortSignal,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < 10_000) {
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
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`Designer loop ${runId} did not finish`);
}
