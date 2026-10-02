import { defineCommand } from "@borg-agent/contracts";
import { z } from "@borg-agent/plugin-sdk";

export const fieldObserve = defineCommand({
  id: "example.field.observe",
  input: z.object({ species: z.string(), place: z.string() }).strict(),
  output: z
    .object({
      inRange: z.boolean(),
      species: z.string(),
      place: z.string(),
    })
    .strict(),
});

export const fieldVoucher = defineCommand({
  id: "example.field.voucher",
  input: z.object({ species: z.string(), place: z.string() }).strict(),
  output: z.discriminatedUnion("filed", [
    z.object({ filed: z.literal(true), voucher: z.string() }).strict(),
    z.object({ filed: z.literal(false), reason: z.string() }).strict(),
  ]),
});
