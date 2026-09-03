import {
  CommandInvocationError,
  type CommandEventBus,
  type ConfigFacade,
  type NotificationService,
  type PluginManager,
  type SecretFacade,
} from "@borg/kernel";
import {
  BrowserWindow,
  ipcMain,
  type Event as ElectronEvent,
  type IpcMainInvokeEvent,
} from "electron";
import { z } from "zod";

const commandInvokeSchema = z.object({
  id: z.string().min(1),
  input: z.unknown(),
});

const kernelCallSchema = z.discriminatedUnion("method", [
  z.object({
    method: z.literal("command.provides"),
    args: z.object({ id: z.string().min(1) }),
  }),
  z.object({
    method: z.literal("window.hide"),
    args: z.object({ capability: z.string().uuid() }),
  }),
  z.object({
    method: z.literal("window.show"),
    args: z.object({ capability: z.string().uuid() }),
  }),
  z.object({
    method: z.literal("window.quit"),
    args: z.object({ capability: z.string().uuid() }),
  }),
  z.object({
    method: z.literal("config.get"),
    args: z.object({ capability: z.string().uuid() }),
  }),
  z.object({
    method: z.literal("config.update"),
    args: z.object({
      capability: z.string().uuid(),
      patch: z.record(z.string(), z.unknown()),
    }),
  }),
  z.object({
    method: z.literal("secrets.has"),
    args: z.object({
      capability: z.string().uuid(),
      key: z.string().min(1),
    }),
  }),
  z.object({
    method: z.literal("secrets.set"),
    args: z.object({
      capability: z.string().uuid(),
      key: z.string().min(1),
      value: z.string(),
    }),
  }),
  z.object({
    method: z.literal("secrets.delete"),
    args: z.object({
      capability: z.string().uuid(),
      key: z.string().min(1),
    }),
  }),
  z.object({
    method: z.literal("notifications.show"),
    args: z.object({
      capability: z.string().uuid(),
      request: z.object({
        title: z.string().min(1).max(100),
        body: z.string().max(500),
        level: z.enum(["info", "success", "warning", "error"]).optional(),
        os: z.boolean().optional(),
      }),
    }),
  }),
  z.object({
    method: z.literal("setup.complete"),
    args: z.object({ capability: z.string().uuid() }),
  }),
]);

interface IpcSuccess {
  readonly ok: true;
  readonly value: unknown;
}

interface IpcFailure {
  readonly ok: false;
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}

type IpcResult = IpcSuccess | IpcFailure;

function success(value: unknown): IpcSuccess {
  return { ok: true, value };
}

function failure(error: unknown): IpcFailure {
  if (error instanceof CommandInvocationError) {
    return {
      ok: false,
      error: error.toJSON(),
    };
  }

  return {
    ok: false,
    error: {
      code: "failed",
      message: error instanceof Error ? error.message : "Kernel call failed",
    },
  };
}

function assertTrustedSender(
  event: IpcMainInvokeEvent,
  getMainWindow: () => BrowserWindow | undefined,
  rendererUrl: string,
): void {
  const window = getMainWindow();
  if (
    !window ||
    event.sender !== window.webContents ||
    !event.senderFrame ||
    event.senderFrame !== window.webContents.mainFrame
  ) {
    throw new Error("IPC request did not originate from the Borg main frame");
  }
  const senderUrl = new URL(event.senderFrame.url);
  const expectedUrl = new URL(rendererUrl);
  if (
    senderUrl.protocol !== expectedUrl.protocol ||
    senderUrl.host !== expectedUrl.host ||
    senderUrl.pathname !== expectedUrl.pathname
  ) {
    throw new Error("IPC request did not originate from the Borg main frame");
  }
}

function resolveUiPlugin(
  plugins: PluginManager,
  capability: string,
  permission?: string,
): string {
  const pluginId = plugins.resolveUiCapability(capability);
  if (!pluginId) {
    throw new Error("Renderer plugin capability is invalid or expired");
  }
  if (permission && !plugins.hasPermission(pluginId, permission)) {
    throw new Error(`Plugin ${pluginId} lacks permission ${permission}`);
  }
  return pluginId;
}

export interface IpcBridgeOptions {
  readonly bus: CommandEventBus;
  readonly plugins: PluginManager;
  readonly config: ConfigFacade;
  readonly secrets: SecretFacade;
  readonly notifications: NotificationService;
  readonly kernelVersion: string;
  readonly startedAt: string;
  readonly shellCapability: string;
  readonly rendererUrl: string;
  getSetupState(): Promise<Readonly<Record<string, unknown>>>;
  getRecovery(): { readonly message: string } | undefined;
  completeSetup(): Promise<Readonly<Record<string, unknown>>>;
  getMainWindow(): BrowserWindow | undefined;
  requestQuit(): void;
}

