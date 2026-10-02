import { definePlugin, defineTool, z } from "@borg-agent/plugin-sdk";

const range = [{ species: "cicindela sexguttata", place: "point pelee" }] as const;

type Sighting = {
  species: string;
  place: string;
  inRange: boolean;
};

const observation = z
  .object({
    inRange: z.boolean(),
    species: z.string(),
    place: z.string(),
  })
  .strict();

const voucherResult = z.discriminatedUnion("filed", [
  z
    .object({
      filed: z.literal(true),
      voucher: z.string(),
    })
    .strict(),
  z
    .object({
      filed: z.literal(false),
      reason: z.string(),
    })
    .strict(),
]);

function sightingInRange(species: string, place: string): boolean {
  return range.some((row) => row.species === species && row.place === place);
}

export default definePlugin({
  id: "example.field.catalog",
  version: "0.1.0",
  engines: {
    borg: "^0.1.0",
  },
  permissions: ["tools.register"],
  contributes: {
    kinds: ["tool"],
  },
  activate(context) {
    let last: Sighting | undefined;
    context.tools.register(
      defineTool({
        id: "field.observe",
        description: "Record a sighting and whether it is in range",
        input: z.object({ species: z.string(), place: z.string() }).strict(),
        output: observation,
        approval: "auto",
        sideEffect: true,
        execute(input) {
          const sighting: Sighting = {
            species: input.species,
            place: input.place,
            inRange: sightingInRange(input.species, input.place),
          };
          last = sighting;
          return sighting;
        },
      }),
    );
    context.tools.register(
      defineTool({
        id: "field.voucher",
        description: "File a voucher for the last in-range sighting",
        input: z.object({ species: z.string(), place: z.string() }).strict(),
        output: voucherResult,
        approval: "auto",
        sideEffect: true,
        execute(input): z.infer<typeof voucherResult> {
          if (
            last === undefined ||
            last.species !== input.species ||
            last.place !== input.place
          ) {
            return { filed: false, reason: "last sighting does not match" };
          }
          if (!last.inRange) {
            return { filed: false, reason: "out of range" };
          }
          return { filed: true, voucher: "FC-1042" };
        },
      }),
    );
  },
});
