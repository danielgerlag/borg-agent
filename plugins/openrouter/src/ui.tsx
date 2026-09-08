import {
  openrouterConnect,
  openrouterDisconnect,
  openrouterGetStatus,
} from "@borg/contracts";
import { defineUiPlugin } from "@borg/plugin-sdk";
import { Button, Panel } from "@borg/ui-kit";
import { Globe, KeyRound } from "lucide-solid";
import { createSignal, onMount, type Component } from "solid-js";

export default defineUiPlugin<Component>({
  id: "borg.openrouter",
  activate(context) {
    const OpenRouterSetup: Component = () => {
      const [keyDraft, setKeyDraft] = createSignal("");
      const [hasKey, setHasKey] = createSignal(false);
      const [connected, setConnected] = createSignal(false);
      const [busy, setBusy] = createSignal(false);
      const [message, setMessage] = createSignal(
        "Optional. Skip to keep using the built-in demo model.",
      );
      const [error, setError] = createSignal<string>();

      const refresh = async (): Promise<void> => {
        const [stored, status] = await Promise.all([
          context.secrets.has("apiKey"),
          context.bus.invoke(openrouterGetStatus, {}),
        ]);
        setHasKey(stored);
        setConnected(status.connected);
      };

      onMount(() => {
        void refresh().catch((failure: unknown) =>
          setError(failure instanceof Error ? failure.message : String(failure)),
        );
      });

      const save = async (): Promise<void> => {
        const value = keyDraft().trim();
        if (!value) {
          setError("Enter an API key to save.");
          return;
        }
        setBusy(true);
        setError(undefined);
        try {
          await context.secrets.set("apiKey", value);
          await context.bus.invoke(openrouterDisconnect, {});
          setKeyDraft("");
          setHasKey(true);
          setConnected(false);
          setMessage("API key saved. Connect to use OpenRouter models.");
          await refresh();
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure));
        } finally {
          setBusy(false);
        }
      };

      const connect = async (): Promise<void> => {
        setBusy(true);
        setError(undefined);
        try {
          const status = await context.bus.invoke(openrouterConnect, {});
          setHasKey(status.hasKey);
          setConnected(status.connected);
          setMessage(
            status.connected
              ? "OpenRouter models are available in assistant setup."
              : "OpenRouter is not connected.",
          );
        } catch (failure) {
          setConnected(false);
          setError(failure instanceof Error ? failure.message : String(failure));
        } finally {
          setBusy(false);
        }
      };

      const removeKey = async (): Promise<void> => {
        setBusy(true);
        setError(undefined);
        try {
          try {
            await context.bus.invoke(openrouterDisconnect, {});
          } finally {
            await context.secrets.delete("apiKey");
          }
          setHasKey(false);
          setConnected(false);
          setKeyDraft("");
          setMessage("API key removed.");
          await refresh();
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure));
        } finally {
          setBusy(false);
        }
      };

      return (
        <Panel data-testid="openrouter-setup-step">
          <div class="flex items-start gap-4">
            <div class="rounded-xl bg-[var(--accent)]/10 p-2.5 text-[var(--accent)]">
              <Globe aria-hidden="true" size={20} />
            </div>
            <div class="min-w-0 flex-1">
              <p class="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--accent)]">
                Optional
              </p>
              <h3 class="mt-2 text-xl font-semibold">Connect OpenRouter</h3>
              <p class="mt-2 text-sm text-[var(--text-muted)]">
                Save an OpenRouter API key to use models from the OpenRouter
                catalog. You can skip this and keep the built-in demo model.
              </p>

              <label
                class="mt-5 block text-sm text-[var(--text-muted)]"
                for="openrouter-api-key"
              >
                API key
              </label>
              <input
                id="openrouter-api-key"
                type="password"
                autocomplete="off"
                spellcheck={false}
                value={keyDraft()}
                onInput={(event) => setKeyDraft(event.currentTarget.value)}
                class="mt-2 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm"
                placeholder={
                  hasKey() ? "Key saved. Enter a new key to replace it." : "sk-or-…"
                }
                data-testid="openrouter-api-key"
              />

              <div class="mt-4 flex flex-wrap gap-2">
                <Button
                  type="button"
                  disabled={busy() || !keyDraft().trim()}
                  onClick={() => void save()}
                  data-testid="openrouter-save-key"
                >
                  <KeyRound aria-hidden="true" size={16} />
                  {busy() ? "Saving…" : "Save key"}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={busy() || !hasKey()}
                  onClick={() => void connect()}
                  data-testid="openrouter-connect"
                >
                  {connected() ? "Reconnect" : "Verify and connect"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy() || (!hasKey() && !connected())}
                  onClick={() => void removeKey()}
                  data-testid="openrouter-delete-key"
                >
                  Remove key
                </Button>
              </div>

              <p
                class="mt-3 text-xs"
                classList={{
                  "text-[var(--success)]": connected() && !error(),
                  "text-[var(--text-muted)]": !connected() && !error(),
                  "text-[var(--danger)]": Boolean(error()),
                }}
                data-testid="openrouter-status"
              >
                {error() ??
                  (connected()
                    ? "OpenRouter is connected for this Borg session."
                    : hasKey()
                      ? "A key is saved. Verify it to enable OpenRouter models."
                      : message())}
              </p>
            </div>
          </div>
        </Panel>
      );
    };

    const wizard = context.ui.registerWizardStep({
      id: "borg.openrouter.setup",
      label: "OpenRouter",
      order: 31,
      required: false,
      isComplete: () => true,
      component: OpenRouterSetup,
    });
    const settings = context.ui.registerSettingsPage({
      id: "borg.openrouter.settings",
      label: "OpenRouter",
      order: 31,
      component: OpenRouterSetup,
    });
    return {
      dispose: async () => {
        await settings.dispose();
        await wizard.dispose();
      },
    };
  },
});
