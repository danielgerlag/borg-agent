import { defineUiPlugin } from "@borg/plugin-sdk";
import { Button, Panel } from "@borg/ui-kit";
import { SunMoon } from "lucide-solid";
import { createSignal, onMount, type Component } from "solid-js";

function applyTheme(theme: string): void {
  document.documentElement.dataset.theme = theme === "light" ? "light" : "dark";
}

export default defineUiPlugin<Component>({
  id: "borg.themes",
  activate(context) {
    const applyFromConfig = async (): Promise<void> => {
      const config = await context.config.get();
      applyTheme(typeof config.theme === "string" ? config.theme : "dark");
    };
    void applyFromConfig();

    const ThemeSettings: Component = () => {
      const [theme, setTheme] = createSignal<"dark" | "light">("dark");
      const [busy, setBusy] = createSignal(false);
      const [message, setMessage] = createSignal("Dark is the default.");
      const [error, setError] = createSignal<string>();

      onMount(() => {
        void context.config
          .get()
          .then((config) => {
            const next = config.theme === "light" ? "light" : "dark";
            setTheme(next);
            applyTheme(next);
          })
          .catch((failure: unknown) =>
            setError(failure instanceof Error ? failure.message : String(failure)),
          );
      });

      const save = async (): Promise<void> => {
        setBusy(true);
        setError(undefined);
        try {
          const next = theme();
          await context.config.update({ theme: next });
          applyTheme(next);
          setMessage(next === "light" ? "Light theme saved." : "Dark theme saved.");
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure));
        } finally {
          setBusy(false);
        }
      };

      return (
        <Panel data-testid="themes-settings-page">
          <div class="flex items-start gap-4">
            <div class="rounded-xl bg-[var(--accent)]/10 p-2.5 text-[var(--accent)]">
              <SunMoon aria-hidden="true" size={20} />
            </div>
            <div class="min-w-0 flex-1">
              <h3 class="text-xl font-semibold">Appearance</h3>
              <p class="mt-2 text-sm text-[var(--text-muted)]">
                Choose the shell color theme. Dark is the default.
              </p>
              <label
                class="mt-5 block text-sm text-[var(--text-muted)]"
                for="themes-select"
              >
                Theme
              </label>
              <select
                id="themes-select"
                value={theme()}
                onChange={(event) =>
                  setTheme(
                    event.currentTarget.value === "light" ? "light" : "dark",
                  )
                }
                class="mt-2 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm"
                data-testid="themes-select"
              >
                <option value="dark">Dark</option>
                <option value="light">Light</option>
              </select>
              <div class="mt-4">
                <Button
                  type="button"
                  disabled={busy()}
                  onClick={() => void save()}
                  data-testid="themes-save"
                >
                  {busy() ? "Saving…" : "Save"}
                </Button>
              </div>
              <p
                class="mt-3 text-xs"
                classList={{
                  "text-[var(--danger)]": Boolean(error()),
                  "text-[var(--text-muted)]": !error(),
                }}
                data-testid="themes-status"
              >
                {error() ?? message()}
              </p>
            </div>
          </div>
        </Panel>
      );
    };

    return context.ui.registerSettingsPage({
      id: "borg.themes.settings",
      label: "Appearance",
      order: 8,
      component: ThemeSettings,
    });
  },
});
