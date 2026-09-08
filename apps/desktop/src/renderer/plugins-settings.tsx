import { Panel } from "@borg/ui-kit";
import { For, Show, createSignal, onMount, type Component } from "solid-js";

function pluginLabel(id: string): string {
  const trimmed = id.startsWith("borg.") ? id.slice("borg.".length) : id;
  return trimmed.replaceAll(".", " · ");
}

export const PluginsSettings: Component<{
  readonly shellCapability: string;
}> = (props) => {
  const [plugins, setPlugins] = createSignal<readonly PluginCatalogEntry[]>([]);
  const [error, setError] = createSignal<string>();
  const [pendingId, setPendingId] = createSignal<string>();

  onMount(() => {
    void window.borg.plugins
      .list(props.shellCapability)
      .then(setPlugins)
      .catch((failure: unknown) =>
        setError(failure instanceof Error ? failure.message : String(failure)),
      );
  });

  const toggle = async (
    plugin: PluginCatalogEntry,
    enabled: boolean,
  ): Promise<void> => {
    if (plugin.locked || pendingId() !== undefined) {
      return;
    }
    setPendingId(plugin.id);
    setError(undefined);
    try {
      await window.borg.plugins.setEnabled(
        props.shellCapability,
        plugin.id,
        enabled,
      );
      sessionStorage.setItem("borg.restore.surface", "settings");
      sessionStorage.setItem("borg.restore.settingsSection", "system.plugins");
      location.reload();
    } catch (failure) {
      setPendingId();
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };

  return (
    <Panel data-testid="plugins-settings-page">
      <p class="text-sm text-[var(--text-muted)]">
        Turn plugins off so their tools, channels, and settings pages unload.
        Locked rows stay on.
      </p>
      <Show when={error()}>
        <p class="mt-3 text-sm text-[var(--danger)]">{error()}</p>
      </Show>
      <div class="mt-5 grid gap-3">
        <For each={plugins()}>
          {(plugin) => (
            <div
              class="flex items-start justify-between gap-4 rounded-xl border border-[var(--border)] px-3 py-3"
              data-testid={`plugin-row-${plugin.id}`}
            >
              <div class="min-w-0">
                <p class="text-sm font-medium">{pluginLabel(plugin.id)}</p>
                <p class="mt-1 font-mono text-xs text-[var(--text-muted)]">
                  {plugin.id}
                </p>
                <Show when={plugin.locked}>
                  <p class="mt-1 text-xs text-[var(--text-muted)]">
                    {plugin.lockReason}
                  </p>
                </Show>
              </div>
              <label class="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={plugin.enabled}
                  disabled={plugin.locked || pendingId() !== undefined}
                  onChange={(event) =>
                    void toggle(plugin, event.currentTarget.checked)
                  }
                  data-testid={`plugin-enabled-${plugin.id}`}
                />
              </label>
            </div>
          )}
        </For>
      </div>
    </Panel>
  );
};
