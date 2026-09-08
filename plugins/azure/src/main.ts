import {
  azureConnect,
  azureDisconnect,
  azureGetStatus,
  type AzureStatus,
} from "@borg/contracts";
import {
  definePlugin,
  type Disposable,
} from "@borg/plugin-sdk";
import {
  azureConfigSchema,
  parseAzureConfig,
  type AzureConfig,
} from "./config";
import {
  AZURE_SECRET_KEY,
  AzureProvider,
  AzureUserError,
  SAFE_AZURE_ERRORS,
  azureUserError,
  createAzureTokenAcquirer,
} from "./runtime";

export default definePlugin({
  id: "borg.azure",
  version: "0.1.0",
  engines: {
    borg: "^0.1.0",
  },
  permissions: [
    "models.register",
    "network:dynamic",
    "secrets:read",
    "secrets:write",
    "ui.settings",
    "ui.wizard",
  ],
  contributes: {
    commands: [azureConnect.id, azureDisconnect.id, azureGetStatus.id],
    kinds: ["llmProvider", "settingsPage", "wizardStep"],
  },
  configSchema: azureConfigSchema,
  async activate(context) {
    let registration: Disposable | undefined;
    const acquireAzureToken = createAzureTokenAcquirer({
      fetchImpl: globalThis.fetch.bind(globalThis),
    });

    const readConfig = async (): Promise<AzureConfig> =>
      parseAzureConfig(await context.config.get());

    const status = async (): Promise<AzureStatus> => {
      const config = await readConfig();
      return {
        hasKey: await context.secrets.has(AZURE_SECRET_KEY),
        connected: registration !== undefined,
        authMode: config.authMode,
      };
    };

    const createProvider = (config: AzureConfig): AzureProvider =>
      new AzureProvider({
        fetchImpl: globalThis.fetch.bind(globalThis),
        endpoint: config.endpoint,
        apiVersion: config.apiVersion,
        authMode: config.authMode,
        models: config.models,
        acquireAzureToken,
        getApiKey: () => context.secrets.get(AZURE_SECRET_KEY),
      });

    const register = (config: AzureConfig): void => {
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

    const canRestore = async (config: AzureConfig): Promise<boolean> => {
      if (config.endpoint.trim().length === 0 || config.models.length === 0) {
        return false;
      }
      if (config.authMode === "api-key") {
        return context.secrets.has(AZURE_SECRET_KEY);
      }
      return true;
    };

    const config = await readConfig();
    if (await canRestore(config)) {
      try {
        register(config);
      } catch (error) {
        if (
          !(error instanceof AzureUserError) ||
          error.headline !== SAFE_AZURE_ERRORS.invalidEndpoint.headline
        ) {
          throw error;
        }
      }
    }

    context.bus.handle(azureGetStatus, () => status());

    context.bus.handle(azureConnect, async (_input, signal) => {
      const current = await readConfig();
      if (current.endpoint.trim().length === 0) {
        throw azureUserError("missingEndpoint");
      }
      if (
        current.authMode === "api-key" &&
        !(await context.secrets.has(AZURE_SECRET_KEY))
      ) {
        throw azureUserError("missingKey");
      }
      const candidate = createProvider({ ...current, models: [] });
      const models = await candidate.verify(signal);
      await context.config.update({ models: [...models] });
      await disposeRegistration();
      register({ ...current, models: [...models] });
      return status();
    });

    context.bus.handle(azureDisconnect, async () => {
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
