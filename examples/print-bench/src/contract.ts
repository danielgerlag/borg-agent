import { defineCommand } from "@borg-agent/contracts";
import { z } from "@borg-agent/plugin-sdk";

export const addToolId = "example.print-bench.add";
export const placeToolId = "example.print-bench.place";
export const transformToolId = "example.print-bench.transform";
export const deleteToolId = "example.print-bench.delete";
export const selectToolId = "example.print-bench.select";
export const promptToolId = "example.print-bench.prompt";
export const feedbackAskToolId = "feedback.ask";
export const sendQuoteToolId = "example.print-bench.send-quote";
export const startMachineToolId = "example.print-bench.start-machine";
export const usePersonaToolId = "example.print-bench.use-persona";

export const designerPersonaId = "print-bench/designer";
export const frontDeskPersonaId = "print-bench/front-desk";
export const operatorPersonaId = "print-bench/operator";

export const designerProviderId = "example.print-bench";
export const designerModelId = "grok-4.7";

const vecSchema = z
  .object({
    x: z.number(),
    y: z.number(),
    z: z.number(),
  })
  .strict();

const pose = {
  position: vecSchema,
  rotationDeg: vecSchema,
};

export const bodySchema = z.discriminatedUnion("kind", [
  z
    .object({
      id: z.string().uuid(),
      kind: z.literal("box"),
      widthMm: z.number().positive(),
      depthMm: z.number().positive(),
      heightMm: z.number().positive(),
      ...pose,
    })
    .strict(),
  z
    .object({
      id: z.string().uuid(),
      kind: z.literal("cylinder"),
      radiusMm: z.number().positive(),
      heightMm: z.number().positive(),
      ...pose,
    })
    .strict(),
  z
    .object({
      id: z.string().uuid(),
      kind: z.literal("cone"),
      radiusMm: z.number().positive(),
      heightMm: z.number().positive(),
      ...pose,
    })
    .strict(),
  z
    .object({
      id: z.string().uuid(),
      kind: z.literal("sphere"),
      radiusMm: z.number().positive(),
      ...pose,
    })
    .strict(),
]);

export const placedPartSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("box"),
      widthMm: z.number().positive(),
      depthMm: z.number().positive(),
      heightMm: z.number().positive(),
      ...pose,
    })
    .strict(),
  z
    .object({
      kind: z.literal("cylinder"),
      radiusMm: z.number().positive(),
      heightMm: z.number().positive(),
      ...pose,
    })
    .strict(),
  z
    .object({
      kind: z.literal("cone"),
      radiusMm: z.number().positive(),
      heightMm: z.number().positive(),
      ...pose,
    })
    .strict(),
  z
    .object({
      kind: z.literal("sphere"),
      radiusMm: z.number().positive(),
      ...pose,
    })
    .strict(),
]);

export const placeInputSchema = z
  .object({
    parts: z.array(placedPartSchema).min(1).max(48),
  })
  .strict();

export type PlacedPart = z.infer<typeof placedPartSchema>;

export const primitiveSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("box"),
      widthMm: z.number().positive(),
      depthMm: z.number().positive(),
      heightMm: z.number().positive(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("cylinder"),
      radiusMm: z.number().positive(),
      heightMm: z.number().positive(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("cone"),
      radiusMm: z.number().positive(),
      heightMm: z.number().positive(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("sphere"),
      radiusMm: z.number().positive(),
    })
    .strict(),
]);

export const sceneSchema = z
  .object({
    bodies: z.array(bodySchema),
    selectedId: z.string().uuid().nullable(),
  })
  .strict();

const findingSchema = z
  .object({
    code: z.enum(["empty", "footprint", "overhang"]),
    measured: z.number(),
    limit: z.number(),
  })
  .strict();

const quoteSchema = z
  .object({
    grams: z.number().nonnegative(),
    hours: z.number().nonnegative(),
    price: z
      .object({
        currency: z.literal("USD"),
        amount: z.number().nonnegative(),
      })
      .strict(),
  })
  .strict();

