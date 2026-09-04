import type { McpServerConfig } from "@borg/contracts";
import type { PluginSecrets } from "@borg/plugin-sdk";

export interface ResolvedSecrets {
  readonly env: Readonly<Record<string, string>>;
  readonly headers: Readonly<Record<string, string>>;
  readonly values: readonly string[];
}

export async function resolveServerSecrets(
  secrets: PluginSecrets,
  config: McpServerConfig,
): Promise<ResolvedSecrets> {
  const values: string[] = [];
  if (config.transport === "stdio") {
    const env: Record<string, string> = Object.create(null) as Record<
      string,
      string
    >;
    for (const [name, key] of Object.entries(config.environmentSecretRefs)) {
      const value = await secrets.get(key);
      if (value === undefined) {
        throw new Error(`MCP secret ${key} is unavailable`);
      }
      env[name] = value;
      values.push(value);
    }
    return { env, headers: {}, values };
  }
  const headers: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  for (const [name, key] of Object.entries(config.headerSecretRefs)) {
    const value = await secrets.get(key);
    if (value === undefined) {
      throw new Error(`MCP secret ${key} is unavailable`);
    }
    headers[name] = value;
    values.push(value);
  }
  return { env: {}, headers, values };
}
