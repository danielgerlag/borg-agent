import {
  openrouterConnect,
  openrouterDisconnect,
  openrouterGetStatus,
  type OpenRouterStatus,
} from "@borg/contracts";
import {
  definePlugin,
  type Disposable,
} from "@borg/plugin-sdk";
import {
  openrouterConfigSchema,
  parseOpenRouterConfig,
  type OpenRouterConfig,
} from "./config";
import {
  OPENROUTER_SECRET_KEY,
  OpenRouterProvider,
  SAFE_OPENROUTER_ERRORS,
} from "./runtime";

export default definePlugin({
  id: "borg.openrouter",
  version: "0.1.0",
  engines: {
    borg: "^0.1.0",
  },
  permissions: [
    "models.register",
    "network:openrouter.ai",
    "secrets:read",
    "secrets:write",
    "ui.settings",
    "ui.wizard",
  ],
  contributes: {
    commands: [
      openrouterConnect.id,
      openrouterDisconnect.id,
      openrouterGetStatus.id,
    ],
    kinds: ["llmProvider", "settingsPage", "wizardStep"],
  },
  configSchema: openrouterConfigSchema,
  async activate(context) {
    let registration: Disposable | undefined;

    const readConfig = async (): Promise<OpenRouterConfig> =>
      parseOpenRouterConfig(await context.config.get());

    const status = async (): Promise<OpenRouterStatus> => ({
      hasKey: await context.secrets.has(OPENROUTER_SECRET_KEY),
      connected: registration !== undefined,
    });

    const createProvider = (models: readonly string[]): OpenRouterProvider =>
      new OpenRouterProvider({
        fetchImpl: globalThis.fetch.bind(globalThis),
        models,
        getApiKey: () => context.secrets.get(OPENROUTER_SECRET_KEY),
      });

    const register = (models: readonly string[]): void => {
      if (registration || models.length === 0) {
        return;
      }
      registration = context.models.registerProvider(createProvider(models));
    };

    const disposeRegistration = async (): Promise<void> => {
      const current = registration;
      registration = undefined;
      await current?.dispose();
    };

    const config = await readConfig();
    if (
      (await context.secrets.has(OPENROUTER_SECRET_KEY)) &&
      config.models.length > 0
    ) {
      register(config.models);
    }

    context.bus.handle(openrouterGetStatus, () => status());

    context.bus.handle(openrouterConnect, async (_input, signal) => {
      if (!(await context.secrets.has(OPENROUTER_SECRET_KEY))) {
        throw new Error(SAFE_OPENROUTER_ERRORS.missingKey);
      }
      const candidate = createProvider([]);
      const models = await candidate.verify(signal);
      await context.config.update({ models: [...models] });
      await disposeRegistration();
      register(models);
      return status();
    });

    context.bus.handle(openrouterDisconnect, async () => {
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
