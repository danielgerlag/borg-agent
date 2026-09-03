import type {
  InteractionResponse,
  LoopEvent,
  LoopRunSnapshot,
  LoopStartInput,
  PendingInteraction,
} from "@borg/contracts";

export {};

declare global {
  interface KernelPluginSnapshot {
    readonly id: string;
    readonly version: string;
    readonly status: string;
    readonly error?: string;
  }

  interface KernelBootstrapSnapshot {
    readonly kernelVersion: string;
    readonly startedAt: string;
    readonly activePluginIds: readonly string[];
    readonly activePlugins: readonly ActivePluginSnapshot[];
    readonly plugins: readonly KernelPluginSnapshot[];
    readonly setup: SetupSnapshot;
    readonly shellCapability: string;
    readonly recovery?: { readonly message: string } | undefined;
    readonly pendingInteractions: readonly PendingInteraction[];
  }

  interface SetupSnapshot {
    readonly wizardCompleted: boolean;
    readonly secretBackend: string;
  }

  interface RendererNotification {
    readonly id: string;
    readonly sourcePluginId: string;
    readonly title: string;
    readonly body: string;
    readonly level: "info" | "success" | "warning" | "error";
    readonly createdAt: string;
  }

  interface ActivePluginSnapshot {
    readonly id: string;
    readonly version: string;
    readonly uiCapability: string;
    readonly permissions: readonly string[];
    readonly contributes: {
      readonly commands?: readonly string[];
      readonly events?: readonly string[];
      readonly extensionPoints?: readonly string[];
      readonly kinds?: readonly string[];
    };
  }

  interface BorgRendererBridge {
    readonly command: {
      invoke(id: string, input: unknown): Promise<unknown>;
      provides(id: string): Promise<boolean>;
    };
    readonly kernel: {
      bootstrap(): Promise<KernelBootstrapSnapshot>;
    };
    readonly config: {
      get(capability: string): Promise<Readonly<Record<string, unknown>>>;
      update(
        capability: string,
        patch: Readonly<Record<string, unknown>>,
      ): Promise<Readonly<Record<string, unknown>>>;
    };
    readonly secrets: {
      has(capability: string, key: string): Promise<boolean>;
      set(capability: string, key: string, value: string): Promise<boolean>;
      delete(capability: string, key: string): Promise<boolean>;
    };
    readonly notifications: {
      show(capability: string, request: unknown): Promise<boolean>;
      subscribe(
        shellCapability: string,
        listener: (notification: RendererNotification) => void,
      ): () => void;
    };
    readonly setup: {
      complete(capability: string): Promise<SetupSnapshot>;
    };
    readonly loops: {
      start(
        capability: string,
        input: LoopStartInput,
      ): Promise<LoopRunSnapshot>;
      get(
        capability: string,
        runId: string,
      ): Promise<LoopRunSnapshot | undefined>;
      list(capability: string): Promise<readonly LoopRunSnapshot[]>;
      subscribe(
        capability: string,
        runId: string,
        listener: (event: LoopEvent) => void,
      ): Promise<() => void>;
      pause(capability: string, runId: string): Promise<boolean>;
      resume(capability: string, runId: string): Promise<boolean>;
      cancel(capability: string, runId: string): Promise<boolean>;
    };
    readonly interactions: {
      list(capability: string): Promise<readonly PendingInteraction[]>;
      respond(
        shellCapability: string,
        interactionId: string,
        response: InteractionResponse,
      ): Promise<boolean>;
      subscribe(
        shellCapability: string,
        listener: (pending: readonly PendingInteraction[]) => void,
      ): () => void;
    };
    readonly window: {
      hide(shellCapability: string): Promise<boolean>;
      show(shellCapability: string): Promise<boolean>;
      quit(shellCapability: string): Promise<boolean>;
    };
  }

  interface Window {
    readonly borg: BorgRendererBridge;
  }
}
