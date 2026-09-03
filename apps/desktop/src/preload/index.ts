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
