import { defineUiPlugin } from "@borg/plugin-sdk";
import { Panel } from "@borg/ui-kit";
import { KeyRound, ShieldCheck } from "lucide-solid";
import { createSignal, onMount, type Component } from "solid-js";

export default defineUiPlugin<Component>({
  id: "borg.secrets.os",
  activate(context) {
    const [configured, setConfigured] = createSignal(false);
    const OsSecrets: Component = () => {
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
            title: "Secure storage verified",
            body: "Borg can encrypt secrets with the operating system.",
            level: "success",
          });
        } finally {
          setSaving(false);
        }
      };

      return (
        <Panel data-testid="os-secrets-step">
          <div class="flex items-start gap-4">
            <div class="rounded-xl bg-[var(--accent)]/10 p-2.5 text-[var(--accent)]">
              <ShieldCheck aria-hidden="true" size={20} />
            </div>
            <div class="min-w-0 flex-1">
              <p class="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--accent)]">
                OS-protected backend
              </p>
              <h3 class="mt-2 text-lg font-semibold">Verify secure secret storage</h3>
              <p class="mt-2 text-sm text-[var(--text-muted)]">
                Values are encrypted using the operating system’s protected storage
                before they are written to Borg’s local data directory.
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
                      data-testid="os-secret-input"
                    />
                  </div>
                  <button
                    type="button"
                    class="rounded-xl bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-[var(--background)] disabled:opacity-50"
                    disabled={saving() || secret().length === 0}
                    onClick={() => void save()}
                    data-testid="os-secret-save"
                  >
                    {saving() ? "Saving…" : "Save"}
                  </button>
                </div>
              </label>

              <p
                class="mt-3 text-xs text-[var(--text-muted)]"
                data-testid="os-secret-status"
              >
                {configured() ? "Secure storage verified." : "Verification pending."}
              </p>
            </div>
          </div>
        </Panel>
      );
    };

    const wizard = context.ui.registerWizardStep({
      id: "borg.secrets.os.setup",
      label: "Secure storage",
      order: 20,
      required: true,
      isComplete: configured,
      component: OsSecrets,
    });
    const settings = context.ui.registerSettingsPage({
      id: "borg.secrets.os.settings",
      label: "Secure storage",
      order: 20,
      component: OsSecrets,
    });
    return {
      dispose: async () => {
        await settings.dispose();
        await wizard.dispose();
      },
    };
  },
});
