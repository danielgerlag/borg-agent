import type {
  CommandDefinition,
  CommandInput,
  CommandOutput,
} from "@borg/contracts";
import type {
  Disposable,
  PluginUiContext,
  PluginUiHost,
} from "@borg/plugin-sdk";
import type { Component } from "solid-js";
import { bundledUiPlugins } from "./bundled-ui-plugins";
import { UiContributionRegistry } from "./ui-registry";

interface StagedUiRegistration {
  commit(): void;
  dispose(): Promise<void>;
}

interface UiTransaction {
  readonly host: PluginUiHost<Component>;
  commit(): Promise<void>;
  dispose(): Promise<void>;
}

export interface UiPluginMetadata {
  readonly id: string;
  readonly uiCapability: string;
  readonly permissions: readonly string[];
  readonly contributes: {
    readonly kinds?: readonly string[] | undefined;
  };
}

export function createUiTransaction(
  plugin: UiPluginMetadata,
  registry: UiContributionRegistry,
): UiTransaction {
  const registrations: StagedUiRegistration[] = [];
  const permissions = new Set(plugin.permissions);
  const kinds = new Set(plugin.contributes.kinds ?? []);

  const stage = (
    permission: string,
    kind: string,
    factory: () => Disposable,
  ): Disposable => {
    if (!permissions.has(permission) || !kinds.has(kind)) {
      throw new Error(
        `Plugin ${plugin.id} did not declare ${permission} and contribution kind ${kind}`,
      );
    }

    let committed: Disposable | undefined;
    let disposed = false;
    const registration: StagedUiRegistration = {
      commit: () => {
        if (!disposed) {
          committed = factory();
        }
      },
      dispose: async () => {
        if (disposed) {
          return;
        }
        disposed = true;
        await committed?.dispose();
      },
    };
    registrations.push(registration);
    return {
      dispose: registration.dispose,
    };
  };

  return {
    host: {
      registerWorkspaceView: (contribution) =>
        stage("ui.workspace", "workspaceView", () =>
          registry.registerWorkspaceView(contribution),
        ),
      registerSettingsPage: (contribution) =>
        stage("ui.settings", "settingsPage", () =>
          registry.registerSettingsPage(contribution),
        ),
      registerWizardStep: (contribution) =>
        stage("ui.wizard", "wizardStep", () =>
          registry.registerWizardStep(contribution),
        ),
      registerFlightDeckWidget: (contribution) =>
        stage("ui.flightDeck", "flightDeckWidget", () =>
          registry.registerFlightDeckWidget(contribution),
        ),
      registerInteractionRenderer: (contribution) =>
        stage("ui.interactions", "interactionRenderer", () =>
          registry.registerInteractionRenderer(contribution),
        ),
    },
    commit: async () => {
      try {
        for (const registration of registrations) {
          registration.commit();
        }
      } catch (error) {
        await Promise.allSettled(
          [...registrations].reverse().map(async (registration) => registration.dispose()),
        );
        throw error;
      }
    },
    dispose: async () => {
      await Promise.allSettled(
        [...registrations].reverse().map(async (registration) => registration.dispose()),
      );
    },
  };
}

export interface UiPluginActivationResult {
  readonly registry: UiContributionRegistry;
  readonly errors: readonly string[];
  dispose(): Promise<void>;
}

