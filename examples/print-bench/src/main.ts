/**
 * Print-bench plugin. Activation registers the designer tools and serves snapshot and act.
 */

import { randomUUID } from "node:crypto";
import {
  definePlugin,
  z,
  type PluginContext,
} from "@borg-agent/plugin-sdk";
import { SHOP, evaluate, type Inspection } from "./domain.js";
import {
  actInputSchema,
  addToolId,
  deleteDesignToolId,
  deleteToolId,
  designerPersonaId,
  effectSchema,
  newDesignToolId,
  openDesignToolId,
  preferModelToolId,
  printBenchAct,
  printBenchSnapshot,
  promptToolId,
  selectToolId,
  snapshotSchema,
  transformToolId,
} from "./contract.js";
import {
  createJobWriter,
  type Job,
  type JobWriter,
} from "./job.js";
import { benchPersonas } from "./personas.js";
import { adoptAssistantModel, chosenModel, createBenchTools } from "./tools.js";

type Effect = z.output<typeof effectSchema>;

const pluginId = "example.print-bench";

export default definePlugin({
  id: pluginId,
  version: "0.1.0",
  engines: { borg: "^0.1.0" },
  permissions: [
    "tools.register",
    "tools.invoke",
    "loops.start",
    "personas.read",
    "personas.write",
    "ui.workspace",
  ],
  contributes: {
    commands: [printBenchSnapshot.id, printBenchAct.id],
    kinds: ["tool", "workspaceView"],
  },
  async activate(context) {
    const jobs = createJobWriter(context.store);
    const tools = createBenchTools(context, jobs).map((tool) => context.tools.register(tool));
    for (const id of retiredSeats) {
      const retired = context.personas.get(id);
      if (retired && !retired.archived) {
        await context.personas.archive(id);
      }
    }
    for (const persona of benchPersonas) {
      const existing = context.personas.get(persona.id);
      if (!existing) {
        await context.personas.create({
          id: persona.id,
          name: persona.name,
          instructions: persona.instructions,
          preferredModels: [...persona.preferredModels],
          allowedTools: [...persona.allowedTools],
        });
      } else if (
        existing.instructions !== persona.instructions ||
        !sameTools(existing.allowedTools, persona.allowedTools)
      ) {
        await context.personas.update(persona.id, {
          instructions: persona.instructions,
          allowedTools: [...persona.allowedTools],
        });
      }
    }
    await adoptAssistantModel(context);
    if (
      context.personas.getDefault().id === designerPersonaId &&
      context.personas.get("system/general")
    ) {
      await context.personas.setDefault("system/general");
    }
    const snapshotCommand = context.bus.handle(printBenchSnapshot, async () =>
      project(context, jobs),
    );
    const actCommand = context.bus.handle(printBenchAct, async (input, signal) => {
      signal.throwIfAborted();
      const action = actInputSchema.parse(input);
      if (action.tool === preferModelToolId) {
        await context.personas.update(designerPersonaId, {
          preferredModels: [action.preferenceId],
        });
        return {
          snapshot: await project(context, jobs),
          effect: { type: "model" as const },
        };
      }
      if (action.tool === newDesignToolId) {
        await jobs.create();
      } else if (action.tool === openDesignToolId) {
        await jobs.open(action.designId);
      } else if (action.tool === deleteDesignToolId) {
        await jobs.remove(action.designId);
      } else {
        const effect = await apply(context, jobs, action);
        return {
          snapshot: await project(context, jobs),
          effect,
        };
      }
      return {
        snapshot: await project(context, jobs),
        effect: { type: "design" as const },
      };
    });
    return {
      async dispose() {
        snapshotCommand.dispose();
        actCommand.dispose();
        for (const tool of tools) {
          tool.dispose();
        }
      },
    };
  },
});

const retiredSeats = ["print-bench/front-desk", "print-bench/operator"] as const;

function sameTools(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((tool, index) => tool === right[index]);
}

async function apply(
  context: PluginContext,
  jobs: JobWriter,
  action: z.output<typeof actInputSchema>,
): Promise<Effect> {
  const job = await jobs.read();
  const input =
    action.tool === addToolId
      ? { solid: action.solid }
      : action.tool === transformToolId
        ? { body: action.body }
        : action.tool === deleteToolId
          ? { id: action.id }
          : action.tool === selectToolId
            ? { id: action.id }
            : action.tool === promptToolId
              ? { text: action.text }
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
    sessionId: job.id,
    personaId: job.personaId,
  });
  try {
    await scope.prepare();
    return await context.tools.invoke(toolId, input, { runId });
  } finally {
    scope.dispose();
  }
}

async function project(context: PluginContext, jobs: JobWriter) {
  const job = await jobs.read();
  const persona = context.personas.get(job.personaId);
  if (!persona) {
    throw new Error(`Persona ${job.personaId} is unavailable`);
  }
  const inspection = wire(evaluate(job.scene));
  return snapshotSchema.parse({
    design: { id: job.id, title: job.title },
    designs: await jobs.list(),
    revision: job.revision,
    persona: {
      id: persona.id,
      name: persona.name,
      allowedTools: [...persona.allowedTools],
    },
    scene: job.scene,
    reply: job.reply,
    turns: job.turns.map((turn) => ({ role: turn.role, text: turn.text })),
    inspection,
    bedMm: SHOP.bedMm,
    designerModel: chosenModel(context),
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
    solid,
  };
}
