import type { Kernel } from "@borg-agent/kernel";
import { z } from "@borg-agent/plugin-sdk";

const pluginIdSchema = z.string().min(1).max(200);
const secretKeySchema = z.string().min(1).max(200);

export const providerCallSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("plugins") }).strict(),
  z
    .object({
      method: z.literal("secrets.has"),
      pluginId: pluginIdSchema,
      key: secretKeySchema,
    })
    .strict(),
  z
    .object({
      method: z.literal("secrets.set"),
      pluginId: pluginIdSchema,
      key: secretKeySchema,
      value: z.string().min(1).max(8_192),
    })
    .strict(),
  z
    .object({
      method: z.literal("secrets.delete"),
      pluginId: pluginIdSchema,
      key: secretKeySchema,
    })
    .strict(),
  z.object({ method: z.literal("config.get"), pluginId: pluginIdSchema }).strict(),
  z
    .object({
      method: z.literal("config.update"),
      pluginId: pluginIdSchema,
      patch: z.record(z.string(), z.unknown()),
    })
    .strict(),
  z
    .object({
      method: z.literal("bus.invoke"),
      pluginId: pluginIdSchema,
      commandId: z.string().min(1).max(200),
      input: z.unknown(),
    })
    .strict(),
  z.object({ method: z.literal("models.list") }).strict(),
]);

export async function handleProviderCall(kernel: Kernel, body: unknown): Promise<unknown> {
  const call = providerCallSchema.parse(body);
  switch (call.method) {
    case "plugins":
      return kernel.plugins.getActivePluginMetadata().map((plugin) => ({
        id: plugin.id,
        permissions: [...plugin.permissions],
        kinds: [...(plugin.contributes.kinds ?? [])],
      }));
    case "secrets.has":
      requireSecretPermission(kernel, call.pluginId, "secrets:read");
      return kernel.secrets.has(call.pluginId, call.key);
    case "secrets.set":
      requireSecretPermission(kernel, call.pluginId, "secrets:write");
      await kernel.secrets.set(call.pluginId, call.key, call.value);
      return true;
    case "secrets.delete":
      requireSecretPermission(kernel, call.pluginId, "secrets:write");
      await kernel.secrets.delete(call.pluginId, call.key);
      return true;
    case "config.get":
      requireActive(kernel, call.pluginId);
      return kernel.config.get(call.pluginId);
    case "config.update":
      requireActive(kernel, call.pluginId);
      return kernel.config.update(call.pluginId, call.patch);
    case "bus.invoke": {
      const plugin = requireActive(kernel, call.pluginId);
      if (!plugin.contributes.commands?.includes(call.commandId)) {
        throw new Error(`Plugin ${call.pluginId} does not provide ${call.commandId}`);
      }
      return kernel.bus.invokeById(call.commandId, call.input);
    }
    case "models.list":
      return kernel.models.listModels().map((model) => ({
        providerId: model.providerId,
        modelId: model.modelId,
        preferenceId: model.preferenceId,
      }));
    default: {
      const unreachable: never = call;
      return unreachable;
    }
  }
}

function requireActive(kernel: Kernel, pluginId: string) {
  const plugin = kernel.plugins
    .getActivePluginMetadata()
    .find((item) => item.id === pluginId);
  if (!plugin) {
    throw new Error(`Plugin ${pluginId} is not active`);
  }
  return plugin;
}

function requireSecretPermission(
  kernel: Kernel,
  pluginId: string,
  permission: "secrets:read" | "secrets:write",
): void {
  requireActive(kernel, pluginId);
  if (!kernel.plugins.hasPermission(pluginId, permission)) {
    throw new Error(
      permission === "secrets:read"
        ? `Plugin ${pluginId} cannot read secrets`
        : `Plugin ${pluginId} cannot write secrets`,
    );
  }
}