const measuredSolidSchema = z
  .object({
    boundsMm: vecSchema,
    volumeCm3: z.number(),
    overhangDeg: z.number(),
    mesh: z
      .object({
        positions: z.array(z.number()),
        indices: z.array(z.number().int()),
      })
      .strict(),
  })
  .strict();

export const inspectionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("fail"),
      findings: z.array(findingSchema).min(1),
      solid: measuredSolidSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("pass"),
      findings: z.tuple([]),
      quote: quoteSchema,
      solid: measuredSolidSchema,
    })
    .strict(),
]);

const personaSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    allowedTools: z.array(z.string().min(1)),
  })
  .strict();

const machineSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("idle") }).strict(),
  z
    .object({
      status: z.literal("running"),
      revision: z.number().int(),
    })
    .strict(),
]);

export const snapshotSchema = z
  .object({
    revision: z.number().int().positive(),
    persona: personaSchema,
    personas: z.array(
      z
        .object({
          id: z.string().min(1),
          name: z.string().min(1),
        })
        .strict(),
    ),
    scene: sceneSchema,
    reply: z.string(),
    turns: z.array(
      z
        .object({
          role: z.enum(["user", "designer"]),
          text: z.string().min(1),
        })
        .strict(),
    ),
    inspection: inspectionSchema,
    machine: machineSchema,
    quoteSent: z
      .object({
        revision: z.number().int(),
        messageId: z.string().min(1),
      })
      .strict()
      .nullable(),
    bedMm: vecSchema,
  })
  .strict();

export const effectSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("revised") }).strict(),
  z.object({ type: z.literal("asked") }).strict(),
  z.object({ type: z.literal("persona") }).strict(),
  z.object({ type: z.literal("unquotable") }).strict(),
  z.object({ type: z.literal("sent"), messageId: z.string().min(1) }).strict(),
  z.object({ type: z.literal("duplicate"), messageId: z.string().min(1) }).strict(),
  z.object({ type: z.literal("denied"), reasons: z.array(z.string()) }).strict(),
  z.object({ type: z.literal("not-printable") }).strict(),
  z.object({ type: z.literal("running") }).strict(),
]);

export const actInputSchema = z.discriminatedUnion("tool", [
  z.object({ tool: z.literal(addToolId), solid: primitiveSchema }).strict(),
  z.object({ tool: z.literal(transformToolId), body: bodySchema }).strict(),
  z.object({ tool: z.literal(deleteToolId), id: z.string().uuid() }).strict(),
  z.object({ tool: z.literal(selectToolId), id: z.string().uuid().nullable() }).strict(),
  z.object({ tool: z.literal(promptToolId), text: z.string().min(1) }).strict(),
  z.object({ tool: z.literal(usePersonaToolId), personaId: z.string().min(1) }).strict(),
  z.object({ tool: z.literal(sendQuoteToolId) }).strict(),
  z.object({ tool: z.literal(startMachineToolId) }).strict(),
]);

export const printBenchSnapshot = defineCommand({
  id: "example.print-bench.snapshot",
  input: z.object({}).strict(),
  output: snapshotSchema,
});

export const printBenchAct = defineCommand({
  id: "example.print-bench.act",
  input: actInputSchema,
  output: z
    .object({
      snapshot: snapshotSchema,
      effect: effectSchema,
    })
    .strict(),
  // A quote or a machine start waits on a person. The bus default is 30s.
  timeoutMs: 300_000,
});

export type BenchSnapshot = z.output<typeof snapshotSchema>;
export type ActInput = z.output<typeof actInputSchema>;
export type Primitive = z.output<typeof primitiveSchema>;
export type SceneBody = z.output<typeof bodySchema>;

export const commandIds = [printBenchSnapshot.id, printBenchAct.id] as const;