export async function activatePluginUi(
  activePlugins: readonly UiPluginMetadata[],
): Promise<UiPluginActivationResult> {
  const registry = new UiContributionRegistry();
  const disposables: Disposable[] = [];
  const errors: string[] = [];

  for (const plugin of activePlugins) {
    const load = bundledUiPlugins[plugin.id];
    if (!load) {
      continue;
    }

    const transaction = createUiTransaction(plugin, registry);
    let activationDisposable: Disposable | undefined;
    try {
      const definition = (await load()).default;
      if (definition.id !== plugin.id) {
        throw new Error(
          `UI definition ${definition.id} does not match active plugin ${plugin.id}`,
        );
      }

      const context: PluginUiContext<Component> = {
        pluginId: plugin.id,
        ui: transaction.host,
        config: {
          get: () => window.borg.config.get(plugin.uiCapability),
          update: (patch) =>
            window.borg.config.update(plugin.uiCapability, patch),
        },
        secrets: {
          has: (key) => {
            if (!plugin.permissions.includes("secrets:read")) {
              throw new Error(`Plugin ${plugin.id} cannot read secrets`);
            }
            return window.borg.secrets.has(plugin.uiCapability, key);
          },
          set: (key, value) => {
            if (!plugin.permissions.includes("secrets:write")) {
              throw new Error(`Plugin ${plugin.id} cannot write secrets`);
            }
            return window.borg.secrets
              .set(plugin.uiCapability, key, value)
              .then(() => undefined);
          },
          delete: (key) => {
            if (!plugin.permissions.includes("secrets:write")) {
              throw new Error(`Plugin ${plugin.id} cannot write secrets`);
            }
            return window.borg.secrets
              .delete(plugin.uiCapability, key)
              .then(() => undefined);
          },
        },
        loops: {
          start: (input) => {
            if (!plugin.permissions.includes("loops.start")) {
              throw new Error(`Plugin ${plugin.id} cannot start loops`);
            }
            return window.borg.loops.start(plugin.uiCapability, input);
          },
          get: (runId) => {
            if (!plugin.permissions.includes("loops.start")) {
              throw new Error(`Plugin ${plugin.id} cannot inspect loops`);
            }
            return window.borg.loops.get(plugin.uiCapability, runId);
          },
          list: () => {
            if (!plugin.permissions.includes("loops.start")) {
              throw new Error(`Plugin ${plugin.id} cannot list loops`);
            }
            return window.borg.loops.list(plugin.uiCapability);
          },
          subscribe: async (runId, handler) => {
            if (!plugin.permissions.includes("loops.start")) {
              throw new Error(`Plugin ${plugin.id} cannot subscribe to loops`);
            }
            const unsubscribe = await window.borg.loops.subscribe(
              plugin.uiCapability,
              runId,
              (event) => {
                void Promise.resolve(handler(event)).catch((error: unknown) =>
                  console.error(
                    `[renderer] loop subscriber from ${plugin.id} failed`,
                    error,
                  ),
                );
              },
            );
            return { dispose: unsubscribe };
          },
          pause: (runId) => {
            if (!plugin.permissions.includes("loops.start")) {
              throw new Error(`Plugin ${plugin.id} cannot pause loops`);
            }
            return window.borg.loops.pause(plugin.uiCapability, runId);
          },
          resume: (runId) => {
            if (!plugin.permissions.includes("loops.start")) {
              throw new Error(`Plugin ${plugin.id} cannot resume loops`);
            }
            return window.borg.loops.resume(plugin.uiCapability, runId);
          },
          cancel: (runId) => {
            if (!plugin.permissions.includes("loops.start")) {
              throw new Error(`Plugin ${plugin.id} cannot cancel loops`);
            }
            return window.borg.loops.cancel(plugin.uiCapability, runId);
          },
        },
        interactions: {
          list: () => {
            if (!plugin.permissions.includes("interactions.read")) {
              throw new Error(`Plugin ${plugin.id} cannot inspect interactions`);
            }
            return window.borg.interactions.list(plugin.uiCapability);
          },
        },
        notify: async (request) => {
          if (!plugin.permissions.includes("notifications:send")) {
            throw new Error(`Plugin ${plugin.id} cannot send notifications`);
          }
          await window.borg.notifications.show(plugin.uiCapability, request);
        },
        bus: {
          invoke: <TCommand extends CommandDefinition>(
            command: TCommand,
            input: CommandInput<TCommand>,
          ) =>
            window.borg.command.invoke(command.id, input) as Promise<
              CommandOutput<TCommand>
            >,
          provides: (command) => window.borg.command.provides(command.id),
        },
      };

      activationDisposable = (await definition.activate(context)) ?? undefined;
      await transaction.commit();
      disposables.push({
        dispose: async () => {
          try {
            await activationDisposable?.dispose();
          } finally {
            await transaction.dispose();
          }
        },
      });
    } catch (error) {
      try {
        await activationDisposable?.dispose();
      } catch (cleanupError) {
        console.error(`[renderer] plugin ${plugin.id} UI cleanup failed`, cleanupError);
      } finally {
        await transaction.dispose();
      }
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  return {
    registry,
    errors,
    dispose: async () => {
      for (const disposable of [...disposables].reverse()) {
        try {
          await disposable.dispose();
        } catch (error) {
          console.error("[renderer] plugin UI disposal failed", error);
        }
      }
    },
  };
}
