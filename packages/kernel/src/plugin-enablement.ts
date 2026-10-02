import { z } from "@borg-agent/plugin-sdk";

export const PLUGIN_ENABLEMENT_NAMESPACE = "system.plugins";

/** Manifest ids. Shared with distribution validation. */
export const pluginIdPattern = /^[a-z0-9]+(?:[.-][a-z0-9-]+)+$/;

const pluginIdSchema = z.string().regex(pluginIdPattern);

/**
 * `disabled` defaults to `defaultDisabled` only when the stored document is missing.
 * A stored document replaces the default, including a stored empty list.
 */
export function pluginEnablementSchemaFor(defaultDisabled: readonly string[]) {
  return z
    .object({
      disabled: z.array(pluginIdSchema).max(256).default(() => [...defaultDisabled]),
    })
    .strict();
}

export const pluginEnablementSchema = pluginEnablementSchemaFor([]);
