import {
  braveConnect,
  braveDisconnect,
  braveGetStatus,
  type SearchProviderStatus,
} from "@borg/contracts";
import { defineUiPlugin } from "@borg/plugin-sdk";
import { Button, Panel } from "@borg/ui-kit";
import { KeyRound, Shield } from "lucide-solid";
import { createSignal, onMount, type Component } from "solid-js";

const IDLE_STATUS: SearchProviderStatus = {
  hasKey: false,
  enabled: false,
  connected: false,
};

export default defineUiPlugin<Component>({
  id: "borg.search.brave",
  activate(context) {
    const BraveSettings: Component = () => {
      const [keyDraft, setKeyDraft] = createSignal("");
      const [status, setStatus] = createSignal<SearchProviderStatus>(IDLE_STATUS);
      const [busy, setBusy] = createSignal(false);
      const [message, setMessage] = createSignal(
        "Save a Brave Search API key, then connect to register web search.",
      );
      const [error, setError] = createSignal<string>();

      const refresh = async (): Promise<void> => {
        const [stored, current] = await Promise.all([
          context.secrets.has("apiKey"),
          context.bus.invoke(braveGetStatus, {}),
        ]);
        setStatus({ ...current, hasKey: stored });
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
          await context.bus.invoke(braveDisconnect, {});
          setKeyDraft("");
          setMessage("API key saved. Connect to enable Brave search.");
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
          const current = await context.bus.invoke(braveConnect, {});
          setStatus(current);
          setMessage(
            current.connected
              ? "Brave search is available to the assistant."
              : "Brave Search is not connected.",
          );
        } catch (failure) {
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
            await context.bus.invoke(braveDisconnect, {});
          } finally {
            await context.secrets.delete("apiKey");
          }
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
        <Panel data-testid="brave-setup-step">
          <div class="flex items-start gap-4">
            <div class="rounded-xl bg-[var(--accent)]/10 p-2.5 text-[var(--accent)]">
              <Shield aria-hidden="true" size={20} />
            </div>
            <div class="min-w-0 flex-1">
              <h3 class="text-xl font-semibold">Brave search</h3>
              <p class="mt-2 text-sm text-[var(--text-muted)]">
                Enable the public Brave Search tool. Results are untrusted
                external content and require approval.
              </p>

              <label
                class="mt-5 block text-sm text-[var(--text-muted)]"
                for="brave-api-key"
              >
                API key
              </label>
              <input
                id="brave-api-key"
                type="password"
                autocomplete="off"
                spellcheck={false}
                value={keyDraft()}
                onInput={(event) => setKeyDraft(event.currentTarget.value)}
                class="mt-2 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm"
                placeholder={
                  status().hasKey
                    ? "Key saved. Enter a new key to replace it."
                    : "BSA..."
                }
                data-testid="brave-api-key"
              />

              <div class="mt-4 flex flex-wrap gap-2">
                <Button
                  type="button"
                  disabled={busy() || !keyDraft().trim()}
                  onClick={() => void save()}
                  data-testid="brave-save-key"
                >
                  <KeyRound aria-hidden="true" size={16} />
                  {busy() ? "Saving…" : "Save key"}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={busy() || !status().hasKey}
                  onClick={() => void connect()}
                  data-testid="brave-connect"
                >
                  {status().connected ? "Reconnect" : "Enable and connect"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy() || (!status().hasKey && !status().connected)}
                  onClick={() => void removeKey()}
                  data-testid="brave-delete-key"
                >
                  Remove key
                </Button>
              </div>

              <p
                class="mt-3 text-xs"
                classList={{
                  "text-[var(--success)]": status().connected && !error(),
                  "text-[var(--text-muted)]": !status().connected && !error(),
                  "text-[var(--danger)]": Boolean(error()),
                }}
                data-testid="brave-status"
              >
                {error() ??
                  (status().connected
                    ? "Brave search is connected."
                    : status().hasKey
                      ? "A key is saved. Connect to register the search tool."
                      : message())}
              </p>
            </div>
          </div>
        </Panel>
      );
    };

    return context.ui.registerSettingsPage({
      id: "borg.search.brave.settings",
      label: "Brave Search",
      order: 41,
      component: BraveSettings,
    });
  },
});
