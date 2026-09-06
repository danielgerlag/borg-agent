import {
  a2aConfigSchema,
  a2aGetStatus,
  type A2AConfig,
  type A2AStatus,
} from "@borg/contracts";
import { definePlugin } from "@borg/plugin-sdk";

function asStatus(config: A2AConfig): A2AStatus {
  return {
    enabled: config.enabled,
    listening: config.enabled,
    port: config.port,
    ...(config.personaId !== undefined ? { personaId: config.personaId } : {}),
  };
}

export default definePlugin({
  id: "borg.a2a",
  version: "0.1.0",
  engines: {
    borg: "^0.1.0",
  },
  permissions: [
    "loops.start",
    "personas.read",
    "tools.invoke",
    "ui.flightDeck",
    "ui.settings",
    "workspace.manage",
  ],
  contributes: {
    commands: [a2aGetStatus.id],
    kinds: ["flightDeckWidget", "settingsPage"],
  },
  configSchema: a2aConfigSchema,
  activate(context) {
    context.bus.handle(a2aGetStatus, async () =>
      asStatus(a2aConfigSchema.parse(await context.config.get())),
    );
  },
});
