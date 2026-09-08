import {
  ollamaConnect,
  ollamaDisconnect,
  ollamaGetStatus,
  type OllamaStatus,
} from "@borg/contracts";
import {
  definePlugin,
  type Disposable,
} from "@borg/plugin-sdk";
import {
  ollamaConfigSchema,
  parseOllamaConfig,
  type OllamaConfig,
} from "./config";
import { OllamaProvider, SAFE_OLLAMA_ERRORS } from "./runtime";

export default definePlugin({
  id: "borg.ollama",
  version: "0.1.0",
  engines: {
    borg: "^0.1.0",
  },
  permissions: ["models.register", "network:dynamic", "ui.settings", "ui.wizard"],
  contributes: {
    commands: [ollamaConnect.id, ollamaDisconnect.id, ollamaGetStatus.id],
    kinds: ["llmProvider", "settingsPage", "wizardStep"],
  },
  configSchema: ollamaConfigSchema,
  async activate(context) {
    let registration: Disposable | undefined;

    const readConfig = async (): Promise<OllamaConfig> =>
      parseOllamaConfig(await context.config.get());

    const status = async (): Promise<OllamaStatus> => {
      const config = await readConfig();
      return {
        connected: registration !== undefined,
        modelCount: config.models.length,
      };
    };

    const createProvider = (config: OllamaConfig): OllamaProvider =>
      new OllamaProvider({
        fetchImpl: globalThis.fetch.bind(globalThis),
        baseUrl: config.baseUrl,
        models: config.models,
      });

    const register = (config: OllamaConfig): void => {
      if (registration || config.models.length === 0) {
        return;
      }
      registration = context.models.registerProvider(createProvider(config));
    };

    const disposeRegistration = async (): Promise<void> => {
      const current = registration;
      registration = undefined;
      await current?.dispose();
    };

    const config = await readConfig();
    if (config.models.length > 0) {
      try {
        register(config);
      } catch (error) {
        if (
          !(error instanceof Error) ||
          error.message !== SAFE_OLLAMA_ERRORS.invalidEndpoint
        ) {
          throw error;
        }
      }
    }

    context.bus.handle(ollamaGetStatus, () => status());

    context.bus.handle(ollamaConnect, async (_input, signal) => {
      const current = await readConfig();
      const candidate = new OllamaProvider({
        fetchImpl: globalThis.fetch.bind(globalThis),
        baseUrl: current.baseUrl,
        models: [],
      });
      const models = await candidate.verify(signal);
      await context.config.update({ models: [...models] });
      await disposeRegistration();
      register({ ...current, models: [...models] });
      return status();
    });

    context.bus.handle(ollamaDisconnect, async () => {
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
