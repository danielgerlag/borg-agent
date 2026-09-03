import { defineUiPlugin } from "@borg/plugin-sdk";
import { Panel } from "@borg/ui-kit";
import { FlaskConical, KeyRound } from "lucide-solid";
import { createSignal, onMount, type Component } from "solid-js";

export default defineUiPlugin<Component>({
  id: "borg.secrets.dev",
  activate(context) {
    const [configured, setConfigured] = createSignal(false);
    const DevelopmentSecrets: Component = () => {
      const [secret, setSecret] = createSignal("");
      const [saving, setSaving] = createSignal(false);

      onMount(() => {
        void context.secrets.has("setup-check").then(setConfigured);
      });

      const save = async (): Promise<void> => {
        if (secret().length === 0) {
          return;
        }
        setSaving(true);
        try {
          await context.secrets.set("setup-check", secret());
          setSecret("");
          setConfigured(true);
          await context.notify({
            title: "Development secret saved",
            body: "The local development secret backend is ready.",
            level: "success",
          });
        } finally {
          setSaving(false);
        }
      };

      return (
        <Panel data-testid="dev-secrets-step">
          <div class="flex items-start gap-4">
            <div class="rounded-xl bg-amber-400/10 p-2.5 text-amber-300">
              <FlaskConical aria-hidden="true" size={20} />
            </div>
            <div class="min-w-0 flex-1">
              <p class="text-xs font-semibold uppercase tracking-[0.2em] text-amber-300">
                Development backend
              </p>
              <h3 class="mt-2 text-lg font-semibold">Verify local secret storage</h3>
              <p class="mt-2 text-sm text-[var(--text-muted)]">
                This explicit development option stores plaintext in Borg’s local plugin
                data directory. Do not use it for production credentials.
              </p>

              <label class="mt-5 block text-xs font-medium text-[var(--text-muted)]">
                Test secret
                <div class="mt-2 flex gap-2">
                  <div class="relative min-w-0 flex-1">
                    <KeyRound
                      class="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-subtle)]"
                      aria-hidden="true"
                      size={16}
                    />
                    <input
                      type="password"
                      value={secret()}
                      onInput={(event) => setSecret(event.currentTarget.value)}
                      class="w-full rounded-xl border border-[var(--border)] bg-[var(--background)] py-2.5 pl-10 pr-3 text-sm outline-none transition focus:border-[var(--accent)]"
                      placeholder="Enter any test value"
                      data-testid="dev-secret-input"
                    />
                  </div>
                  <button
                    type="button"
                    class="rounded-xl bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[var(--background)] disabled:opacity-50"
                    disabled={saving() || secret().length === 0}
                    onClick={() => void save()}
                    data-testid="dev-secret-save"
                  >
                    {saving() ? "Saving…" : "Save"}
                  </button>
                </div>
              </label>

              <p
                class="mt-3 text-xs text-[var(--text-muted)]"
                data-testid="dev-secret-status"
              >
                {configured() ? "Secret backend verified." : "Verification pending."}
              </p>
            </div>
          </div>
        </Panel>
      );
    };

    const wizard = context.ui.registerWizardStep({
      id: "borg.secrets.dev.setup",
      label: "Development secrets",
      order: 20,
      required: true,
      isComplete: configured,
      component: DevelopmentSecrets,
    });
    const settings = context.ui.registerSettingsPage({
      id: "borg.secrets.dev.settings",
      label: "Development secrets",
      order: 20,
      component: DevelopmentSecrets,
    });
    return {
      dispose: async () => {
        await settings.dispose();
        await wizard.dispose();
      },
    };
  },
});
