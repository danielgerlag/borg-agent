import {
  m365ChannelConnect,
  m365ChannelDisconnect,
  m365ChannelGetStatus,
  m365ChannelInject,
} from "@borg/contracts";
import { definePlugin } from "@borg/plugin-sdk";
import { m365ChannelConfigSchema } from "./config";
import { M365ChannelController } from "./runtime";

export {
  m365ChannelConfigSchema,
  parseM365ChannelConfig,
  type M365ChannelConfig,
} from "./config";
export { M365_ADAPTER_ID, GRAPH_API_BASE } from "./protocol";
export { GraphClient, GraphError } from "./graph";
export { M365ChannelController, M365ChannelNotStartedError } from "./runtime";

export default definePlugin({
  id: "borg.channel.m365",
  version: "0.1.0",
  engines: {
    borg: "^0.1.0",
  },
  permissions: [
    "channels.register",
    "oauth.connect",
    "network:dynamic",
    "runtime.background",
    "tools.register",
    "ui.settings",
  ],
  contributes: {
    commands: [
      m365ChannelConnect.id,
      m365ChannelDisconnect.id,
      m365ChannelGetStatus.id,
      m365ChannelInject.id,
    ],
    kinds: ["channel", "settingsPage", "tool"],
  },
  configSchema: m365ChannelConfigSchema,
  async activate(context) {
    const controller = new M365ChannelController(context);
    const handles = [
      context.bus.handle(m365ChannelGetStatus, () => controller.status()),
      context.bus.handle(m365ChannelConnect, (_input, signal) =>
        controller.connect(signal),
      ),
      context.bus.handle(m365ChannelDisconnect, () => controller.disconnect()),
      context.bus.handle(m365ChannelInject, async (input, signal) => {
        signal.throwIfAborted();
        return controller.inject(m365ChannelInject.input.parse(input), signal);
      }),
    ];
    await controller.initialize();
    return {
      dispose: async () => {
        for (const handle of handles) {
          handle.dispose();
        }
        await controller.dispose();
      },
    };
  },
});
