import {
  CommandInvocationError,
  type CommandEventBus,
  type ConfigFacade,
  type CostLedger,
  type InteractionService,
  type LoopManager,
  type ModelGateway,
  type NotificationService,
  type PersonaService,
  type PluginManager,
  type SecretFacade,
} from "@borg/kernel";
import {
  BrowserWindow,
  ipcMain,
  type Event as ElectronEvent,
  type IpcMainInvokeEvent,
  type WebContents,
} from "electron";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  interactionResponseSchema,
  loopStartInputSchema,
  personaIdSchema,
} from "@borg/contracts";

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
  z.object({
    method: z.literal("loops.start"),
    args: z.object({
      capability: z.string().uuid(),
      input: loopStartInputSchema,
    }),
  }),
  z.object({
    method: z.literal("loops.get"),
    args: z.object({
      capability: z.string().uuid(),
      runId: z.string().uuid(),
    }),
  }),
  z.object({
    method: z.literal("loops.list"),
    args: z.object({
      capability: z.string().uuid(),
    }),
  }),
  z.object({
    method: z.literal("loops.subscribe"),
    args: z.object({
      capability: z.string().uuid(),
      runId: z.string().uuid(),
    }),
  }),
  z.object({
    method: z.literal("loops.unsubscribe"),
    args: z.object({
      capability: z.string().uuid(),
      subscriptionId: z.string().uuid(),
    }),
  }),
  z.object({
    method: z.literal("loops.cancel"),
    args: z.object({
      capability: z.string().uuid(),
      runId: z.string().uuid(),
    }),
  }),
  z.object({
    method: z.enum(["loops.pause", "loops.resume"]),
    args: z.object({
      capability: z.string().uuid(),
      runId: z.string().uuid(),
    }),
  }),
  z.object({
    method: z.literal("interactions.list"),
    args: z.object({ capability: z.string().uuid() }),
  }),
  z.object({
    method: z.literal("interactions.respond"),
    args: z.object({
      capability: z.string().uuid(),
      interactionId: z.string().uuid(),
      response: interactionResponseSchema,
    }),
  }),
  z.object({
    method: z.literal("personas.list"),
    args: z.object({
      capability: z.string().uuid(),
      includeArchived: z.boolean().optional(),
    }),
  }),
  z.object({
    method: z.enum(["personas.get", "personas.setDefault"]),
    args: z.object({
      capability: z.string().uuid(),
      personaId: personaIdSchema,
    }),
  }),
  z.object({
    method: z.literal("personas.getDefault"),
    args: z.object({ capability: z.string().uuid() }),
  }),
  z.object({
    method: z.literal("personas.create"),
    args: z.object({
      capability: z.string().uuid(),
      candidate: z.unknown(),
    }),
  }),
  z.object({
    method: z.literal("personas.update"),
    args: z.object({
      capability: z.string().uuid(),
      personaId: personaIdSchema,
      patch: z.record(z.string(), z.unknown()),
    }),
  }),
  z.object({
    method: z.literal("events.subscribe"),
    args: z.object({
      capability: z.string().uuid(),
      eventId: z.string().min(1),
    }),
  }),
  z.object({
    method: z.literal("events.unsubscribe"),
    args: z.object({
      capability: z.string().uuid(),
      subscriptionId: z.string().uuid(),
    }),
  }),
  z.object({
    method: z.literal("models.list"),
    args: z.object({ capability: z.string().uuid() }),
  }),
  z.object({
    method: z.literal("cost.summary"),
    args: z.object({ capability: z.string().uuid() }),
  }),
  z.object({
    method: z.literal("cost.subscribe"),
    args: z.object({ capability: z.string().uuid() }),
  }),
  z.object({
    method: z.literal("cost.unsubscribe"),
    args: z.object({
      capability: z.string().uuid(),
      subscriptionId: z.string().uuid(),
    }),
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
  readonly interactions: InteractionService;
  readonly loops: LoopManager;
  readonly personas: PersonaService;
  readonly models: ModelGateway;
  readonly costs: CostLedger;
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
  const rendererCommandControllers = new Set<AbortController>();
  const loopSubscriptions = new Map<
    string,
    {
      readonly senderId: number;
      readonly pluginId: string;
      readonly dispose: () => void;
    }
  >();
  const eventSubscriptions = new Map<
    string,
    {
      readonly senderId: number;
      readonly pluginId: string;
      readonly dispose: () => void;
    }
  >();
  const costSubscriptions = new Map<
    string,
    {
      readonly senderId: number;
      readonly pluginId: string;
      readonly dispose: () => void;
    }
  >();
  const observedSenderIds = new Set<number>();
  const disposeLoopSubscriptions = (senderId?: number): void => {
    for (const [subscriptionId, subscription] of loopSubscriptions) {
      if (senderId === undefined || subscription.senderId === senderId) {
        subscription.dispose();
        loopSubscriptions.delete(subscriptionId);
      }
    }
  };
  const disposeEventSubscriptions = (senderId?: number): void => {
    for (const [subscriptionId, subscription] of eventSubscriptions) {
      if (senderId === undefined || subscription.senderId === senderId) {
        subscription.dispose();
        eventSubscriptions.delete(subscriptionId);
      }
    }
  };
  const disposeCostSubscriptions = (senderId?: number): void => {
    for (const [subscriptionId, subscription] of costSubscriptions) {
      if (senderId === undefined || subscription.senderId === senderId) {
        subscription.dispose();
        costSubscriptions.delete(subscriptionId);
      }
    }
  };
  const observeSender = (sender: WebContents): void => {
    if (observedSenderIds.has(sender.id)) {
      return;
    }
    observedSenderIds.add(sender.id);
    sender.once("destroyed", () => {
      observedSenderIds.delete(sender.id);
      disposeLoopSubscriptions(sender.id);
      disposeEventSubscriptions(sender.id);
      disposeCostSubscriptions(sender.id);
      if (bootstrapConsumedBy === sender.id) {
        bootstrapConsumedBy = undefined;
      }
      cancelRendererCommands("Renderer was destroyed");
    });
  };
  const cancelRendererCommands = (reason: string): void => {
    for (const controller of rendererCommandControllers) {
      controller.abort(new Error(reason));
    }
  };
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
        const controller = new AbortController();
        const onDestroyed = (): void => {
          controller.abort(new Error("Renderer was destroyed"));
        };
        try {
          assertTrustedSender(event, options.getMainWindow, options.rendererUrl);
          observeSender(event.sender);
          const request = commandInvokeSchema.parse(payload);
          rendererCommandControllers.add(controller);
          event.sender.once("destroyed", onDestroyed);
          return success(
            await options.bus.invokeById(request.id, request.input, {
              signal: controller.signal,
              source: {
                kind: "renderer",
                id: String(event.sender.id),
              },
            }),
          );
        } catch (error) {
          return failure(error);
        } finally {
          rendererCommandControllers.delete(controller);
          event.sender.removeListener("destroyed", onDestroyed);
        }
      }),
  );

  ipcMain.handle("borg:kernel:bootstrap", (event): Promise<IpcResult> =>
    track(async () => {
      try {
      assertTrustedSender(event, options.getMainWindow, options.rendererUrl);
      observeSender(event.sender);
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
          cancelRendererCommands("Renderer navigated");
          disposeLoopSubscriptions(sender.id);
          disposeEventSubscriptions(sender.id);
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
        pendingInteractions: options.interactions.listPending(),
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
      observeSender(event.sender);
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
        case "loops.start": {
          const pluginId = resolveUiPlugin(
            options.plugins,
            request.args.capability,
            "loops.start",
          );
          return success(await options.loops.start(request.args.input, pluginId));
        }
        case "loops.get": {
          const pluginId = resolveUiPlugin(
            options.plugins,
            request.args.capability,
            "loops.start",
          );
          return success(options.loops.get(request.args.runId, pluginId));
        }
        case "loops.list": {
          const pluginId = resolveUiPlugin(
            options.plugins,
            request.args.capability,
            "loops.start",
          );
          return success(options.loops.list(pluginId));
        }
        case "loops.subscribe": {
          const pluginId = resolveUiPlugin(
            options.plugins,
            request.args.capability,
            "loops.start",
          );
          const subscriptionId = randomUUID();
          const sender = event.sender;
          const subscription = options.loops.subscribeRun(
            request.args.runId,
            pluginId,
            (loopEvent) => {
              if (!sender.isDestroyed()) {
                sender.send("borg:loops:event", {
                  subscriptionId,
                  event: loopEvent,
                });
              }
            },
          );
          loopSubscriptions.set(subscriptionId, {
            senderId: sender.id,
            pluginId,
            dispose: () => subscription.dispose(),
          });
          return success(subscriptionId);
        }
        case "loops.unsubscribe": {
          const pluginId = resolveUiPlugin(
            options.plugins,
            request.args.capability,
            "loops.start",
          );
          const subscription = loopSubscriptions.get(
            request.args.subscriptionId,
          );
          if (
            !subscription ||
            subscription.senderId !== event.sender.id ||
            subscription.pluginId !== pluginId
          ) {
            return success(false);
          }
          subscription.dispose();
          loopSubscriptions.delete(request.args.subscriptionId);
          return success(true);
        }
        case "loops.cancel": {
          const pluginId = resolveUiPlugin(
            options.plugins,
            request.args.capability,
            "loops.start",
          );
          return success(options.loops.cancel(request.args.runId, pluginId));
        }
        case "loops.pause":
        case "loops.resume": {
          const pluginId = resolveUiPlugin(
            options.plugins,
            request.args.capability,
            "loops.start",
          );
          return success(
            request.method === "loops.pause"
              ? options.loops.pause(request.args.runId, pluginId)
              : options.loops.resume(request.args.runId, pluginId),
          );
        }
        case "interactions.list":
          if (request.args.capability !== options.shellCapability) {
            const pluginId = resolveUiPlugin(
              options.plugins,
              request.args.capability,
              "interactions.read",
            );
            return success(
              options.interactions
                .listPending()
                .filter(({ source }) => source.pluginId === pluginId),
            );
          }
          return success(options.interactions.listPending());
        case "interactions.respond":
          if (request.args.capability !== options.shellCapability) {
            throw new Error("Renderer shell capability is invalid");
          }
          return success(
            options.interactions.respond(
              request.args.interactionId,
              request.args.response,
            ),
          );
        case "personas.list": {
          resolveUiPlugin(
            options.plugins,
            request.args.capability,
            "personas.read",
          );
          return success(
            options.personas.list(request.args.includeArchived === true),
          );
        }
        case "personas.get": {
          resolveUiPlugin(
            options.plugins,
            request.args.capability,
            "personas.read",
          );
          return success(options.personas.get(request.args.personaId));
        }
        case "personas.getDefault": {
          resolveUiPlugin(
            options.plugins,
            request.args.capability,
            "personas.read",
          );
          return success(options.personas.getDefault());
        }
        case "personas.setDefault": {
          resolveUiPlugin(
            options.plugins,
            request.args.capability,
            "personas.write",
          );
          return success(
            await options.personas.setDefault(request.args.personaId),
          );
        }
        case "personas.create": {
          resolveUiPlugin(
            options.plugins,
            request.args.capability,
            "personas.write",
          );
          return success(await options.personas.create(request.args.candidate));
        }
        case "personas.update": {
          resolveUiPlugin(
            options.plugins,
            request.args.capability,
            "personas.write",
          );
          return success(
            await options.personas.update(
              request.args.personaId,
              request.args.patch,
            ),
          );
        }
        case "events.subscribe": {
          if (!options.plugins.hasDeclaredEvent(request.args.eventId)) {
            throw new Error(
              `Event ${request.args.eventId} is not declared by an active plugin`,
            );
          }
          const pluginId = resolveUiPlugin(
            options.plugins,
            request.args.capability,
          );
          const sender = event.sender;
          const subscriptionId = randomUUID();
          const subscription = options.bus.onById(
            pluginId,
            request.args.eventId,
            (payload, envelope) => {
              if (!sender.isDestroyed()) {
                sender.send("borg:event:deliver", {
                  subscriptionId,
                  payload,
                  envelope,
                });
              }
            },
          );
          eventSubscriptions.set(subscriptionId, {
            senderId: sender.id,
            pluginId,
            dispose: () => subscription.dispose(),
          });
          return success(subscriptionId);
        }
        case "events.unsubscribe": {
          const pluginId = resolveUiPlugin(
            options.plugins,
            request.args.capability,
          );
          const subscription = eventSubscriptions.get(
            request.args.subscriptionId,
          );
          if (
            !subscription ||
            subscription.senderId !== event.sender.id ||
            subscription.pluginId !== pluginId
          ) {
            return success(false);
          }
          subscription.dispose();
          eventSubscriptions.delete(request.args.subscriptionId);
          return success(true);
        }
        case "models.list": {
          resolveUiPlugin(
            options.plugins,
            request.args.capability,
            "models.read",
          );
          return success(options.models.listModels());
        }
        case "cost.summary": {
          resolveUiPlugin(
            options.plugins,
            request.args.capability,
            "cost.read",
          );
          return success(options.costs.summary());
        }
        case "cost.subscribe": {
          const pluginId = resolveUiPlugin(
            options.plugins,
            request.args.capability,
            "cost.read",
          );
          const subscriptionId = randomUUID();
          const sender = event.sender;
          const subscription = options.costs.subscribe((summary) => {
            if (!sender.isDestroyed()) {
              sender.send("borg:cost:summary", {
                subscriptionId,
                summary,
              });
            }
          });
          costSubscriptions.set(subscriptionId, {
            senderId: sender.id,
            pluginId,
            dispose: () => subscription.dispose(),
          });
          return success(subscriptionId);
        }
        case "cost.unsubscribe": {
          const pluginId = resolveUiPlugin(
            options.plugins,
            request.args.capability,
            "cost.read",
          );
          const subscription = costSubscriptions.get(
            request.args.subscriptionId,
          );
          if (
            !subscription ||
            subscription.senderId !== event.sender.id ||
            subscription.pluginId !== pluginId
          ) {
            return success(false);
          }
          subscription.dispose();
          costSubscriptions.delete(request.args.subscriptionId);
          return success(true);
        }
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
    cancelRendererCommands("IPC bridge is shutting down");
    disposeLoopSubscriptions();
    disposeEventSubscriptions();
    disposeCostSubscriptions();
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
