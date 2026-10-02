import "./bridge";
import type {
  CommandDefinition,
  CommandInput,
  CommandOutput,
} from "@borg-agent/contracts";
import type {
  PluginUiContext,
  PluginUiDefinition,
  WorkspaceViewContribution,
} from "@borg-agent/plugin-sdk";
import type { Component } from "solid-js";
import { render } from "solid-js/web";

export interface DomainUiMetadata {
  readonly id: string;
  readonly permissions: readonly string[];
  readonly contributes: {
    readonly kinds: readonly string[];
  };
}

function unavailable(method: string): never {
  throw new Error(`This harness does not mount ${method}`);
}

function mountView(
  root: HTMLElement,
  view: WorkspaceViewContribution<Component>,
): void {
  const View = view.component;
  render(() => <View />, root);
}

export async function mountDomainUi(
  metadata: DomainUiMetadata,
  plugin: PluginUiDefinition<Component>,
): Promise<void> {
  const root = document.getElementById("root");
  if (!root) {
    throw new Error("Domain UI root is missing");
  }
  try {
    if (plugin.id !== metadata.id) {
      throw new Error(`UI plugin ${plugin.id} does not match ${metadata.id}`);
    }
    const permissions = new Set(metadata.permissions);
    const kinds = new Set(metadata.contributes.kinds);
    const views: WorkspaceViewContribution<Component>[] = [];
    const context: PluginUiContext<Component> = {
      pluginId: metadata.id,
      bus: {
        invoke: async <TCommand extends CommandDefinition>(
          command: TCommand,
          input: CommandInput<TCommand>,
        ): Promise<CommandOutput<TCommand>> => {
          const value: unknown = await window.borg.command.invoke(
            command.id,
            input,
          );
          return command.output.parse(value) as CommandOutput<TCommand>;
        },
        provides: async () => unavailable("bus.provides"),
        on: async () => unavailable("bus.on"),
      },
      ui: {
        registerWorkspaceView: (contribution) => {
          if (!permissions.has("ui.workspace") || !kinds.has("workspaceView")) {
            throw new Error(
              `Plugin ${metadata.id} did not declare ui.workspace and contribution kind workspaceView`,
            );
          }
          if (
            !/^[a-z0-9]+(?:[.-][a-z0-9-]+)+$/.test(contribution.id) ||
            contribution.label.trim().length === 0 ||
            typeof contribution.component !== "function"
          ) {
            throw new Error(`Invalid workspace view ${contribution.id}`);
          }
          views.push(contribution);
          return { dispose: () => undefined };
        },
        registerSettingsPage: () => unavailable("settings"),
        registerWizardStep: () => unavailable("wizard"),
        registerFlightDeckWidget: () => unavailable("flight deck"),
        registerInteractionRenderer: () => unavailable("interactions"),
        registerEmbeddedContentRenderer: () => unavailable("embedded content"),
        getEmbeddedContentRenderer: () => unavailable("embedded content"),
      },
      config: {
        get: async () => unavailable("config"),
        update: async () => unavailable("config"),
      },
      secrets: {
        has: async () => unavailable("secrets"),
        set: async () => unavailable("secrets"),
        delete: async () => unavailable("secrets"),
      },
      loops: {
        start: async () => unavailable("loops"),
        get: async () => unavailable("loops"),
        list: async () => unavailable("loops"),
        subscribe: async () => unavailable("loops"),
        pause: async () => unavailable("loops"),
        resume: async () => unavailable("loops"),
        cancel: async () => unavailable("loops"),
      },
      interactions: {
        list: async () => unavailable("interactions"),
      },
      personas: {
        get: async () => unavailable("personas"),
        list: async () => unavailable("personas"),
        getDefault: async () => unavailable("personas"),
        setDefault: async () => unavailable("personas"),
        create: async () => unavailable("personas"),
        update: async () => unavailable("personas"),
      },
      skills: {
        get: async () => unavailable("skills"),
        list: async () => unavailable("skills"),
        create: async () => unavailable("skills"),
        update: async () => unavailable("skills"),
        archive: async () => unavailable("skills"),
      },
      models: {
        list: async () => unavailable("models"),
      },
      cost: {
        summary: async () => unavailable("cost"),
        subscribe: async () => unavailable("cost"),
      },
      files: {
        getPathForFile: () => unavailable("files"),
        startDrag: () => unavailable("files"),
        copyWorkspaceFiles: async () => unavailable("files"),
        readClipboardPaths: async () => unavailable("files"),
        openWorkspaceFile: async () => unavailable("files"),
        revealWorkspaceFile: async () => unavailable("files"),
      },
      notify: async () => unavailable("notifications"),
    };
    await plugin.activate(context);
    const view = views[0];
    if (!view) {
      throw new Error(`Plugin ${metadata.id} did not register a workspace view`);
    }
    mountView(root, view);
  } catch (error) {
    const message = error instanceof Error ? error.message : "UI failed";
    render(
      () => <pre data-testid="domain-ui-error">{message}</pre>,
      root,
    );
  }
}
