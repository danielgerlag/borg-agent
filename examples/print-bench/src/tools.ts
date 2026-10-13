/**
 * Designer tools. Scene edits change the pinned design, and prompt starts a designer loop.
 */

import { randomUUID } from "node:crypto";
import { modelOperationPrefixSchema } from "@borg-agent/contracts";
import {
  defineTool,
  z,
  type PluginContext,
  type ToolExecutionContext,
} from "@borg-agent/plugin-sdk";
import {
  bedFrame,
  objectFrame,
  placeOnBed,
  shiftBodies,
  type Body,
} from "./domain.js";
import {
  addToolId,
  addToolInput,
  connectModelMessage,
  deleteToolId,
  designerPersonaId,
  effectSchema,
  feedbackAskToolId,
  placeInputSchema,
  placeToolId,
  promptToolId,
  selectToolId,
  transformToolId,
  transformToolInput,
  translateToolId,
  translateToolInput,
  unconfiguredModelPreference,
  type PlacedPart,
  type Primitive,
} from "./contract.js";
import {
  designTitle,
  withScene,
  type JobSession,
  type JobWriter,
} from "./job.js";

type Effect = z.output<typeof effectSchema>;
type DesignPins = Map<string, string>;

const idInput = z.object({ id: z.string().uuid() }).strict();
const selectInput = z.object({ id: z.string().uuid().nullable() }).strict();
const promptInput = z.object({ text: z.string().min(1) }).strict();
const loopPin = "loop";
const demoModelPreference = "borg.mock-llm:mock:scripted";

export function createBenchTools(
  context: PluginContext,
  jobs: JobWriter,
): ReturnType<typeof defineTool>[] {
  const pins: DesignPins = new Map();
  return [
    addTool(jobs, pins),
    placeTool(jobs, pins),
    transformTool(jobs, pins),
    translateTool(jobs, pins),
    deleteTool(jobs, pins),
    selectTool(jobs, pins),
    promptTool(context, jobs, pins),
  ];
}

// A designer turn's tool calls keep the design that started the turn.
function mutate<T>(
  jobs: JobWriter,
  pins: DesignPins,
  toolContext: ToolExecutionContext,
  operation: (session: JobSession) => Promise<T>,
): Promise<T> {
  const pinned = toolContext.runId ? pins.get(toolContext.runId) : undefined;
  const designId = pinned ?? toolContext.sessionId ?? pins.get(loopPin);
  if (!designId) {
    return jobs.run(operation);
  }
  return jobs.edit(designId, operation);
}

