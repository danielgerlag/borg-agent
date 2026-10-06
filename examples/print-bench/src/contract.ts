/**
 * Commands, tool ids, and schemas the plugin and the design screen share.
 */

import { defineCommand } from "@borg-agent/contracts";
import { z } from "@borg-agent/plugin-sdk";

export const addToolId = "example.print-bench.add";
export const placeToolId = "example.print-bench.place";
export const transformToolId = "example.print-bench.transform";
export const translateToolId = "example.print-bench.translate";
export const deleteToolId = "example.print-bench.delete";
export const selectToolId = "example.print-bench.select";
export const promptToolId = "example.print-bench.prompt";
export const feedbackAskToolId = "feedback.ask";
export const preferModelToolId = "example.print-bench.prefer-model";
export const newDesignToolId = "example.print-bench.new-design";
export const openDesignToolId = "example.print-bench.open-design";
export const deleteDesignToolId = "example.print-bench.delete-design";

export const designerPersonaId = "print-bench/designer";

/** Persona preference until Settings chooses a connected model. */
export const unconfiguredModelPreference = "example.print-bench:unconfigured";

export const connectModelMessage =
  "Connect a model in Settings, then choose it for the designer.";

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

export const transformToolInput = z.object({ body: bodySchema }).strict();

export const translateToolInput = z
  .object({
    dxMm: z.number(),
    dyMm: z.number(),
    dzMm: z.number(),
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

export const addToolInput = z.object({ solid: primitiveSchema }).strict();

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

const designSummarySchema = z
  .object({
    id: z.string().uuid(),
    title: z.string().min(1).max(48),
    updatedAt: z.string().min(1),
    solids: z.number().int().nonnegative(),
  })
  .strict();

export const snapshotSchema = z
  .object({
    design: z
      .object({
        id: z.string().uuid(),
        title: z.string().min(1).max(48),
      })
      .strict(),
    designs: z.array(designSummarySchema).min(1),
    revision: z.number().int().positive(),
    persona: personaSchema,
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
    bedMm: vecSchema,
    designerModel: z.string().min(1).nullable(),
  })
  .strict();

export const effectSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("revised") }).strict(),
  z.object({ type: z.literal("asked") }).strict(),
  z.object({ type: z.literal("model") }).strict(),
  z.object({ type: z.literal("design") }).strict(),
]);

export const actInputSchema = z.discriminatedUnion("tool", [
  z.object({ tool: z.literal(addToolId), solid: primitiveSchema }).strict(),
  z.object({ tool: z.literal(transformToolId), body: bodySchema }).strict(),
  z.object({ tool: z.literal(deleteToolId), id: z.string().uuid() }).strict(),
  z.object({ tool: z.literal(selectToolId), id: z.string().uuid().nullable() }).strict(),
  z.object({ tool: z.literal(promptToolId), text: z.string().min(1) }).strict(),
  z
    .object({
      tool: z.literal(preferModelToolId),
      preferenceId: z.string().regex(/^[a-z0-9]+(?:[.-][a-z0-9-]+)+:\S+$/),
    })
    .strict(),
  z.object({ tool: z.literal(newDesignToolId) }).strict(),
  z.object({ tool: z.literal(openDesignToolId), designId: z.string().uuid() }).strict(),
  z.object({ tool: z.literal(deleteDesignToolId), designId: z.string().uuid() }).strict(),
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
  // A designer question waits on a person. The bus default is 30s.
  timeoutMs: 300_000,
});

export type BenchSnapshot = z.output<typeof snapshotSchema>;
export type ActInput = z.output<typeof actInputSchema>;
export type Primitive = z.output<typeof primitiveSchema>;
export type SceneBody = z.output<typeof bodySchema>;

export const commandIds = [printBenchSnapshot.id, printBenchAct.id] as const;
