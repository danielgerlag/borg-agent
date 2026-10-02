import { definePlugin, defineTool, z } from "@borg-agent/plugin-sdk";

export default definePlugin({
  id: "example.night-desk.runbook",
  version: "0.1.0",
  engines: {
    borg: "^0.1.0",
  },
  permissions: ["tools.register"],
  contributes: {
    kinds: ["tool"],
  },
  activate(context) {
    context.tools.register(
      defineTool({
        id: "night-desk.mitigate",
        description: "Apply the runbook for a host symptom",
        input: z
          .object({ host: z.string(), symptom: z.string() })
          .strict(),
        output: z.object({ action: z.string() }).strict(),
        approval: "auto",
        sideEffect: true,
        execute(input) {
          if (input.host !== "pager-1" || input.symptom !== "disk 98% full") {
            throw new Error(
              `No mitigation for host ${input.host} symptom ${input.symptom}`,
            );
          }
          return { action: "rotated the log and freed the volume" };
        },
      }),
    );
  },
});
