import { definePlugin, defineTool, z } from "@borg-agent/plugin-sdk";

export default definePlugin({
  id: "example.night-desk.pager",
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
        id: "night-desk.page",
        description: "Look up one fired page",
        input: z.object({ pageId: z.string() }).strict(),
        output: z
          .object({ host: z.string(), symptom: z.string() })
          .strict(),
        approval: "auto",
        sideEffect: false,
        execute(input) {
          if (input.pageId !== "p-19") {
            throw new Error(`Unknown page ${input.pageId}`);
          }
          return { host: "pager-1", symptom: "disk 98% full" };
        },
      }),
    );
  },
});
