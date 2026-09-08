import {
  copilotConnect,
  copilotDisconnect,
  copilotGetStatus,
  copilotPollDeviceFlow,
  copilotStartDeviceFlow,
  type CopilotDeviceFlowPoll,
  type CopilotStatus,
} from "@borg/contracts";
import {
  definePlugin,
  type Disposable,
} from "@borg/plugin-sdk";
import {
  copilotConfigSchema,
  parseCopilotConfig,
  type CopilotConfig,
} from "./config";
import {
  COPILOT_SECRET_KEY,
  CopilotProvider,
  SAFE_COPILOT_ERRORS,
  pollCopilotDeviceFlow,
  resolveCopilotOauthToken,
  startCopilotDeviceFlow,
  type CopilotDeviceFlowSession,
} from "./runtime";

export default definePlugin({
  id: "borg.copilot",
  version: "0.1.0",
  engines: {
    borg: "^0.1.0",
  },
  permissions: [
    "models.register",
    "network:api.github.com",
    "network:api.githubcopilot.com",
    "network:github.com",
    "secrets:read",
    "secrets:write",
    "ui.settings",
    "ui.wizard",
  ],
  contributes: {
    commands: [
      copilotConnect.id,
      copilotDisconnect.id,
      copilotGetStatus.id,
      copilotPollDeviceFlow.id,
      copilotStartDeviceFlow.id,
    ],
    kinds: ["llmProvider", "settingsPage", "wizardStep"],
  },
  configSchema: copilotConfigSchema,
  async activate(context) {
    let registration: Disposable | undefined;
    let pendingDeviceFlow: CopilotDeviceFlowSession | undefined;

    const readConfig = async (): Promise<CopilotConfig> =>
      parseCopilotConfig(await context.config.get());

    const hasToken = async (): Promise<boolean> =>
      (await resolveCopilotOauthToken({
        getSecret: () => context.secrets.get(COPILOT_SECRET_KEY),
      })) !== undefined;

    const status = async (): Promise<CopilotStatus> => ({
      hasToken: await hasToken(),
      connected: registration !== undefined,
    });

    const createProvider = (models: readonly string[]): CopilotProvider =>
      new CopilotProvider({
        fetchImpl: globalThis.fetch.bind(globalThis),
        models,
        getOauthToken: () => context.secrets.get(COPILOT_SECRET_KEY),
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
    if ((await hasToken()) && config.models.length > 0) {
      register(config.models);
    }

    context.bus.handle(copilotGetStatus, () => status());

    context.bus.handle(copilotStartDeviceFlow, async (_input, signal) => {
      const started = await startCopilotDeviceFlow({
        fetchImpl: globalThis.fetch.bind(globalThis),
        signal,
      });
      pendingDeviceFlow = started.session;
      return started.public;
    });

    context.bus.handle(copilotPollDeviceFlow, async (_input, signal) => {
      if (!pendingDeviceFlow) {
        return {
          status: "failed",
          error: SAFE_COPILOT_ERRORS.deviceFlowInactive,
        } satisfies CopilotDeviceFlowPoll;
      }
      if (Date.now() > pendingDeviceFlow.expiresAtMs) {
        pendingDeviceFlow = undefined;
        return {
          status: "failed",
          error: SAFE_COPILOT_ERRORS.deviceFlowExpired,
        } satisfies CopilotDeviceFlowPoll;
      }
      const result = await pollCopilotDeviceFlow({
        deviceCode: pendingDeviceFlow.deviceCode,
        fetchImpl: globalThis.fetch.bind(globalThis),
        signal,
      });
      if (result.status === "pending") {
        return { status: "pending" } satisfies CopilotDeviceFlowPoll;
      }
      pendingDeviceFlow = undefined;
      if (result.status === "complete") {
        await context.secrets.set(COPILOT_SECRET_KEY, result.accessToken);
        return { status: "complete" } satisfies CopilotDeviceFlowPoll;
      }
      return { status: "failed", error: result.error } satisfies CopilotDeviceFlowPoll;
    });

    context.bus.handle(copilotConnect, async (_input, signal) => {
      if (!(await hasToken())) {
        throw new Error(SAFE_COPILOT_ERRORS.missingToken);
      }
      const candidate = createProvider([]);
      const models = await candidate.verify(signal);
      await context.config.update({ models: [...models] });
      await disposeRegistration();
      register(models);
      return status();
    });

    context.bus.handle(copilotDisconnect, async () => {
      await disposeRegistration();
      return status();
    });

    return {
      dispose: async () => {
        pendingDeviceFlow = undefined;
        await disposeRegistration();
      },
    };
  },
});
