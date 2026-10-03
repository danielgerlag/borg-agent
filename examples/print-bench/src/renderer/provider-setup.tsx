import type { CommandDefinition, CommandInput, CommandOutput } from "@borg-agent/contracts";
import type {
  Disposable,
  PluginUiContext,
  PluginUiHost,
  SettingsPageContribution,
} from "@borg-agent/plugin-sdk";
import { z } from "@borg-agent/plugin-sdk";
import { createSignal, For, onCleanup, onMount, Show, type Component } from "solid-js";
import { Dynamic } from "solid-js/web";
import { benchApi } from "./bridge.js";

const providerPluginSchema = z
  .object({
    id: z.string().min(1),
    permissions: z.array(z.string()),
    kinds: z.array(z.string()),
  })
  .strict();

type ProviderPlugin = z.output<typeof providerPluginSchema>;

const providerUi: Readonly<
  Record<string, () => Promise<{ readonly default: { readonly id: string; activate(context: PluginUiContext<Component>): void | Disposable | Promise<void | Disposable> } }>>
> = {
  "borg.anthropic": () => import("@borg/plugin-anthropic/ui"),
  "borg.azure": () => import("@borg/plugin-azure/ui"),
  "borg.copilot": () => import("@borg/plugin-copilot/ui"),
  "borg.ollama": () => import("@borg/plugin-ollama/ui"),
  "borg.openai": () => import("@borg/plugin-openai/ui"),
  "borg.openrouter": () => import("@borg/plugin-openrouter/ui"),
};

