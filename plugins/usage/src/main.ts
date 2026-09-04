import { definePlugin } from "@borg/plugin-sdk";

export default definePlugin({
  id: "borg.usage",
  version: "0.1.0",
  engines: {
    borg: "^0.1.0",
  },
  permissions: ["cost.read", "ui.flightDeck"],
  contributes: {
    kinds: ["flightDeckWidget"],
  },
  activate() {},
});
