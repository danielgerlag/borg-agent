import {
  openaiConnect,
  openaiDisconnect,
  openaiGetStatus,
} from "@borg/contracts";
import { defineUiPlugin } from "@borg/plugin-sdk";
import { Button, Panel } from "@borg/ui-kit";
import { KeyRound, Sparkles } from "lucide-solid";
import { createSignal, onMount, type Component } from "solid-js";

export default defineUiPlugin<Component>({
  id: "borg.openai",
  activate(context) {
    const OpenAISetup: Component = () => {
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
          context.bus.invoke(openaiGetStatus, {}),
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
          await context.bus.invoke(openaiDisconnect, {});
          setKeyDraft("");
          setHasKey(true);
          setConnected(false);
          setMessage("API key saved. Connect to use GPT models.");
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
          const status = await context.bus.invoke(openaiConnect, {});
          setHasKey(status.hasKey);
          setConnected(status.connected);
          setMessage(
            status.connected
              ? "GPT models are available in assistant setup."
              : "OpenAI is not connected.",
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
            await context.bus.invoke(openaiDisconnect, {});
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
        <Panel data-testid="openai-setup-step">
          <div class="flex items-start gap-4">
            <div class="rounded-xl bg-[var(--accent)]/10 p-2.5 text-[var(--accent)]">
              <Sparkles aria-hidden="true" size={20} />
            </div>
            <div class="min-w-0 flex-1">
              <p class="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--accent)]">
                Optional
              </p>
              <h3 class="mt-2 text-xl font-semibold">Connect OpenAI</h3>
              <p class="mt-2 text-sm text-[var(--text-muted)]">
                Save a GPT API key to use GPT-5 Mini, GPT-5 Nano, and GPT-5. You
                can skip this and keep the built-in demo model.
              </p>

              <label class="mt-5 block text-sm text-[var(--text-muted)]" for="openai-api-key">
                API key
              </label>
              <input
                id="openai-api-key"
                type="password"
                autocomplete="off"
                spellcheck={false}
                value={keyDraft()}
                onInput={(event) => setKeyDraft(event.currentTarget.value)}
                class="mt-2 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm"
                placeholder={hasKey() ? "Key saved. Enter a new key to replace it." : "sk-…"}
                data-testid="openai-api-key"
              />

              <div class="mt-4 flex flex-wrap gap-2">
                <Button
                  type="button"
                  disabled={busy() || !keyDraft().trim()}
                  onClick={() => void save()}
                  data-testid="openai-save-key"
                >
                  <KeyRound aria-hidden="true" size={16} />
                  {busy() ? "Saving…" : "Save key"}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={busy() || !hasKey()}
                  onClick={() => void connect()}
                  data-testid="openai-connect"
                >
                  {connected() ? "Reconnect" : "Verify and connect"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy() || (!hasKey() && !connected())}
                  onClick={() => void removeKey()}
                  data-testid="openai-delete-key"
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
                data-testid="openai-status"
              >
                {error() ??
                  (connected()
                    ? "GPT is connected for this Borg session."
                    : hasKey()
                      ? "A key is saved. Verify it to enable GPT models."
                      : message())}
              </p>
            </div>
          </div>
        </Panel>
      );
    };

    const wizard = context.ui.registerWizardStep({
      id: "borg.openai.setup",
      label: "GPT",
      order: 26,
      required: false,
      isComplete: () => true,
      component: OpenAISetup,
    });
    const settings = context.ui.registerSettingsPage({
      id: "borg.openai.settings",
      label: "OpenAI",
      order: 26,
      component: OpenAISetup,
    });
    return {
      dispose: async () => {
        await settings.dispose();
        await wizard.dispose();
      },
    };
  },
});
