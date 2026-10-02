import {
  a2aStatusSchema,
  defineCommand,
} from "@borg-agent/contracts";
import { z } from "zod";

export const a2aGetStatus = defineCommand({
  id: "borg.a2a.getStatus",
  input: z.object({}).strict(),
  output: a2aStatusSchema,
});
