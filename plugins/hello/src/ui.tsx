import { helloGetStatus } from "@borg/contracts";
import { defineUiPlugin } from "@borg/plugin-sdk";
import { Panel } from "@borg/ui-kit";
import { Activity, CircleAlert, LoaderCircle, MessageSquareText } from "lucide-solid";
import {
  Match,
  Switch,
  createResource,
  createSignal,
  onMount,
  type Component,
} from "solid-js";

export default defineUiPlugin<Component>({
  id: "borg.hello",
  activate(context) {
    const HelloWidget: Component = () => {
      const [status] = createResource(async () => context.bus.invoke(helloGetStatus, {}));

      return (
        <Panel data-testid="hello-widget">
          <div class="flex items-start justify-between gap-4">
            <div>
              <p class="text-xs font-semibold uppercase tracking-[0.24em] text-[var(--accent)]">
                Plugin handshake
              </p>
              <h2 class="mt-2 text-xl font-semibold text-[var(--text)]">Kernel status</h2>
            </div>
            <div class="rounded-xl bg-[color-mix(in_srgb,var(--accent)_15%,transparent)] p-2 text-[var(--accent)]">
              <Activity aria-hidden="true" size={20} />
            </div>
          </div>

          <Switch>
            <Match when={status.loading}>
              <div
                class="mt-8 flex items-center gap-3 text-sm text-[var(--text-muted)]"
                data-testid="hello-status-loading"
              >
                <LoaderCircle class="animate-spin" aria-hidden="true" size={18} />
                Contacting the main-process kernel…
              </div>
            </Match>
            <Match when={status.error}>
              <div
                class="mt-8 flex items-center gap-3 text-sm text-[var(--danger)]"
                data-testid="hello-status-error"
              >
                <CircleAlert aria-hidden="true" size={18} />
                The hello command is unavailable.
              </div>
            </Match>
            <Match when={status()}>
              {(resolved) => (
                <div class="mt-8" data-testid="hello-status-alive">
                  <div class="flex items-center gap-3">
                    <span class="relative flex size-3">
                      <span class="absolute inline-flex size-full animate-ping rounded-full bg-[var(--success)] opacity-60" />
                      <span class="relative inline-flex size-3 rounded-full bg-[var(--success)]" />
                    </span>
                    <span class="text-lg font-medium text-[var(--text)]">
                      {resolved().message}
                    </span>
                  </div>
                  <dl class="mt-5 grid gap-2 text-sm text-[var(--text-muted)] sm:grid-cols-2">
                    <div>
                      <dt class="text-xs uppercase tracking-wider">Plugin</dt>
                      <dd class="mt-1 font-mono text-[var(--text)]">{resolved().pluginId}</dd>
                    </div>
                    <div>
                      <dt class="text-xs uppercase tracking-wider">Kernel</dt>
                      <dd class="mt-1 font-mono text-[var(--text)]">
                        {resolved().kernelVersion}
                      </dd>
                    </div>
                  </dl>
                </div>
              )}
            </Match>
          </Switch>
        </Panel>
      );
    };

    const HelloSettings: Component = () => {
      const [message, setMessage] = createSignal("Kernel alive");
      const [saved, setSaved] = createSignal(false);

      onMount(() => {
        void context.config.get().then((config) => {
          if (typeof config.message === "string") {
            setMessage(config.message);
          }
        });
      });

      const save = async (): Promise<void> => {
        const updated = await context.config.update({ message: message() });
        if (typeof updated.message === "string") {
          setMessage(updated.message);
        }
        setSaved(true);
        await context.notify({
          title: "Hello settings saved",
          body: "The Flight Deck message was persisted.",
          level: "success",
        });
      };

      return (
        <Panel data-testid="hello-settings-page">
          <div class="flex items-start gap-4">
            <div class="rounded-xl bg-[var(--accent)]/10 p-2.5 text-[var(--accent)]">
              <MessageSquareText aria-hidden="true" size={20} />
            </div>
            <div class="min-w-0 flex-1">
              <h3 class="text-lg font-semibold">Hello widget</h3>
              <p class="mt-2 text-sm text-[var(--text-muted)]">
                Change the status message shown on the Flight Deck.
              </p>
              <div class="mt-5 flex gap-2">
                <input
                  value={message()}
                  onInput={(event) => {
                    setMessage(event.currentTarget.value);
                    setSaved(false);
                  }}
                  class="min-w-0 flex-1 rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2.5 text-sm outline-none transition focus:border-[var(--accent)]"
                  data-testid="hello-message-input"
                />
                <button
                  type="button"
                  class="rounded-xl bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[var(--background)]"
                  onClick={() => void save()}
                  data-testid="hello-message-save"
                >
                  Save
                </button>
              </div>
              <p class="mt-3 text-xs text-[var(--text-muted)]" data-testid="hello-message-status">
                {saved() ? "Saved." : "Changes are persisted by the config facade."}
              </p>
            </div>
          </div>
        </Panel>
      );
    };

    const widget = context.ui.registerFlightDeckWidget({
      id: "borg.hello.kernel-status",
      label: "Kernel status",
      placement: "developer",
      component: HelloWidget,
    });
    const settings = context.ui.registerSettingsPage({
      id: "borg.hello.settings",
      label: "Hello",
      order: 10,
      placement: "developer",
      component: HelloSettings,
    });
    return {
      dispose: async () => {
        await settings.dispose();
        await widget.dispose();
      },
    };
  },
});