function addTool(jobs: JobWriter, pins: DesignPins) {
  return defineTool({
    id: addToolId,
    description:
      "Add one box, cylinder, sphere, or cone. Sizes are millimetres. Pass the solid in the solid field. The bench drops it near the front-left corner. Add cannot set a position. Move an existing solid with transform.",
    input: addToolInput,
    output: effectSchema,
    approval: "auto",
    sideEffect: true,
    async execute(input, toolContext): Promise<Effect> {
      await mutate(jobs, pins, toolContext, async (session) => {
        const body = placeOnBed(materialize(input.solid, randomUUID()), session.job.scene.bodies.length);
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

function placeTool(jobs: JobWriter, pins: DesignPins) {
  return defineTool({
    id: placeToolId,
    description:
      `Place one or more solids in one edit. Each part keeps the position and rotation you send, in millimetres, z up. ${bedFrame()} Use this for one object made of several solids, such as a gear: a cylinder for the disc and boxes for the teeth. A solid rests on the bed when position.z is half its height, or its radius for a sphere.`,
    input: placeInputSchema,
    output: effectSchema,
    approval: "auto",
    sideEffect: true,
    async execute(input, toolContext): Promise<Effect> {
      await mutate(jobs, pins, toolContext, async (session) => {
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

function transformTool(jobs: JobWriter, pins: DesignPins) {
  return defineTool({
    id: transformToolId,
    description:
      `Change one solid already on the bed. Pass the whole solid, including its id, in the body field. Keep that id. Rotations are degrees. Use this when the user names that one part. To move every solid together, call translate. ${bedFrame()}`,
    input: transformToolInput,
    output: effectSchema,
    approval: "auto",
    sideEffect: true,
    async execute(input, toolContext): Promise<Effect> {
      await mutate(jobs, pins, toolContext, async (session) => {
        const next = input.body;
        if (!session.job.scene.bodies.some((body) => body.id === next.id)) {
          return;
        }
        session.commit(
          withScene(
            session.job,
            {
              bodies: session.job.scene.bodies.map((body) => (body.id === next.id ? next : body)),
              selectedId: next.id,
            },
            "",
          ),
        );
      });
      return { type: "revised" };
    },
  });
}

function translateTool(jobs: JobWriter, pins: DesignPins) {
  return defineTool({
    id: translateToolId,
    description:
      "Shift every solid on the bed by the same delta. Pass dxMm, dyMm, and dzMm in millimetres. Spacing stays as it is. To centre the whole object on the bed, copy dxMm and dyMm from the turn and set dzMm to 0. This is the move for the whole object. transform changes one solid only.",
    input: translateToolInput,
    output: effectSchema,
    approval: "auto",
    sideEffect: true,
    async execute(input, toolContext): Promise<Effect> {
      await mutate(jobs, pins, toolContext, async (session) => {
        session.commit(
          withScene(
            session.job,
            {
              bodies: shiftBodies(session.job.scene.bodies, {
                x: input.dxMm,
                y: input.dyMm,
                z: input.dzMm,
              }),
              selectedId: session.job.scene.selectedId,
            },
            "",
          ),
        );
      });
      return { type: "revised" };
    },
  });
}

function deleteTool(jobs: JobWriter, pins: DesignPins) {
  return defineTool({
    id: deleteToolId,
    description: "Remove one solid by its id.",
    input: idInput,
    output: effectSchema,
    approval: "auto",
    sideEffect: true,
    async execute(input, toolContext): Promise<Effect> {
      await mutate(jobs, pins, toolContext, async (session) => {
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

function selectTool(jobs: JobWriter, pins: DesignPins) {
  return defineTool({
    id: selectToolId,
    description: "Select one solid by its id, or pass null to clear the selection.",
    input: selectInput,
    output: effectSchema,
    approval: "auto",
    sideEffect: true,
    async execute(input, toolContext): Promise<Effect> {
      await mutate(jobs, pins, toolContext, async (session) => {
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

function promptTool(context: PluginContext, jobs: JobWriter, pins: DesignPins) {
  return defineTool({
    id: promptToolId,
    description: "Ask the designer to build or edit the solids.",
    input: promptInput,
    output: effectSchema,
    approval: "auto",
    sideEffect: true,
    async execute(input, toolContext): Promise<Effect> {
      const designId = toolContext.sessionId;
      if (!designId) {
        throw new Error("Design is unavailable");
      }
      await jobs.edit(designId, async (session) => {
        session.commit({
          ...session.job,
          title: designTitle(session.job.title, input.text),
          turns: [...session.job.turns, { role: "user", text: input.text }],
        });
      });
      const preference = await adoptAssistantModel(context);
      if (preference === undefined) {
        await remember(jobs, designId, connectModelMessage);
        return { type: "asked" };
      }
      const job = await jobs.get(designId);
      // The loop calls the solid tools and feedback.ask, which must not wait behind this writer.
      pins.set(loopPin, designId);
      try {
        const started = await context.loops.start({
          prompt: [
            input.text,
            bedFrame(),
            objectFrame(job.scene.bodies),
            `Selected solid: ${job.scene.selectedId ?? "none"}. That is one part, not the whole object.`,
            `Scene: ${JSON.stringify(job.scene.bodies)}`,
          ].join("\n"),
          personaId: designerPersonaId,
          allowedTools: [
            addToolId,
            placeToolId,
            transformToolId,
            translateToolId,
            deleteToolId,
            selectToolId,
            feedbackAskToolId,
          ],
          security: {
            kind: "root",
            // A repeated subject resumes the same root, and the loop closes that root when the turn ends.
            subject: { kind: "print-bench", id: randomUUID() },
            classification: "confidential",
            provenance: { kind: "user", id: "bench" },
            operationPrefix: modelOperationPrefixSchema.parse("example.print-bench"),
          },
        });
        pins.set(started.id, designId);
        let reply = "Done.";
        try {
          await waitForLoop(context, started.id, toolContext.signal);
          const output = context.loops.get(started.id)?.output?.trim() ?? "";
          if (output.length > 0) {
            reply = output;
          }
        } catch (error) {
          reply =
            error instanceof Error && error.message.trim().length > 0
              ? error.message
              : "The designer stopped.";
          await remember(jobs, designId, reply);
          throw error;
        } finally {
          pins.delete(started.id);
        }
        await remember(jobs, designId, reply);
        return { type: "asked" };
      } finally {
        if (pins.get(loopPin) === designId) {
          pins.delete(loopPin);
        }
      }
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

function usableModel(preference: string): boolean {
  return preference !== unconfiguredModelPreference && preference !== demoModelPreference;
}

function assistantModels(context: PluginContext): string[] {
  const general = context.personas.get("system/general");
  const rest = context.personas
    .list()
    .filter(
      (persona) =>
        persona.id !== designerPersonaId &&
        persona.id !== "system/general" &&
        !persona.archived,
    );
  const seen = new Set<string>();
  const models: string[] = [];
  for (const preference of [general, ...rest].flatMap(
    (persona) => persona?.preferredModels ?? [],
  )) {
    if (!usableModel(preference) || seen.has(preference)) {
      continue;
    }
    seen.add(preference);
    models.push(preference);
  }
  return models;
}

export async function adoptAssistantModel(context: PluginContext): Promise<string | undefined> {
  const current = context.personas.get(designerPersonaId)?.preferredModels.filter(usableModel) ?? [];
  if (current.length > 0) {
    return current[0];
  }
  const adopted = assistantModels(context);
  const first = adopted[0];
  if (first === undefined) {
    return undefined;
  }
  await context.personas.update(designerPersonaId, { preferredModels: adopted });
  return first;
}

export function chosenModel(context: PluginContext): string | null {
  const preference = context.personas.get(designerPersonaId)?.preferredModels.find(usableModel);
  return preference ?? null;
}

async function remember(jobs: JobWriter, designId: string, reply: string): Promise<void> {
  await jobs.edit(designId, async (session) => {
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
