import {
  googleChannelConnect,
  googleChannelDisconnect,
  googleChannelGetStatus,
  googleChannelInject,
} from "@borg/contracts";
import { definePlugin } from "@borg/plugin-sdk";
import { googleChannelConfigSchema } from "./config";
import { GoogleChannelController } from "./runtime";

export {
  googleChannelConfigSchema,
  parseGoogleChannelConfig,
  type GoogleChannelConfig,
} from "./config";
export {
  GOOGLE_ADAPTER_ID,
  GMAIL_API_BASE,
  GOOGLE_APIS_BASE,
  PEOPLE_API_BASE,
} from "./protocol";
export { GmailClient, GmailError } from "./gmail";
export {
  GoogleChannelController,
  GoogleChannelNotStartedError,
} from "./runtime";

export default definePlugin({
  id: "borg.channel.google",
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
      googleChannelConnect.id,
      googleChannelDisconnect.id,
      googleChannelGetStatus.id,
      googleChannelInject.id,
    ],
    kinds: ["channel", "settingsPage", "tool"],
  },
  configSchema: googleChannelConfigSchema,
  async activate(context) {
    const controller = new GoogleChannelController(context);
    const handles = [
      context.bus.handle(googleChannelGetStatus, (input) =>
        controller.status(input.accountId),
      ),
      context.bus.handle(googleChannelConnect, (input, signal) =>
        controller.connect(input.accountId, signal),
      ),
      context.bus.handle(googleChannelDisconnect, (input) =>
        controller.disconnect(input.accountId),
      ),
      context.bus.handle(googleChannelInject, async (input, signal) => {
        signal.throwIfAborted();
        return controller.inject(googleChannelInject.input.parse(input), signal);
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
