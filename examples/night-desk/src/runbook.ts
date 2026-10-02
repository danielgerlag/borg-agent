import { definePlugin, defineTool, z } from "@borg-agent/plugin-sdk";
import { nightDeskMitigate } from "./contract";

function mitigate(host: string, symptom: string): { action: string } {
  if (host !== "pager-1" || symptom !== "disk 98% full") {
    throw new Error(`No mitigation for host ${host} symptom ${symptom}`);
  }
  return { action: "rotated the log and freed the volume" };
}

export default definePlugin({
  id: "example.night-desk.runbook",
  version: "0.1.0",
  engines: {
    borg: "^0.1.0",
  },
  permissions: ["tools.register"],
  contributes: {
    commands: [nightDeskMitigate.id],
    kinds: ["tool"],
  },
  activate(context) {
    context.bus.handle(nightDeskMitigate, async (input) =>
      mitigate(input.host, input.symptom),
    );
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
          return mitigate(input.host, input.symptom);
        },
      }),
    );
  },
});
