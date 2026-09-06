import { definePlugin } from "@borg/plugin-sdk";

export const CONTEXT_MAP_SLOT_ID = "borg.context-map.workspace";

export default definePlugin({
  id: "borg.context-map",
  version: "0.1.0",
  engines: {
    borg: "^0.1.0",
  },
  permissions: ["prompts.register"],
  contributes: {
    kinds: ["promptSlot"],
  },
  activate(context) {
    return context.prompts.registerSlot({
      id: CONTEXT_MAP_SLOT_ID,
      order: 300,
      async render(slotContext) {
        if (slotContext.workspace === undefined) {
          return undefined;
        }
        const files = await slotContext.workspace.listFiles();
        if (files.length === 0) {
          return undefined;
        }
        return `Workspace files:\n${files
          .map((file) => file.path)
          .join("\n")}`;
      },
    });
  },
});
