import { z } from "@borg/plugin-sdk";

export const PLUGIN_ENABLEMENT_NAMESPACE = "system.plugins";

export const pluginEnablementSchema = z
  .object({
    disabled: z
      .array(z.string().regex(/^[a-z0-9]+(?:[.-][a-z0-9-]+)+$/))
      .max(256)
      .default([]),
  })
  .strict();
