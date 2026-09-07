import {
  googleChannelConnect,
  googleChannelDisconnect,
  googleChannelGetStatus,
  type GoogleChannelStatus,
} from "@borg/contracts";
import { defineUiPlugin } from "@borg/plugin-sdk";
import { Button, Panel } from "@borg/ui-kit";
import { Mail, Save } from "lucide-solid";
import { Show, createSignal, onMount, type Component } from "solid-js";
import {
  describeGoogleConfigError,
  formatRecipientList,
  googleChannelConfigSchema,
  parseGoogleChannelConfig,
  parseRecipientList,
} from "./config";

const IDLE_STATUS: GoogleChannelStatus = {
  connected: false,
  hasClientId: false,
};

export default defineUiPlugin<Component>({
  id: "borg.channel.google",
  activate(context) {
    const GoogleSettings: Component = () => {
      const [status, setStatus] = createSignal<GoogleChannelStatus>(IDLE_STATUS);
      const [clientId, setClientId] = createSignal("");
      const [enabled, setEnabled] = createSignal(false);
      const [recipientText, setRecipientText] = createSignal("");
      const [busy, setBusy] = createSignal(false);
      const [notice, setNotice] = createSignal(
        "Paste a public desktop client id, save, then connect.",
      );
      const [error, setError] = createSignal<string>();

      const refresh = async (): Promise<void> => {
        const [config, current] = await Promise.all([
          context.config.get(),
          context.bus.invoke(googleChannelGetStatus, {}),
        ]);
        const parsed = parseGoogleChannelConfig(config);
        setEnabled(parsed.enabled);
        setClientId(parsed.clientId);
        setRecipientText(formatRecipientList(parsed.allowedRecipients));
        setStatus(current);
      };

      onMount(() => {
        void refresh().catch((failure: unknown) =>
          setError(describeGoogleConfigError(failure)),
        );
      });

      const withBusy = async (operation: () => Promise<void>): Promise<void> => {
        setBusy(true);
        setError(undefined);
        try {
          await operation();
        } catch (failure) {
          setError(describeGoogleConfigError(failure));
        } finally {
          setBusy(false);
        }
      };

      const saveSettings = (): Promise<void> =>
        withBusy(async () => {
          const settings = googleChannelConfigSchema.parse({
            enabled: enabled(),
            clientId: clientId().trim(),
            allowedRecipients: parseRecipientList(recipientText()),
          });
          await context.config.update(settings);
          setNotice("Google settings saved.");
          await refresh();
        });

      const connect = (): Promise<void> =>
        withBusy(async () => {
          const next = await context.bus.invoke(googleChannelConnect, {});
          setStatus(next);
          setNotice(
            next.connected
              ? next.mailbox
                ? `Connected as ${next.mailbox}.`
                : "Connected to Google."
              : "Connect did not complete.",
          );
        });

      const disconnect = (): Promise<void> =>
        withBusy(async () => {
          const next = await context.bus.invoke(googleChannelDisconnect, {});
          setStatus(next);
          setNotice("Disconnected from Google.");
        });

      return (
        <Panel data-testid="google-settings-page">
          <div class="flex items-start gap-4">
            <div class="rounded-xl bg-[var(--accent)]/10 p-2.5 text-[var(--accent)]">
              <Mail aria-hidden="true" size={20} />
            </div>
            <div class="min-w-0 flex-1">
              <h3 class="text-xl font-semibold">Google</h3>
              <p class="mt-2 text-sm text-[var(--text-muted)]">
                Register a public native/desktop app in Google Cloud with
                loopback redirect <code>http://127.0.0.1</code> (any port).
                Paste the client id below. Borg opens the system browser to
                grant Gmail read and send.
              </p>

              <label
                class="mt-5 block text-sm text-[var(--text-muted)]"
                for="google-client-id"
              >
                Public desktop client id
              </label>
              <input
                id="google-client-id"
                type="text"
                autocomplete="off"
                spellcheck={false}
                value={clientId()}
                onInput={(event) => setClientId(event.currentTarget.value)}
                class="mt-2 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm"
                placeholder="OAuth client ID"
                data-testid="google-client-id"
              />

              <label class="mt-6 flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={enabled()}
                  onChange={(event) => setEnabled(event.currentTarget.checked)}
                  data-testid="google-enabled"
                />
                Enable the Google channel
              </label>

              <label
                class="mt-5 block text-sm text-[var(--text-muted)]"
                for="google-allowed-recipients"
              >
                Allowed recipients. One email per line; the connected mailbox
                can send to itself
              </label>
              <textarea
                id="google-allowed-recipients"
                rows={4}
                class="mt-2 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2 font-mono text-sm"
                value={recipientText()}
                onInput={(event) => setRecipientText(event.currentTarget.value)}
                data-testid="google-allowed-recipients"
              />

              <div class="mt-4 flex flex-wrap gap-2">
                <Button
                  type="button"
                  disabled={busy()}
                  onClick={() => void saveSettings()}
                  data-testid="google-save"
                >
                  <Save aria-hidden="true" size={16} />
                  Save
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={busy() || clientId().trim().length === 0}
                  onClick={() => void connect()}
                  data-testid="google-connect"
                >
                  Connect
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy() || !status().connected}
                  onClick={() => void disconnect()}
                  data-testid="google-disconnect"
                >
                  Disconnect
                </Button>
              </div>

              <p
                class="mt-4 text-xs"
                classList={{
                  "text-[var(--success)]": status().connected && !error(),
                  "text-[var(--text-muted)]": !status().connected && !error(),
                  "text-[var(--danger)]": Boolean(error()),
                }}
                data-testid="google-status"
              >
                {error() ??
                  status().error ??
                  (status().mailbox
                    ? `Mailbox: ${status().mailbox}`
                    : notice())}
              </p>
              <Show when={error()}>
                <p
                  class="mt-1 text-xs text-[var(--danger)]"
                  data-testid="google-error"
                >
                  {error()}
                </p>
              </Show>
            </div>
          </div>
        </Panel>
      );
    };

    return context.ui.registerSettingsPage({
      id: "borg.channel.google.settings",
      label: "Google",
      order: 48,
      component: GoogleSettings,
    });
  },
});
