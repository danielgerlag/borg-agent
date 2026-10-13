import { definePlugin } from "@borg-agent/plugin-sdk";

export default definePlugin({
  id: "borg.personas",
  version: "0.1.0",
  engines: {
    borg: "^0.1.0",
  },
  permissions: [
    "models.read",
    "personas.read",
    "personas.write",
    "ui.settings",
    "ui.wizard",
  ],
  contributes: {
    kinds: ["settingsPage", "wizardStep"],
  },
  activate() {
    return undefined;
  },
});
