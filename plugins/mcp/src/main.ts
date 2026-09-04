import {
  mcpAppDiscovered,
  mcpGetStatus,
  mcpListServers,
  mcpRefresh,
} from "@borg/contracts";
import { definePlugin, defineToolProvider } from "@borg/plugin-sdk";
import { McpCatalogManager } from "./catalog";

export default definePlugin({
  id: "borg.mcp",
  version: "0.1.0",
  engines: {
    borg: "^0.1.0",
  },
  permissions: [
    "network:dynamic",
    "personas.read",
    "personas.write",
    "secrets:read",
    "subprocess:mcp",
    "tools.provide",
    "ui.settings",
  ],
  contributes: {
    commands: [mcpGetStatus.id, mcpListServers.id, mcpRefresh.id],
    events: [mcpAppDiscovered.id],
    kinds: ["settingsPage", "toolProvider"],
  },
  activate(context) {
    const manager = new McpCatalogManager(context);
    const provider = context.tools.registerProvider(
      defineToolProvider({
        id: "borg.mcp",
        namespace: "mcp",
        prepare: (scope) => manager.prepare(scope),
      }),
    );
    const list = context.bus.handle(mcpListServers, ({ personaId }) => ({
      servers: manager.snapshots(personaId),
    }));
    const status = context.bus.handle(mcpGetStatus, ({ serverId, personaId }) =>
      manager.snapshot(serverId, personaId),
    );
    const refresh = context.bus.handle(
      mcpRefresh,
      ({ serverId, personaId }, signal) =>
        manager.refresh(serverId, personaId, signal).then((servers) => ({
          servers,
        })),
    );
    return {
      dispose: async () => {
        list.dispose();
        status.dispose();
        refresh.dispose();
        provider.dispose();
        await manager.close();
      },
    };
  },
});
