import type { BusEnvelope } from "@borg/contracts";
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

interface IpcSuccess<T> {
  readonly ok: true;
  readonly value: T;
}

interface IpcFailure {
  readonly ok: false;
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}

type IpcResult<T> = IpcSuccess<T> | IpcFailure;

class BorgBridgeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "BorgBridgeError";
    this.code = code;
  }
}

async function invokeKernel<T>(channel: string, payload?: unknown): Promise<T> {
  const result = (await ipcRenderer.invoke(channel, payload)) as IpcResult<T>;
  if (!result.ok) {
    throw new BorgBridgeError(result.error.code, result.error.message);
  }
  return result.value;
}

let activeShellCapability: string | undefined;

function assertShellCapability(capability: string): void {
  if (
    typeof capability !== "string" ||
    typeof activeShellCapability !== "string" ||
    capability !== activeShellCapability
  ) {
    throw new BorgBridgeError("forbidden", "Renderer shell capability is invalid");
  }
}

const bridge = Object.freeze({
  command: Object.freeze({
    invoke: (id: string, input: unknown): Promise<unknown> =>
      invokeKernel("borg:command:invoke", { id, input }),
    provides: (id: string): Promise<boolean> =>
      invokeKernel("borg:kernel:call", {
        method: "command.provides",
        args: { id },
      }),
  }),
  events: Object.freeze({
    subscribe: async (
      capability: string,
      eventId: string,
      listener: (payload: unknown, envelope: BusEnvelope) => void,
    ): Promise<(() => void)> => {
      let subscriptionId: string | undefined;
      const pending: {
        readonly subscriptionId?: unknown;
        readonly payload?: unknown;
        readonly envelope: BusEnvelope;
      }[] = [];
      const wrapped = (
        _event: IpcRendererEvent,
        delivery: {
          readonly subscriptionId?: unknown;
          readonly payload?: unknown;
          readonly envelope: BusEnvelope;
        },
      ): void => {
        if (subscriptionId === undefined) {
          pending.push(delivery);
        } else if (delivery?.subscriptionId === subscriptionId) {
          listener(delivery.payload, delivery.envelope);
        }
      };
      ipcRenderer.on("borg:event:deliver", wrapped);
      try {
        subscriptionId = await invokeKernel<string>("borg:kernel:call", {
          method: "events.subscribe",
          args: { capability, eventId },
        });
        for (const delivery of pending) {
          if (
            delivery &&
            typeof delivery === "object" &&
            (
              delivery as {
                readonly subscriptionId?: unknown;
              }
            ).subscriptionId === subscriptionId
          ) {
            listener(
              (delivery as { readonly payload?: unknown }).payload,
              delivery.envelope,
            );
          }
        }
      } catch (error) {
        ipcRenderer.removeListener("borg:event:deliver", wrapped);
        throw error;
      }
      return () => {
        ipcRenderer.removeListener("borg:event:deliver", wrapped);
        if (subscriptionId) {
          void invokeKernel("borg:kernel:call", {
            method: "events.unsubscribe",
            args: { capability, subscriptionId },
          }).catch(() => undefined);
        }
      };
    },
  }),
  kernel: Object.freeze({
    bootstrap: async (): Promise<unknown> => {
      const snapshot = await invokeKernel<{
        readonly shellCapability?: unknown;
      }>("borg:kernel:bootstrap");
      if (typeof snapshot.shellCapability === "string") {
        activeShellCapability = snapshot.shellCapability;
      }
      return snapshot;
    },
  }),
  config: Object.freeze({
    get: (capability: string): Promise<unknown> =>
      invokeKernel("borg:kernel:call", {
        method: "config.get",
        args: { capability },
      }),
    update: (
      capability: string,
      patch: Readonly<Record<string, unknown>>,
    ): Promise<unknown> =>
      invokeKernel("borg:kernel:call", {
        method: "config.update",
        args: { capability, patch },
      }),
  }),
  secrets: Object.freeze({
    has: (capability: string, key: string): Promise<boolean> =>
      invokeKernel("borg:kernel:call", {
        method: "secrets.has",
        args: { capability, key },
      }),
    set: (capability: string, key: string, value: string): Promise<boolean> =>
      invokeKernel("borg:kernel:call", {
        method: "secrets.set",
        args: { capability, key, value },
      }),
    delete: (capability: string, key: string): Promise<boolean> =>
      invokeKernel("borg:kernel:call", {
        method: "secrets.delete",
        args: { capability, key },
      }),
  }),
  notifications: Object.freeze({
    show: (capability: string, request: unknown): Promise<boolean> =>
      invokeKernel("borg:kernel:call", {
        method: "notifications.show",
        args: { capability, request },
      }),
    subscribe: (
      capability: string,
      listener: (notification: unknown) => void,
    ): (() => void) => {
      assertShellCapability(capability);
      const wrapped = (_event: IpcRendererEvent, notification: unknown): void => {
        listener(notification);
      };
      ipcRenderer.on("borg:notification", wrapped);
      return () => {
        ipcRenderer.removeListener("borg:notification", wrapped);
      };
    },
  }),
  setup: Object.freeze({
    complete: (capability: string): Promise<unknown> => {
      assertShellCapability(capability);
      return invokeKernel("borg:kernel:call", {
        method: "setup.complete",
        args: { capability },
      });
    },
  }),
  loops: Object.freeze({
    start: (capability: string, input: unknown): Promise<unknown> =>
      invokeKernel("borg:kernel:call", {
        method: "loops.start",
        args: { capability, input },
      }),
    get: (capability: string, runId: string): Promise<unknown> =>
      invokeKernel("borg:kernel:call", {
        method: "loops.get",
        args: { capability, runId },
      }),
    list: (capability: string): Promise<unknown> =>
      invokeKernel("borg:kernel:call", {
        method: "loops.list",
        args: { capability },
      }),
    subscribe: async (
      capability: string,
      runId: string,
      listener: (event: unknown) => void,
    ): Promise<(() => void)> => {
      let subscriptionId: string | undefined;
      const pending: unknown[] = [];
      const wrapped = (
        _event: IpcRendererEvent,
        payload: { readonly subscriptionId?: unknown; readonly event?: unknown },
      ): void => {
        if (subscriptionId === undefined) {
          pending.push(payload);
        } else if (payload?.subscriptionId === subscriptionId) {
          listener(payload.event);
        }
      };
      ipcRenderer.on("borg:loops:event", wrapped);
      try {
        subscriptionId = await invokeKernel<string>("borg:kernel:call", {
          method: "loops.subscribe",
          args: { capability, runId },
        });
        for (const payload of pending) {
          if (
            payload &&
            typeof payload === "object" &&
            (payload as { readonly subscriptionId?: unknown }).subscriptionId ===
              subscriptionId
          ) {
            listener((payload as { readonly event?: unknown }).event);
          }
        }
      } catch (error) {
        ipcRenderer.removeListener("borg:loops:event", wrapped);
        throw error;
      }
      return () => {
        ipcRenderer.removeListener("borg:loops:event", wrapped);
        if (subscriptionId) {
          void invokeKernel("borg:kernel:call", {
            method: "loops.unsubscribe",
            args: { capability, subscriptionId },
          }).catch(() => undefined);
        }
      };
    },
    pause: (capability: string, runId: string): Promise<boolean> =>
      invokeKernel("borg:kernel:call", {
        method: "loops.pause",
        args: { capability, runId },
      }),
    resume: (capability: string, runId: string): Promise<boolean> =>
      invokeKernel("borg:kernel:call", {
        method: "loops.resume",
        args: { capability, runId },
      }),
    cancel: (capability: string, runId: string): Promise<boolean> =>
      invokeKernel("borg:kernel:call", {
        method: "loops.cancel",
        args: { capability, runId },
      }),
  }),
  interactions: Object.freeze({
    list: (capability: string): Promise<unknown> =>
      invokeKernel("borg:kernel:call", {
        method: "interactions.list",
        args: { capability },
      }),
    respond: (
      shellCapability: string,
      interactionId: string,
      response: unknown,
    ): Promise<boolean> => {
      assertShellCapability(shellCapability);
      return invokeKernel("borg:kernel:call", {
        method: "interactions.respond",
        args: { capability: shellCapability, interactionId, response },
      });
    },
    subscribe: (
      shellCapability: string,
      listener: (pending: unknown) => void,
    ): (() => void) => {
      assertShellCapability(shellCapability);
      const wrapped = (_event: IpcRendererEvent, pending: unknown): void => {
        listener(pending);
      };
      ipcRenderer.on("borg:interactions", wrapped);
      return () => {
        ipcRenderer.removeListener("borg:interactions", wrapped);
      };
    },
  }),
  personas: Object.freeze({
    list: (capability: string, includeArchived = false): Promise<unknown> =>
      invokeKernel("borg:kernel:call", {
        method: "personas.list",
        args: { capability, includeArchived },
      }),
    get: (capability: string, personaId: string): Promise<unknown> =>
      invokeKernel("borg:kernel:call", {
        method: "personas.get",
        args: { capability, personaId },
      }),
    getDefault: (capability: string): Promise<unknown> =>
      invokeKernel("borg:kernel:call", {
        method: "personas.getDefault",
        args: { capability },
      }),
    setDefault: (
      capability: string,
      personaId: string,
    ): Promise<unknown> =>
      invokeKernel("borg:kernel:call", {
        method: "personas.setDefault",
        args: { capability, personaId },
      }),
    create: (capability: string, candidate: unknown): Promise<unknown> =>
      invokeKernel("borg:kernel:call", {
        method: "personas.create",
        args: { capability, candidate },
      }),
    update: (
      capability: string,
      personaId: string,
      patch: Readonly<Record<string, unknown>>,
    ): Promise<unknown> =>
      invokeKernel("borg:kernel:call", {
        method: "personas.update",
        args: { capability, personaId, patch },
      }),
  }),
  models: Object.freeze({
    list: (capability: string): Promise<unknown> =>
      invokeKernel("borg:kernel:call", {
        method: "models.list",
        args: { capability },
      }),
  }),
  window: Object.freeze({
    hide: (capability: string): Promise<boolean> => {
      assertShellCapability(capability);
      return invokeKernel("borg:kernel:call", {
        method: "window.hide",
        args: { capability },
      });
    },
    show: (capability: string): Promise<boolean> => {
      assertShellCapability(capability);
      return invokeKernel("borg:kernel:call", {
        method: "window.show",
        args: { capability },
      });
    },
    quit: (capability: string): Promise<boolean> => {
      assertShellCapability(capability);
      return invokeKernel("borg:kernel:call", {
        method: "window.quit",
        args: { capability },
      });
    },
  }),
});

contextBridge.exposeInMainWorld("borg", bridge);
