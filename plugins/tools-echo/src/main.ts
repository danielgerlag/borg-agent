import { definePlugin, defineTool, z } from "@borg/plugin-sdk";

export default definePlugin({
  id: "borg.tools.echo",
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
        id: "tools.echo",
        description: "Echo text through the kernel tool pipeline",
        input: z.object({ text: z.string() }).strict(),
        output: z.object({ echoed: z.string() }).strict(),
        approval: "ask",
        sideEffect: false,
        execute: ({ text }) => ({ echoed: text }),
      }),
    );
  },
});
