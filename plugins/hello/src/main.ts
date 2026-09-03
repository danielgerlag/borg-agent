import { helloGetStatus } from "@borg/contracts";
import { definePlugin, z } from "@borg/plugin-sdk";

export default definePlugin({
  id: "borg.hello",
  version: "0.1.0",
  engines: {
    borg: "^0.1.0",
  },
  permissions: ["notifications:send", "ui.flightDeck", "ui.settings"],
  contributes: {
    commands: ["borg.hello.getStatus"],
    kinds: ["flightDeckWidget", "settingsPage"],
  },
  configSchema: z.object({
    message: z.string().trim().min(1).max(80).default("Kernel alive"),
  }),
  activate(context) {
    const startedAt = new Date().toISOString();

    context.bus.handle(helloGetStatus, async () => {
      const config = await context.config.get();
      return {
        pluginId: "borg.hello",
        kernelVersion: context.host.version,
        status: "alive" as const,
        message:
          typeof config.message === "string" ? config.message : "Kernel alive",
        startedAt,
        now: new Date().toISOString(),
      };
    });
  },
});
