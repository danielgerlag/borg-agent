import {
  tavilyConnect,
  tavilyDisconnect,
  tavilyGetStatus,
  type SearchProviderStatus,
} from "@borg/contracts";
import { defineUiPlugin } from "@borg/plugin-sdk";
import { Button, Panel } from "@borg/ui-kit";
import { KeyRound, Search } from "lucide-solid";
import { createSignal, onMount, type Component } from "solid-js";

const IDLE_STATUS: SearchProviderStatus = {
  hasKey: false,
  enabled: false,
  connected: false,
};

export default defineUiPlugin<Component>({
  id: "borg.search.tavily",
  activate(context) {
    const TavilySettings: Component = () => {
      const [keyDraft, setKeyDraft] = createSignal("");
      const [status, setStatus] = createSignal<SearchProviderStatus>(IDLE_STATUS);
      const [busy, setBusy] = createSignal(false);
      const [message, setMessage] = createSignal(
        "Save a Tavily API key, then connect to register web search.",
      );
      const [error, setError] = createSignal<string>();

      const refresh = async (): Promise<void> => {
        const [stored, current] = await Promise.all([
          context.secrets.has("apiKey"),
          context.bus.invoke(tavilyGetStatus, {}),
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
          await context.bus.invoke(tavilyDisconnect, {});
          setKeyDraft("");
          setMessage("API key saved. Connect to enable Tavily search.");
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
          const current = await context.bus.invoke(tavilyConnect, {});
          setStatus(current);
          setMessage(
            current.connected
              ? "Tavily search is available to the assistant."
              : "Tavily is not connected.",
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
            await context.bus.invoke(tavilyDisconnect, {});
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
        <Panel data-testid="tavily-setup-step">
          <div class="flex items-start gap-4">
            <div class="rounded-xl bg-[var(--accent)]/10 p-2.5 text-[var(--accent)]">
              <Search aria-hidden="true" size={20} />
            </div>
            <div class="min-w-0 flex-1">
              <h3 class="text-xl font-semibold">Tavily search</h3>
              <p class="mt-2 text-sm text-[var(--text-muted)]">
                Enable the public web search tool. Results are untrusted
                external content and require approval.
              </p>

              <label
                class="mt-5 block text-sm text-[var(--text-muted)]"
                for="tavily-api-key"
              >
                API key
              </label>
              <input
                id="tavily-api-key"
                type="password"
                autocomplete="off"
                spellcheck={false}
                value={keyDraft()}
                onInput={(event) => setKeyDraft(event.currentTarget.value)}
                class="mt-2 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm"
                placeholder={
                  status().hasKey
                    ? "Key saved. Enter a new key to replace it."
                    : "tvly-…"
                }
                data-testid="tavily-api-key"
              />

              <div class="mt-4 flex flex-wrap gap-2">
                <Button
                  type="button"
                  disabled={busy() || !keyDraft().trim()}
                  onClick={() => void save()}
                  data-testid="tavily-save-key"
                >
                  <KeyRound aria-hidden="true" size={16} />
                  {busy() ? "Saving…" : "Save key"}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={busy() || !status().hasKey}
                  onClick={() => void connect()}
                  data-testid="tavily-connect"
                >
                  {status().connected ? "Reconnect" : "Enable and connect"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy() || (!status().hasKey && !status().connected)}
                  onClick={() => void removeKey()}
                  data-testid="tavily-delete-key"
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
                data-testid="tavily-status"
              >
                {error() ??
                  (status().connected
                    ? "Tavily search is connected."
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
      id: "borg.search.tavily.settings",
      label: "Tavily",
      order: 40,
      component: TavilySettings,
    });
  },
});
