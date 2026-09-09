import {
  azureConnect,
  azureDisconnect,
  azureGetStatus,
} from "@borg/contracts";
import { defineUiPlugin } from "@borg/plugin-sdk";
import { Button, Panel, Select, TextField } from "@borg/ui-kit";
import { Cloud, KeyRound } from "lucide-solid";
import { Show, createSignal, onMount, type Component } from "solid-js";
import {
  AZURE_DEFAULT_API_VERSION,
  parseAzureConfig,
  type AzureAuthMode,
} from "./config";
import {
  parseAzureUserError,
  type AzureUserErrorShape,
} from "./errors";

function asAuthMode(value: string): AzureAuthMode {
  return value === "azure-default" ? "azure-default" : "api-key";
}

function describeAzureFailure(failure: unknown): AzureUserErrorShape {
  return parseAzureUserError(
    failure instanceof Error ? failure.message : String(failure),
  );
}

const MISSING_KEY_DRAFT: AzureUserErrorShape = {
  headline: "Enter an API key to save.",
  nextStep: "Paste a key from Azure AI Foundry or Azure OpenAI.",
};

export default defineUiPlugin<Component>({
  id: "borg.azure",
  activate(context) {
    const AzureSetup: Component = () => {
      const [endpoint, setEndpoint] = createSignal("");
      const [apiVersion, setApiVersion] = createSignal(AZURE_DEFAULT_API_VERSION);
      const [authMode, setAuthMode] = createSignal<AzureAuthMode>("api-key");
      const [keyDraft, setKeyDraft] = createSignal("");
      const [hasKey, setHasKey] = createSignal(false);
      const [connected, setConnected] = createSignal(false);
      const [busy, setBusy] = createSignal(false);
      const [message, setMessage] = createSignal(
        "Optional. Skip to keep using the built-in demo model.",
      );
      const [error, setError] = createSignal<AzureUserErrorShape>();

      const refresh = async (): Promise<void> => {
        const [document, stored, status] = await Promise.all([
          context.config.get(),
          context.secrets.has("apiKey"),
          context.bus.invoke(azureGetStatus, {}),
        ]);
        const parsed = parseAzureConfig(document);
        setEndpoint(parsed.endpoint);
        setApiVersion(parsed.apiVersion);
        setAuthMode(parsed.authMode);
        setHasKey(stored);
        setConnected(status.connected);
      };

      onMount(() => {
        void refresh().catch((failure: unknown) =>
          setError(describeAzureFailure(failure)),
        );
      });

      const persistSettings = async (): Promise<void> => {
        await context.config.update({
          endpoint: endpoint().trim(),
          apiVersion: apiVersion().trim() || AZURE_DEFAULT_API_VERSION,
          authMode: authMode(),
        });
      };

      const saveSettings = async (): Promise<void> => {
        setBusy(true);
        setError(undefined);
        try {
          await persistSettings();
          await context.bus.invoke(azureDisconnect, {});
          setConnected(false);
          setMessage("Azure settings saved. Connect to load models.");
          await refresh();
        } catch (failure) {
          setError(describeAzureFailure(failure));
        } finally {
          setBusy(false);
        }
      };

      const saveKey = async (): Promise<void> => {
        const value = keyDraft().trim();
        if (!value) {
          setError(MISSING_KEY_DRAFT);
          return;
        }
        setBusy(true);
        setError(undefined);
        try {
          await context.secrets.set("apiKey", value);
          await context.bus.invoke(azureDisconnect, {});
          setKeyDraft("");
          setHasKey(true);
          setConnected(false);
          setMessage("API key saved. Connect to use Azure models.");
          await refresh();
        } catch (failure) {
          setError(describeAzureFailure(failure));
        } finally {
          setBusy(false);
        }
      };

      const connect = async (): Promise<void> => {
        setBusy(true);
        setError(undefined);
        try {
          await persistSettings();
          const status = await context.bus.invoke(azureConnect, {});
          setHasKey(status.hasKey);
          setConnected(status.connected);
          setAuthMode(status.authMode);
          setMessage(
            status.connected
              ? "Azure models are available in assistant setup."
              : "Azure is not connected.",
          );
        } catch (failure) {
          setConnected(false);
          setError(describeAzureFailure(failure));
        } finally {
          setBusy(false);
        }
      };

      const removeKey = async (): Promise<void> => {
        setBusy(true);
        setError(undefined);
        try {
          try {
            await context.bus.invoke(azureDisconnect, {});
          } finally {
            await context.secrets.delete("apiKey");
          }
          setHasKey(false);
          setConnected(false);
          setKeyDraft("");
          setMessage("API key removed.");
          await refresh();
        } catch (failure) {
          setError(describeAzureFailure(failure));
        } finally {
          setBusy(false);
        }
      };

      const canConnect = (): boolean => {
        if (!endpoint().trim() || busy()) {
          return false;
        }
        return authMode() === "azure-default" || hasKey();
      };

      return (
        <Panel data-testid="azure-setup-step">
          <div class="flex items-start gap-4">
            <div class="rounded-xl bg-[var(--accent)]/10 p-2.5 text-[var(--accent)]">
              <Cloud aria-hidden="true" size={20} />
            </div>
            <div class="min-w-0 flex-1">
              <p class="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--accent)]">
                Optional
              </p>
              <h3 class="mt-2 text-xl font-semibold">Connect Azure</h3>
              <p class="mt-2 text-sm text-[var(--text-muted)]">
                Use Azure AI Foundry or Azure OpenAI. Sign in with an API key or
                Azure CLI credentials.
              </p>

              <TextField
                class="mt-5"
                label="Endpoint"
                id="azure-endpoint"
                type="url"
                autocomplete="off"
                spellcheck={false}
                value={endpoint()}
                onChange={setEndpoint}
                placeholder="https://YOUR_RESOURCE.openai.azure.com"
                data-testid="azure-endpoint"
              />

              <TextField
                class="mt-4"
                label="API version"
                id="azure-api-version"
                type="text"
                autocomplete="off"
                spellcheck={false}
                value={apiVersion()}
                onChange={setApiVersion}
                data-testid="azure-api-version"
              />

              <Select
                class="mt-4"
                label="Authentication"
                value={authMode()}
                onChange={(value) => setAuthMode(asAuthMode(value))}
                options={[
                  { value: "api-key", label: "API key" },
                  {
                    value: "azure-default",
                    label: "Azure Identity (Managed Identity / CLI)",
                  },
                ]}
                data-testid="azure-auth-mode"
              />
              <Show when={authMode() === "azure-default"}>
                <p class="mt-2 text-xs text-[var(--text-muted)]">
                  Uses Managed Identity on Azure-hosted compute, or Azure CLI or
                  Azure Developer CLI on a laptop.
                </p>
              </Show>

              <Show when={authMode() === "api-key"}>
                <TextField
                  class="mt-4"
                  label="API key"
                  id="azure-api-key"
                  type="password"
                  autocomplete="off"
                  spellcheck={false}
                  value={keyDraft()}
                  onChange={setKeyDraft}
                  placeholder={
                    hasKey()
                      ? "Key saved. Enter a new key to replace it."
                      : "Azure API key"
                  }
                  data-testid="azure-api-key"
                />
              </Show>

              <div class="mt-4 flex flex-wrap gap-2">
                <Button
                  type="button"
                  disabled={busy()}
                  onClick={() => void saveSettings()}
                  data-testid="azure-save-settings"
                >
                  {busy() ? "Saving…" : "Save settings"}
                </Button>
                <Show when={authMode() === "api-key"}>
                  <Button
                    type="button"
                    disabled={busy() || !keyDraft().trim()}
                    onClick={() => void saveKey()}
                    data-testid="azure-save-key"
                  >
                    <KeyRound aria-hidden="true" size={16} />
                    {busy() ? "Saving…" : "Save key"}
                  </Button>
                </Show>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={!canConnect()}
                  onClick={() => void connect()}
                  data-testid="azure-connect"
                >
                  {connected() ? "Reconnect" : "Verify and connect"}
                </Button>
                <Show when={authMode() === "api-key"}>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busy() || (!hasKey() && !connected())}
                    onClick={() => void removeKey()}
                    data-testid="azure-delete-key"
                  >
                    Remove key
                  </Button>
                </Show>
              </div>

              <Show when={error()}>
                {(failure) => (
                  <div
                    role="alert"
                    class="mt-4 rounded-xl border border-[var(--danger)]/40 bg-[var(--danger)]/10 px-3 py-3"
                    data-testid="azure-error"
                  >
                    <p
                      class="text-sm font-semibold text-[var(--danger)]"
                      data-testid="azure-error-headline"
                    >
                      {failure().headline}
                    </p>
                    <p
                      class="mt-1 text-sm text-[var(--text)]"
                      data-testid="azure-error-next-step"
                    >
                      {failure().nextStep}
                    </p>
                  </div>
                )}
              </Show>
              <Show when={!error()}>
                <p
                  class="mt-3 text-xs"
                  classList={{
                    "text-[var(--success)]": connected() && !busy(),
                    "text-[var(--text-muted)]": !connected() || busy(),
                  }}
                  data-testid="azure-status"
                >
                  {busy()
                    ? "Checking Azure…"
                    : connected()
                      ? "Azure is connected for this Borg session."
                      : authMode() === "api-key" && hasKey()
                        ? "A key is saved. Verify it to enable Azure models."
                        : message()}
                </p>
              </Show>
            </div>
          </div>
        </Panel>
      );
    };

    const wizard = context.ui.registerWizardStep({
      id: "borg.azure.setup",
      label: "Azure",
      order: 27,
      required: false,
      isComplete: () => true,
      component: AzureSetup,
    });
    const settings = context.ui.registerSettingsPage({
      id: "borg.azure.settings",
      label: "Azure",
      order: 27,
      component: AzureSetup,
    });
    return {
      dispose: async () => {
        await settings.dispose();
        await wizard.dispose();
      },
    };
  },
});
