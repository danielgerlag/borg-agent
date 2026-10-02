import { defineCommand } from "@borg-agent/contracts";
import { z } from "@borg-agent/plugin-sdk";

export const reviseToolId = "example.print-bench.revise";
export const acceptToolId = "example.print-bench.accept";
export const proposeToolId = "example.print-bench.propose";
export const askToolId = "example.print-bench.ask";
export const sendQuoteToolId = "example.print-bench.send-quote";
export const startMachineToolId = "example.print-bench.start-machine";
export const usePersonaToolId = "example.print-bench.use-persona";

export const designerPersonaId = "print-bench/designer";
export const frontDeskPersonaId = "print-bench/front-desk";
export const operatorPersonaId = "print-bench/operator";

export const parametersSchema = z
  .object({
    wallMm: z.number().positive(),
    holeMm: z.number().positive(),
    footprint: z
      .object({
        widthMm: z.number().positive(),
        depthMm: z.number().positive(),
      })
      .strict(),
    chamferDeg: z.number().min(0).max(90),
  })
  .strict();

const vecSchema = z
  .object({
    x: z.number(),
    y: z.number(),
    z: z.number(),
  })
  .strict();

const findingSchema = z
  .object({
    code: z.enum(["wall", "hole", "footprint", "overhang"]),
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

const solidSchema = z
  .object({
    wallMm: z.number(),
    holeMm: z.number(),
    facetAngleDeg: z.number(),
    boundsMm: vecSchema,
    volumeCm3: z.number(),
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
      solid: solidSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("pass"),
      findings: z.tuple([]),
      quote: quoteSchema,
      solid: solidSchema,
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
    parameters: parametersSchema,
    inspection: inspectionSchema,
    proposal: z
      .object({
        id: z.string().uuid(),
        parameters: parametersSchema,
        inspection: inspectionSchema,
      })
      .strict()
      .nullable(),
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
  z.object({ type: z.literal("accepted") }).strict(),
  z.object({ type: z.literal("asked") }).strict(),
  z.object({ type: z.literal("persona") }).strict(),
  z.object({ type: z.literal("unquotable") }).strict(),
  z
    .object({
      type: z.literal("sent"),
      messageId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("duplicate"),
      messageId: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("denied"),
      reasons: z.array(z.string()),
    })
    .strict(),
  z.object({ type: z.literal("not-printable") }).strict(),
  z.object({ type: z.literal("running") }).strict(),
]);

export const actInputSchema = z.discriminatedUnion("tool", [
  z
    .object({
      tool: z.literal(reviseToolId),
      parameters: parametersSchema,
    })
    .strict(),
  z.object({ tool: z.literal(acceptToolId) }).strict(),
  z
    .object({
      tool: z.literal(proposeToolId),
      parameters: parametersSchema,
    })
    .strict(),
  z.object({ tool: z.literal(askToolId) }).strict(),
  z
    .object({
      tool: z.literal(usePersonaToolId),
      personaId: z.string().min(1),
    })
    .strict(),
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

export const commandIds = [printBenchSnapshot.id, printBenchAct.id] as const;
