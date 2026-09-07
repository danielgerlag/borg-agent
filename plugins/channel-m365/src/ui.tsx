import {
  m365ChannelConnect,
  m365ChannelDisconnect,
  m365ChannelGetStatus,
  type M365ChannelStatus,
} from "@borg/contracts";
import { defineUiPlugin } from "@borg/plugin-sdk";
import { Button, Panel } from "@borg/ui-kit";
import { Mail, Save } from "lucide-solid";
import { Show, createSignal, onMount, type Component } from "solid-js";
import {
  describeM365ConfigError,
  formatRecipientList,
  m365ChannelConfigSchema,
  parseM365ChannelConfig,
  parseRecipientList,
} from "./config";
import { M365_DEFAULT_TENANT } from "./protocol";

const IDLE_STATUS: M365ChannelStatus = {
  connected: false,
  hasClientId: false,
};

export default defineUiPlugin<Component>({
  id: "borg.channel.m365",
  activate(context) {
    const M365Settings: Component = () => {
      const [status, setStatus] = createSignal<M365ChannelStatus>(IDLE_STATUS);
      const [clientId, setClientId] = createSignal("");
      const [tenant, setTenant] = createSignal(M365_DEFAULT_TENANT);
      const [enabled, setEnabled] = createSignal(false);
      const [recipientText, setRecipientText] = createSignal("");
      const [busy, setBusy] = createSignal(false);
      const [notice, setNotice] = createSignal(
        "Paste a public native client id, save, then connect.",
      );
      const [error, setError] = createSignal<string>();

      const refresh = async (): Promise<void> => {
        const [config, current] = await Promise.all([
          context.config.get(),
          context.bus.invoke(m365ChannelGetStatus, {}),
        ]);
        const parsed = parseM365ChannelConfig(config);
        setEnabled(parsed.enabled);
        setClientId(parsed.clientId);
        setTenant(parsed.tenant);
        setRecipientText(formatRecipientList(parsed.allowedRecipients));
        setStatus(current);
      };

      onMount(() => {
        void refresh().catch((failure: unknown) =>
          setError(describeM365ConfigError(failure)),
        );
      });

      const withBusy = async (operation: () => Promise<void>): Promise<void> => {
        setBusy(true);
        setError(undefined);
        try {
          await operation();
        } catch (failure) {
          setError(describeM365ConfigError(failure));
        } finally {
          setBusy(false);
        }
      };

      const saveSettings = (): Promise<void> =>
        withBusy(async () => {
          const settings = m365ChannelConfigSchema.parse({
            enabled: enabled(),
            clientId: clientId().trim(),
            tenant: tenant().trim() || M365_DEFAULT_TENANT,
            allowedRecipients: parseRecipientList(recipientText()),
          });
          await context.config.update(settings);
          setNotice("Microsoft 365 settings saved.");
          await refresh();
        });

      const connect = (): Promise<void> =>
        withBusy(async () => {
          const next = await context.bus.invoke(m365ChannelConnect, {});
          setStatus(next);
          setNotice(
            next.connected
              ? next.mailbox
                ? `Connected as ${next.mailbox}.`
                : "Connected to Microsoft 365."
              : "Connect did not complete.",
          );
        });

      const disconnect = (): Promise<void> =>
        withBusy(async () => {
          const next = await context.bus.invoke(m365ChannelDisconnect, {});
          setStatus(next);
          setNotice("Disconnected from Microsoft 365.");
        });

      return (
        <Panel data-testid="m365-settings-page">
          <div class="flex items-start gap-4">
            <div class="rounded-xl bg-[var(--accent)]/10 p-2.5 text-[var(--accent)]">
              <Mail aria-hidden="true" size={20} />
            </div>
            <div class="min-w-0 flex-1">
              <h3 class="text-xl font-semibold">Microsoft 365</h3>
              <p class="mt-2 text-sm text-[var(--text-muted)]">
                Register a public native/desktop app in Entra ID with loopback
                redirect <code>http://localhost</code> (any port). Paste the
                client id below. Borg opens the system browser to grant Mail
                read and send.
              </p>

              <label
                class="mt-5 block text-sm text-[var(--text-muted)]"
                for="m365-client-id"
              >
                Public native client id
              </label>
              <input
                id="m365-client-id"
                type="text"
                autocomplete="off"
                spellcheck={false}
                value={clientId()}
                onInput={(event) => setClientId(event.currentTarget.value)}
                class="mt-2 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm"
                placeholder="Application (client) ID"
                data-testid="m365-client-id"
              />

              <label
                class="mt-4 block text-sm text-[var(--text-muted)]"
                for="m365-tenant"
              >
                Tenant
              </label>
              <input
                id="m365-tenant"
                type="text"
                autocomplete="off"
                spellcheck={false}
                value={tenant()}
                onInput={(event) => setTenant(event.currentTarget.value)}
                class="mt-2 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm"
                placeholder={M365_DEFAULT_TENANT}
                data-testid="m365-tenant"
              />

              <label class="mt-6 flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={enabled()}
                  onChange={(event) => setEnabled(event.currentTarget.checked)}
                  data-testid="m365-enabled"
                />
                Enable the Microsoft 365 channel
              </label>

              <label
                class="mt-5 block text-sm text-[var(--text-muted)]"
                for="m365-allowed-recipients"
              >
                Allowed recipients. One email per line; the connected mailbox
                can send to itself
              </label>
              <textarea
                id="m365-allowed-recipients"
                rows={4}
                class="mt-2 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2 font-mono text-sm"
                value={recipientText()}
                onInput={(event) => setRecipientText(event.currentTarget.value)}
                data-testid="m365-allowed-recipients"
              />

              <div class="mt-4 flex flex-wrap gap-2">
                <Button
                  type="button"
                  disabled={busy()}
                  onClick={() => void saveSettings()}
                  data-testid="m365-save"
                >
                  <Save aria-hidden="true" size={16} />
                  Save
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={busy() || clientId().trim().length === 0}
                  onClick={() => void connect()}
                  data-testid="m365-connect"
                >
                  Connect
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy() || !status().connected}
                  onClick={() => void disconnect()}
                  data-testid="m365-disconnect"
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
                data-testid="m365-status"
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
                  data-testid="m365-error"
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
      id: "borg.channel.m365.settings",
      label: "Microsoft 365",
      order: 47,
      component: M365Settings,
    });
  },
});
