import { defineCommand } from "@borg/contracts";
import { searchProviderStatusSchema } from "@borg/contracts/web-search";
import { z } from "zod";

export const braveGetStatus = defineCommand({
  id: "borg.search.brave.getStatus",
  input: z.object({}).strict(),
  output: searchProviderStatusSchema,
});

export const braveConnect = defineCommand({
  id: "borg.search.brave.connect",
  input: z.object({}).strict(),
  output: searchProviderStatusSchema,
});

export const braveDisconnect = defineCommand({
  id: "borg.search.brave.disconnect",
  input: z.object({}).strict(),
  output: searchProviderStatusSchema,
});
