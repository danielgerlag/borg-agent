import {
  anthropicConnect,
  anthropicDisconnect,
  anthropicGetStatus,
  type AnthropicStatus,
} from "@borg/contracts";
import {
  definePlugin,
  type Disposable,
} from "@borg/plugin-sdk";
import {
  ANTHROPIC_SECRET_KEY,
  AnthropicProvider,
  SAFE_ANTHROPIC_ERRORS,
} from "./runtime";

export default definePlugin({
  id: "borg.anthropic",
  version: "0.1.0",
  engines: {
    borg: "^0.1.0",
  },
  permissions: [
    "models.register",
    "network:api.anthropic.com",
    "secrets:read",
    "secrets:write",
    "ui.settings",
    "ui.wizard",
  ],
  contributes: {
    commands: [
      anthropicConnect.id,
      anthropicDisconnect.id,
      anthropicGetStatus.id,
    ],
    kinds: ["llmProvider", "settingsPage", "wizardStep"],
  },
  async activate(context) {
    let registration: Disposable | undefined;

    const status = async (): Promise<AnthropicStatus> => ({
      hasKey: await context.secrets.has(ANTHROPIC_SECRET_KEY),
      connected: registration !== undefined,
    });

    const createProvider = (): AnthropicProvider =>
      new AnthropicProvider({
        fetchImpl: globalThis.fetch.bind(globalThis),
        getApiKey: () => context.secrets.get(ANTHROPIC_SECRET_KEY),
      });

    const register = (): void => {
      if (registration) {
        return;
      }
      registration = context.models.registerProvider(createProvider());
    };

    const disposeRegistration = async (): Promise<void> => {
      const current = registration;
      registration = undefined;
      await current?.dispose();
    };

    if (await context.secrets.has(ANTHROPIC_SECRET_KEY)) {
      register();
    }

    context.bus.handle(anthropicGetStatus, () => status());

    context.bus.handle(anthropicConnect, async (_input, signal) => {
      if (!(await context.secrets.has(ANTHROPIC_SECRET_KEY))) {
        throw new Error(SAFE_ANTHROPIC_ERRORS.missingKey);
      }
      const candidate = createProvider();
      await candidate.verify(signal);
      await disposeRegistration();
      registration = context.models.registerProvider(candidate);
      return status();
    });

    context.bus.handle(anthropicDisconnect, async () => {
      await disposeRegistration();
      return status();
    });

    return {
      dispose: async () => {
        await disposeRegistration();
      },
    };
  },
});