function unavailable(method: string): never {
  throw new Error(`Print bench does not host ${method}.`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function providerContext(plugin: ProviderPlugin, pages: SettingsPageContribution<Component>[]): PluginUiContext<Component> {
  const call = (body: unknown): Promise<unknown> => benchApi().provider.call(body);
  const permissions = new Set(plugin.permissions);
  const kinds = new Set(plugin.kinds);
  const allow = (permission: string, kind: string): void => {
    if (!permissions.has(permission) || !kinds.has(kind)) {
      throw new Error(
        `Plugin ${plugin.id} did not declare ${permission} and contribution kind ${kind}`,
      );
    }
  };
  const host: PluginUiHost<Component> = {
    registerSettingsPage: (contribution) => {
      allow("ui.settings", "settingsPage");
      pages.push(contribution);
      return {
        dispose: () => {
          const index = pages.indexOf(contribution);
          if (index >= 0) {
            pages.splice(index, 1);
          }
        },
      };
    },
    registerWizardStep: () => {
      allow("ui.wizard", "wizardStep");
      return { dispose() {} };
    },
    registerWorkspaceView: () => unavailable("workspace views"),
    registerFlightDeckWidget: () => unavailable("flight deck widgets"),
    registerInteractionRenderer: () => unavailable("interaction renderers"),
    registerEmbeddedContentRenderer: () => unavailable("embedded content"),
    getEmbeddedContentRenderer: () => unavailable("embedded content"),
  };
  return {
    pluginId: plugin.id,
    ui: host,
    config: {
      get: async () => {
        const value = await call({ method: "config.get", pluginId: plugin.id });
        if (!isRecord(value)) {
          throw new Error(`Config for ${plugin.id} is not an object`);
        }
        return value;
      },
      update: async (patch) => {
        const value = await call({ method: "config.update", pluginId: plugin.id, patch });
        if (!isRecord(value)) {
          throw new Error(`Config for ${plugin.id} is not an object`);
        }
        return value;
      },
    },
    secrets: {
      has: async (key) => {
        if (!permissions.has("secrets:read")) {
          throw new Error(`Plugin ${plugin.id} cannot read secrets`);
        }
        return z.boolean().parse(await call({ method: "secrets.has", pluginId: plugin.id, key }));
      },
      set: async (key, value) => {
        if (!permissions.has("secrets:write")) {
          throw new Error(`Plugin ${plugin.id} cannot write secrets`);
        }
        await call({ method: "secrets.set", pluginId: plugin.id, key, value });
      },
      delete: async (key) => {
        if (!permissions.has("secrets:write")) {
          throw new Error(`Plugin ${plugin.id} cannot write secrets`);
        }
        await call({ method: "secrets.delete", pluginId: plugin.id, key });
      },
    },
    bus: {
      invoke: async <TCommand extends CommandDefinition>(
        command: TCommand,
        input: CommandInput<TCommand>,
      ): Promise<CommandOutput<TCommand>> =>
        command.output.parse(
          await call({
            method: "bus.invoke",
            pluginId: plugin.id,
            commandId: command.id,
            input,
          }),
        ) as CommandOutput<TCommand>,
      provides: () => unavailable("command lookup"),
      on: () => unavailable("events"),
    },
    loops: {
      start: () => unavailable("loops"),
      get: () => unavailable("loops"),
      list: () => unavailable("loops"),
      subscribe: () => unavailable("loops"),
      pause: () => unavailable("loops"),
      resume: () => unavailable("loops"),
      cancel: () => unavailable("loops"),
    },
    interactions: { list: () => unavailable("interactions") },
    personas: {
      get: () => unavailable("personas"),
      list: () => unavailable("personas"),
      getDefault: () => unavailable("personas"),
      setDefault: () => unavailable("personas"),
      create: () => unavailable("personas"),
      update: () => unavailable("personas"),
    },
    skills: {
      get: () => unavailable("skills"),
      list: () => unavailable("skills"),
      create: () => unavailable("skills"),
      update: () => unavailable("skills"),
      archive: () => unavailable("skills"),
    },
    models: { list: () => unavailable("model catalog") },
    cost: {
      summary: () => unavailable("cost"),
      subscribe: () => unavailable("cost"),
    },
    files: {
      getPathForFile: () => unavailable("files"),
      startDrag: () => unavailable("files"),
      copyWorkspaceFiles: () => unavailable("files"),
      readClipboardPaths: () => unavailable("files"),
      openWorkspaceFile: () => unavailable("files"),
      revealWorkspaceFile: () => unavailable("files"),
    },
    notify: () => unavailable("notifications"),
  };
}

async function loadProviderSetup(): Promise<{
  readonly pages: readonly SettingsPageContribution<Component>[];
  dispose(): Promise<void>;
}> {
  const listed = z.array(providerPluginSchema).parse(await benchApi().provider.call({ method: "plugins" }));
  const pages: SettingsPageContribution<Component>[] = [];
  const disposables: Disposable[] = [];
  const failures: string[] = [];
  for (const plugin of listed) {
    const load = providerUi[plugin.id];
    if (!load) {
      continue;
    }
    try {
      const definition = (await load()).default;
      if (definition.id !== plugin.id) {
        throw new Error(`UI definition ${definition.id} does not match ${plugin.id}`);
      }
      const result = await definition.activate(providerContext(plugin, pages));
      if (result) {
        disposables.push(result);
      }
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (failures.length > 0) {
    throw new Error(failures.join("\n"));
  }
  pages.sort(
    (left, right) =>
      (left.order ?? 0) - (right.order ?? 0) || left.label.localeCompare(right.label),
  );
  return {
    pages,
    async dispose() {
      for (const disposable of [...disposables].reverse()) {
        await disposable.dispose();
      }
    },
  };
}

export function ProviderScreens() {
  const [pages, setPages] = createSignal<readonly SettingsPageContribution<Component>[]>([]);
  const [error, setError] = createSignal<string | undefined>();

  onMount(() => {
    let disposed = false;
    let dispose = async (): Promise<void> => {};
    void loadProviderSetup()
      .then((session) => {
        if (disposed) {
          void session.dispose();
          return;
        }
        setPages(session.pages);
        dispose = session.dispose;
      })
      .catch((caught: unknown) => {
        if (!disposed) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      });
    onCleanup(() => {
      disposed = true;
      void dispose();
    });
  });

  return (
    <div class="mt-8 grid gap-4" data-testid="provider-setup">
      <Show when={error()}>
        {(message) => (
          <p class="text-sm text-[var(--danger)]" data-testid="provider-setup-error">
            {message()}
          </p>
        )}
      </Show>
      <For each={pages()}>
        {(page) => <Dynamic component={page.component} />}
      </For>
    </div>
  );
}
