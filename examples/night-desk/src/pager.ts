import { definePlugin, defineTool, z } from "@borg-agent/plugin-sdk";
import { nightDeskGetPage } from "./contract";

function lookupPage(pageId: string): { host: string; symptom: string } {
  if (pageId !== "p-19") {
    throw new Error(`Unknown page ${pageId}`);
  }
  return { host: "pager-1", symptom: "disk 98% full" };
}

export default definePlugin({
  id: "example.night-desk.pager",
  version: "0.1.0",
  engines: {
    borg: "^0.1.0",
  },
  permissions: ["tools.register"],
  contributes: {
    commands: [nightDeskGetPage.id],
    kinds: ["tool"],
  },
  activate(context) {
    context.bus.handle(nightDeskGetPage, async (input) => lookupPage(input.pageId));
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
          return lookupPage(input.pageId);
        },
      }),
    );
  },
});
