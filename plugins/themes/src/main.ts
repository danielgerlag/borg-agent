import { definePlugin, z } from "@borg/plugin-sdk";

export const themeConfigSchema = z
  .object({
    theme: z.enum(["dark", "light"]).default("dark"),
  })
  .strict();

export default definePlugin({
  id: "borg.themes",
  version: "0.1.0",
  engines: {
    borg: "^0.1.0",
  },
  permissions: ["ui.settings"],
  contributes: {
    kinds: ["settingsPage"],
  },
  configSchema: themeConfigSchema,
  activate() {
    return undefined;
  },
});
