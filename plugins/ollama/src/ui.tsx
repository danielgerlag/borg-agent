import {
  ollamaConnect,
  ollamaDisconnect,
  ollamaGetStatus,
} from "@borg/contracts";
import { defineUiPlugin } from "@borg/plugin-sdk";
import { Button, Panel, TextField } from "@borg/ui-kit";
import { Server } from "lucide-solid";
import { createSignal, onMount, type Component } from "solid-js";
import { DEFAULT_OLLAMA_BASE_URL, parseOllamaConfig } from "./config";

export default defineUiPlugin<Component>({
  id: "borg.ollama",
  activate(context) {
    const OllamaSetup: Component = () => {
      const [baseUrl, setBaseUrl] = createSignal(DEFAULT_OLLAMA_BASE_URL);
      const [connected, setConnected] = createSignal(false);
      const [modelCount, setModelCount] = createSignal(0);
      const [busy, setBusy] = createSignal(false);
      const [message, setMessage] = createSignal(
        "Optional. Connect a local Ollama server to use its models.",
      );
      const [error, setError] = createSignal<string>();

      const refresh = async (): Promise<void> => {
        const [document, status] = await Promise.all([
          context.config.get(),
          context.bus.invoke(ollamaGetStatus, {}),
        ]);
        const parsed = parseOllamaConfig(document);
        setBaseUrl(parsed.baseUrl);
        setConnected(status.connected);
        setModelCount(status.modelCount);
      };

      onMount(() => {
        void refresh().catch((failure: unknown) =>
          setError(failure instanceof Error ? failure.message : String(failure)),
        );
      });

      const save = async (): Promise<void> => {
        setBusy(true);
        setError(undefined);
        try {
          await context.config.update({ baseUrl: baseUrl().trim() });
          await context.bus.invoke(ollamaDisconnect, {});
          setConnected(false);
          setMessage("Base URL saved. Connect to load local models.");
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
          await context.config.update({ baseUrl: baseUrl().trim() });
          const status = await context.bus.invoke(ollamaConnect, {});
          setConnected(status.connected);
          setModelCount(status.modelCount);
          setMessage(
            status.connected
              ? `Ollama is connected with ${status.modelCount} models.`
              : "Ollama is not connected.",
          );
        } catch (failure) {
          setConnected(false);
          setError(failure instanceof Error ? failure.message : String(failure));
        } finally {
          setBusy(false);
        }
      };

      const disconnect = async (): Promise<void> => {
        setBusy(true);
        setError(undefined);
        try {
          const status = await context.bus.invoke(ollamaDisconnect, {});
          setConnected(status.connected);
          setModelCount(status.modelCount);
          setMessage("Ollama disconnected.");
          await refresh();
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure));
        } finally {
          setBusy(false);
        }
      };

      return (
        <Panel data-testid="ollama-setup-step">
          <div class="flex items-start gap-4">
            <div class="rounded-xl bg-[var(--accent)]/10 p-2.5 text-[var(--accent)]">
              <Server aria-hidden="true" size={20} />
            </div>
            <div class="min-w-0 flex-1">
              <p class="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--accent)]">
                Optional
              </p>
              <h3 class="mt-2 text-xl font-semibold">Connect Ollama</h3>
              <p class="mt-2 text-sm text-[var(--text-muted)]">
                Use models from a local Ollama server. Only loopback URLs are
                allowed.
              </p>

              <TextField
                class="mt-5"
                label="Base URL"
                id="ollama-base-url"
                type="text"
                autocomplete="off"
                spellcheck={false}
                value={baseUrl()}
                onChange={setBaseUrl}
                placeholder={DEFAULT_OLLAMA_BASE_URL}
                data-testid="ollama-base-url"
              />

              <div class="mt-4 flex flex-wrap gap-2">
                <Button
                  type="button"
                  disabled={busy() || !baseUrl().trim()}
                  onClick={() => void save()}
                  data-testid="ollama-save"
                >
                  {busy() ? "Saving…" : "Save URL"}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={busy() || !baseUrl().trim()}
                  onClick={() => void connect()}
                  data-testid="ollama-connect"
                >
                  {connected() ? "Reconnect" : "Verify and connect"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy() || !connected()}
                  onClick={() => void disconnect()}
                  data-testid="ollama-disconnect"
                >
                  Disconnect
                </Button>
              </div>

              <p
                class="mt-3 text-xs"
                classList={{
                  "text-[var(--success)]": connected() && !error(),
                  "text-[var(--text-muted)]": !connected() && !error(),
                  "text-[var(--danger)]": Boolean(error()),
                }}
                data-testid="ollama-status"
              >
                {error() ??
                  (connected()
                    ? `Ollama is connected with ${modelCount()} models.`
                    : message())}
              </p>
            </div>
          </div>
        </Panel>
      );
    };

    const wizard = context.ui.registerWizardStep({
      id: "borg.ollama.setup",
      label: "Ollama",
      order: 29,
      required: false,
      isComplete: () => true,
      component: OllamaSetup,
    });
    const settings = context.ui.registerSettingsPage({
      id: "borg.ollama.settings",
      label: "Ollama",
      order: 29,
      component: OllamaSetup,
    });
    return {
      dispose: async () => {
        await settings.dispose();
        await wizard.dispose();
      },
    };
  },
});
