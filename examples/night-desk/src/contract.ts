import { defineCommand } from "@borg-agent/contracts";
import { z } from "@borg-agent/plugin-sdk";

export const nightDeskGetPage = defineCommand({
  id: "example.night-desk.getPage",
  input: z.object({ pageId: z.string() }).strict(),
  output: z.object({ host: z.string(), symptom: z.string() }).strict(),
});

export const nightDeskMitigate = defineCommand({
  id: "example.night-desk.mitigate",
  input: z.object({ host: z.string(), symptom: z.string() }).strict(),
  output: z.object({ action: z.string() }).strict(),
});
