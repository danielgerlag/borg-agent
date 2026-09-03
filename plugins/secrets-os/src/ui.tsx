import { defineUiPlugin } from "@borg/plugin-sdk";
import { Button, Panel } from "@borg/ui-kit";
import { CheckCircle2, ShieldCheck } from "lucide-solid";
import { createSignal, onMount, type Component } from "solid-js";

export default defineUiPlugin<Component>({
  id: "borg.secrets.os",
  activate(context) {
    const [configured, setConfigured] = createSignal(false);
    const OsSecrets: Component = () => {
      const [saving, setSaving] = createSignal(false);
      const [error, setError] = createSignal<string>();

      onMount(() => {
        void context.secrets
          .has("setup-check")
          .then(setConfigured)
          .catch((failure: unknown) =>
            setError(failure instanceof Error ? failure.message : String(failure)),
          );
      });

      const verify = async (): Promise<void> => {
        setSaving(true);
        setError(undefined);
        try {
          await context.secrets.set("setup-check", crypto.randomUUID());
          if (!(await context.secrets.has("setup-check"))) {
            throw new Error("Borg could not read the verification marker");
          }
          setConfigured(true);
          await context.notify({
            title: "Secure storage verified",
            body: "Borg can protect credentials with your operating system.",
            level: "success",
          });
        } catch (failure) {
          setConfigured(false);
          setError(failure instanceof Error ? failure.message : String(failure));
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
                Protected by your device
              </p>
              <h3 class="mt-2 text-xl font-semibold">Protect your credentials</h3>
              <p class="mt-2 text-sm text-[var(--text-muted)]">
                Borg uses your operating system’s secure storage for API keys and other
                credentials. Verify access before continuing.
              </p>

              <Button
                type="button"
                class="mt-6"
                disabled={saving() || configured()}
                onClick={() => void verify()}
                data-testid="os-secret-save"
              >
                <CheckCircle2 aria-hidden="true" size={16} />
                {saving()
                  ? "Checking…"
                  : configured()
                    ? "Storage verified"
                    : "Verify secure storage"}
              </Button>

              <p
                class="mt-3 text-xs"
                classList={{
                  "text-[var(--success)]": configured(),
                  "text-[var(--text-muted)]": !configured() && !error(),
                  "text-[var(--danger)]": Boolean(error()),
                }}
                data-testid="os-secret-status"
              >
                {error() ??
                  (configured()
                    ? "Secure credential storage is ready."
                    : "Verification takes only a moment.")}
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