export function registerIpcBridge(options: IpcBridgeOptions): () => Promise<void> {
  let bootstrapConsumedBy: number | undefined;
  let activeCalls = 0;
  const drainWaiters = new Set<() => void>();
  const track = async <T>(operation: () => Promise<T>): Promise<T> => {
    activeCalls += 1;
    try {
      return await operation();
    } finally {
      activeCalls -= 1;
      if (activeCalls === 0) {
        for (const resolve of drainWaiters) {
          resolve();
        }
        drainWaiters.clear();
      }
    }
  };

  ipcMain.handle(
    "borg:command:invoke",
    (event, payload): Promise<IpcResult> =>
      track(async () => {
        try {
          assertTrustedSender(event, options.getMainWindow, options.rendererUrl);
          const request = commandInvokeSchema.parse(payload);
          return success(await options.bus.invokeById(request.id, request.input));
        } catch (error) {
          return failure(error);
        }
      }),
  );

  ipcMain.handle("borg:kernel:bootstrap", (event): Promise<IpcResult> =>
    track(async () => {
      try {
      assertTrustedSender(event, options.getMainWindow, options.rendererUrl);
      if (bootstrapConsumedBy === event.sender.id) {
        throw new Error("Renderer bootstrap capability has already been consumed");
      }
      bootstrapConsumedBy = event.sender.id;
      const sender = event.sender;
      const resetBootstrap = (
        _navigationEvent: ElectronEvent,
        _url: string,
        _httpResponseCode: number,
        _httpStatusText: string,
        isMainFrame: boolean,
      ): void => {
        if (
          isMainFrame &&
          bootstrapConsumedBy === sender.id
        ) {
          bootstrapConsumedBy = undefined;
          sender.removeListener("did-frame-navigate", resetBootstrap);
        }
      };
      sender.on("did-frame-navigate", resetBootstrap);
      const recovery = options.getRecovery();
      return success({
        kernelVersion: options.kernelVersion,
        startedAt: options.startedAt,
        activePluginIds: options.plugins.getActivePluginIds(),
        activePlugins: options.plugins.getActivePluginMetadata(),
        plugins: options.plugins.getRecords(),
        setup: recovery
          ? { secretBackend: "unavailable", wizardCompleted: false }
          : await options.getSetupState(),
        shellCapability: options.shellCapability,
        recovery,
      });
      } catch (error) {
        return failure(error);
      }
    }),
  );

  ipcMain.handle("borg:kernel:call", (event, payload): Promise<IpcResult> =>
    track(async () => {
      try {
      assertTrustedSender(event, options.getMainWindow, options.rendererUrl);
      const request = kernelCallSchema.parse(payload);

      switch (request.method) {
        case "command.provides":
          return success(options.bus.provides(request.args.id));
        case "window.hide":
          if (request.args.capability !== options.shellCapability) {
            throw new Error("Renderer shell capability is invalid");
          }
          options.getMainWindow()?.hide();
          return success(true);
        case "window.show":
          if (request.args.capability !== options.shellCapability) {
            throw new Error("Renderer shell capability is invalid");
          }
          options.getMainWindow()?.show();
          options.getMainWindow()?.focus();
          return success(true);
        case "window.quit":
          if (request.args.capability !== options.shellCapability) {
            throw new Error("Renderer shell capability is invalid");
          }
          setImmediate(options.requestQuit);
          return success(true);
        case "config.get": {
          const pluginId = resolveUiPlugin(
            options.plugins,
            request.args.capability,
          );
          return success(await options.config.get(pluginId));
        }
        case "config.update": {
          const pluginId = resolveUiPlugin(
            options.plugins,
            request.args.capability,
          );
          return success(
            await options.config.update(pluginId, request.args.patch),
          );
        }
        case "secrets.has": {
          const pluginId = resolveUiPlugin(
            options.plugins,
            request.args.capability,
            "secrets:read",
          );
          return success(await options.secrets.has(pluginId, request.args.key));
        }
        case "secrets.set": {
          const pluginId = resolveUiPlugin(
            options.plugins,
            request.args.capability,
            "secrets:write",
          );
          await options.secrets.set(
            pluginId,
            request.args.key,
            request.args.value,
          );
          return success(true);
        }
        case "secrets.delete": {
          const pluginId = resolveUiPlugin(
            options.plugins,
            request.args.capability,
            "secrets:write",
          );
          await options.secrets.delete(pluginId, request.args.key);
          return success(true);
        }
        case "notifications.show": {
          const pluginId = resolveUiPlugin(
            options.plugins,
            request.args.capability,
            "notifications:send",
          );
          await options.notifications.notify(
            pluginId,
            request.args.request,
          );
          return success(true);
        }
        case "setup.complete":
          if (request.args.capability !== options.shellCapability) {
            throw new Error("Renderer shell capability is invalid");
          }
          return success(await options.completeSetup());
      }
      } catch (error) {
        return failure(error);
      }
    }),
  );

  return async () => {
    ipcMain.removeHandler("borg:command:invoke");
    ipcMain.removeHandler("borg:kernel:bootstrap");
    ipcMain.removeHandler("borg:kernel:call");
    if (activeCalls > 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        new Promise<void>((resolve) => {
          drainWaiters.add(resolve);
        }),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            console.error("[kernel] IPC drain exceeded 5000ms");
            resolve();
          }, 5_000);
        }),
      ]);
      if (timer) {
        clearTimeout(timer);
      }
    }
  };
}
