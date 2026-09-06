import {
  openaiConnect,
  openaiDisconnect,
  openaiGetStatus,
  type OpenAIStatus,
} from "@borg/contracts";
import {
  definePlugin,
  type Disposable,
} from "@borg/plugin-sdk";
import {
  OPENAI_SECRET_KEY,
  OpenAIProvider,
  SAFE_OPENAI_ERRORS,
} from "./runtime";

export default definePlugin({
  id: "borg.openai",
  version: "0.1.0",
  engines: {
    borg: "^0.1.0",
  },
  permissions: [
    "models.register",
    "network:api.openai.com",
    "secrets:read",
    "secrets:write",
    "ui.settings",
    "ui.wizard",
  ],
  contributes: {
    commands: [
      openaiConnect.id,
      openaiDisconnect.id,
      openaiGetStatus.id,
    ],
    kinds: ["llmProvider", "settingsPage", "wizardStep"],
  },
  async activate(context) {
    let registration: Disposable | undefined;

    const status = async (): Promise<OpenAIStatus> => ({
      hasKey: await context.secrets.has(OPENAI_SECRET_KEY),
      connected: registration !== undefined,
    });

    const createProvider = (): OpenAIProvider =>
      new OpenAIProvider({
        fetchImpl: globalThis.fetch.bind(globalThis),
        getApiKey: () => context.secrets.get(OPENAI_SECRET_KEY),
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

    if (await context.secrets.has(OPENAI_SECRET_KEY)) {
      register();
    }

    context.bus.handle(openaiGetStatus, () => status());

    context.bus.handle(openaiConnect, async (_input, signal) => {
      if (!(await context.secrets.has(OPENAI_SECRET_KEY))) {
        throw new Error(SAFE_OPENAI_ERRORS.missingKey);
      }
      const candidate = createProvider();
      await candidate.verify(signal);
      await disposeRegistration();
      registration = context.models.registerProvider(candidate);
      return status();
    });

    context.bus.handle(openaiDisconnect, async () => {
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
