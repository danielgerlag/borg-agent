import { defineCommand } from "@borg-agent/contracts";
import { searchProviderStatusSchema } from "@borg-agent/contracts/web-search";
import { z } from "zod";

export const tavilyGetStatus = defineCommand({
  id: "borg.search.tavily.getStatus",
  input: z.object({}).strict(),
  output: searchProviderStatusSchema,
});

export const tavilyConnect = defineCommand({
  id: "borg.search.tavily.connect",
  input: z.object({}).strict(),
  output: searchProviderStatusSchema,
});

export const tavilyDisconnect = defineCommand({
  id: "borg.search.tavily.disconnect",
  input: z.object({}).strict(),
  output: searchProviderStatusSchema,
});
