import {
  CONNECTOR_ACCOUNT_NAME_MAX,
  MAX_CONNECTOR_ACCOUNTS,
  allocateConnectorAccountId,
  connectorAdapterId,
  googleChannelConnect,
  googleChannelDisconnect,
  googleChannelGetStatus,
  type GoogleChannelStatus,
} from "@borg/contracts";
import { defineUiPlugin } from "@borg/plugin-sdk";
import { Button, Panel } from "@borg/ui-kit";
import { Mail, Plus, Save, Trash2 } from "lucide-solid";
import { For, Show, createSignal, onMount, type Component } from "solid-js";
import {
  describeGoogleConfigError,
  formatRecipientList,
  googleChannelSettingsSchema,
  parseGoogleChannelConfig,
  parseRecipientList,
  type GoogleChannelAccount,
} from "./config";
import { GOOGLE_ADAPTER_ID } from "./protocol";

export default defineUiPlugin<Component>({
  id: "borg.channel.google",
  activate(context) {
    const GoogleSettings: Component = () => {
      const [accounts, setAccounts] = createSignal<GoogleChannelAccount[]>([]);
      const [selectedId, setSelectedId] = createSignal("");
      const [status, setStatus] = createSignal<GoogleChannelStatus>();
      const [accountName, setAccountName] = createSignal("");
      const [clientId, setClientId] = createSignal("");
      const [enabled, setEnabled] = createSignal(false);
      const [recipientText, setRecipientText] = createSignal("");
      const [busy, setBusy] = createSignal(false);
      const [creating, setCreating] = createSignal(false);
      const [newName, setNewName] = createSignal("");
      const [notice, setNotice] = createSignal(
        "Add a Google account, paste a public desktop client id, save, then connect.",
      );
      const [error, setError] = createSignal<string>();

      const selected = (): GoogleChannelAccount | undefined =>
        accounts().find((account) => account.id === selectedId());

      const loadAccount = (
        account: GoogleChannelAccount,
        current?: GoogleChannelStatus,
      ): void => {
        setSelectedId(account.id);
        setAccountName(account.name);
        setEnabled(account.enabled);
        setClientId(account.clientId);
        setRecipientText(formatRecipientList(account.allowedRecipients));
        if (current) {
          setStatus(current);
        }
      };

      const refresh = async (selectId?: string): Promise<void> => {
        const config = parseGoogleChannelConfig(await context.config.get());
        setAccounts([...config.accounts]);
        const next =
          config.accounts.find((account) => account.id === selectId) ??
          config.accounts.find((account) => account.id === selectedId()) ??
          config.accounts[0];
        if (!next) {
          setSelectedId("");
          setAccountName("");
          setEnabled(false);
          setClientId("");
          setRecipientText("");
          setStatus(undefined);
          return;
        }
        const current = await context.bus.invoke(googleChannelGetStatus, {
          accountId: next.id,
        });
        loadAccount(next, current);
      };

      onMount(() => {
        void refresh().catch((failure: unknown) =>
          setError(describeGoogleConfigError(failure)),
        );
      });

      const withBusy = async (
        operation: () => Promise<void>,
      ): Promise<void> => {
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

      const createAccount = (): Promise<void> =>
        withBusy(async () => {
          const name = newName().trim();
          if (name.length === 0) {
            throw new Error("Account name is required.");
          }
          if (name.length > CONNECTOR_ACCOUNT_NAME_MAX) {
            throw new Error(
              `Account name must be at most ${CONNECTOR_ACCOUNT_NAME_MAX} characters.`,
            );
          }
          if (accounts().length >= MAX_CONNECTOR_ACCOUNTS) {
            throw new Error("Google supports at most 8 accounts.");
          }
          const id = allocateConnectorAccountId(
            name,
            accounts().map((account) => account.id),
          );
          const next = [
            ...accounts(),
            {
              id,
              name,
              enabled: false,
              clientId: "",
              allowedRecipients: [],
              mailbox: "",
            },
          ];
          await context.config.update({ accounts: next });
          setNewName("");
          setCreating(false);
          setNotice(`Added ${name}. Save a client id, then connect.`);
          await refresh(id);
        });

      const deleteAccount = (): Promise<void> =>
        withBusy(async () => {
          const account = selected();
          if (!account) {
            return;
          }
          await context.bus.invoke(googleChannelDisconnect, {
            accountId: account.id,
          });
          const next = accounts().filter((item) => item.id !== account.id);
          await context.config.update({ accounts: next });
          setNotice(`Removed ${account.name}.`);
          await refresh(next[0]?.id);
        });

      const saveSettings = (): Promise<void> =>
        withBusy(async () => {
          const account = selected();
          if (!account) {
            return;
          }
          const name = accountName().trim();
          if (name.length === 0) {
            throw new Error("Account name is required.");
          }
          const settings = googleChannelSettingsSchema.parse({
            enabled: enabled(),
            clientId: clientId().trim(),
            allowedRecipients: parseRecipientList(recipientText()),
          });
          const next = accounts().map((item) =>
            item.id === account.id
              ? {
                  ...item,
                  name,
                  ...settings,
                }
              : item,
          );
          await context.config.update({ accounts: next });
          setNotice("Google settings saved.");
          await refresh(account.id);
        });

      const connect = (): Promise<void> =>
        withBusy(async () => {
          const account = selected();
          if (!account) {
            return;
          }
          const next = await context.bus.invoke(googleChannelConnect, {
            accountId: account.id,
          });
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
          const account = selected();
          if (!account) {
            return;
          }
          const next = await context.bus.invoke(googleChannelDisconnect, {
            accountId: account.id,
          });
          setStatus(next);
          setNotice("Disconnected from Google.");
        });

      return (
        <section data-testid="google-settings-page">
          <div class="flex items-start gap-4">
            <div class="rounded-xl bg-[var(--accent)]/10 p-2.5 text-[var(--accent)]">
              <Mail aria-hidden="true" size={20} />
            </div>
            <div class="min-w-0 flex-1">
              <h3 class="text-xl font-semibold">Google</h3>
              <p class="mt-2 text-sm text-[var(--text-muted)]">
                Each account is a separate Google mailbox. Register a public
                native/desktop app in Google Cloud with loopback redirect{" "}
                <code>http://127.0.0.1</code> (any port). Paste the client id
                below. Borg opens the system browser to grant Gmail, calendar,
                Drive, and contacts. If you already connected, disconnect first
                so Google can show the new consent screen.
              </p>
            </div>
          </div>

          <div class="mt-5 flex flex-wrap gap-2">
            <For each={accounts()}>
              {(account) => (
                <button
                  type="button"
                  class="rounded-xl border px-3 py-2 text-left text-sm"
                  classList={{
                    "border-[var(--accent)] bg-[var(--accent)]/12 text-[var(--accent)]":
                      account.id === selectedId(),
                    "border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]":
                      account.id !== selectedId(),
                  }}
                  aria-current={account.id === selectedId() ? "true" : undefined}
                  data-testid={`google-account-row-${account.id}`}
                  onClick={() => {
                    setCreating(false);
                    void refresh(account.id).catch((failure: unknown) =>
                      setError(describeGoogleConfigError(failure)),
                    );
                  }}
                >
                  <span class="font-medium">{account.name}</span>
                </button>
              )}
            </For>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={busy() || accounts().length >= MAX_CONNECTOR_ACCOUNTS}
              data-testid="google-account-new"
              onClick={() => {
                setCreating(true);
                setError(undefined);
                setStatus(undefined);
                setNotice("");
              }}
            >
              <Plus aria-hidden="true" size={14} />
              New account
            </Button>
          </div>

          <Show when={creating()}>
            <Panel class="mt-5">
              <p class="text-sm font-semibold">New Google account</p>
              <input
                value={newName()}
                onInput={(event) => setNewName(event.currentTarget.value)}
                class="mt-3 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm"
                placeholder="Mailbox name"
                data-testid="google-new-account-name"
              />
              <div class="mt-3 flex gap-2">
                <Button
                  type="button"
                  disabled={busy() || newName().trim().length === 0}
                  onClick={() => void createAccount()}
                >
                  Add account
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy()}
                  onClick={() => setCreating(false)}
                >
                  Cancel
                </Button>
              </div>
            </Panel>
          </Show>

          <Show when={!creating() && selected()}>
            {(account) => (
              <Panel class="mt-5">
                <div class="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p
                      class="font-mono text-xs text-[var(--text-muted)]"
                      data-testid="google-account-id"
                    >
                      {account().id}
                    </p>
                    <p
                      class="mt-1 font-mono text-xs text-[var(--text-muted)]"
                      data-testid="google-account-adapter-id"
                    >
                      {connectorAdapterId(GOOGLE_ADAPTER_ID, account().id)}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="danger"
                    size="sm"
                    disabled={busy()}
                    data-testid="google-account-delete"
                    onClick={() => void deleteAccount()}
                  >
                    <Trash2 aria-hidden="true" size={14} />
                    Delete account
                  </Button>
                </div>

                <label class="mt-4 block text-sm text-[var(--text-muted)]">
                  Name
                  <input
                    value={accountName()}
                    onInput={(event) =>
                      setAccountName(event.currentTarget.value)
                    }
                    class="mt-2 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--text)]"
                    data-testid="google-account-name"
                  />
                </label>

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
                    onChange={(event) =>
                      setEnabled(event.currentTarget.checked)
                    }
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
                  onInput={(event) =>
                    setRecipientText(event.currentTarget.value)
                  }
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
                    disabled={busy() || !status()?.connected}
                    onClick={() => void disconnect()}
                    data-testid="google-disconnect"
                  >
                    Disconnect
                  </Button>
                </div>

                <p
                  class="mt-4 text-xs"
                  classList={{
                    "text-[var(--success)]":
                      Boolean(status()?.connected) && !error(),
                    "text-[var(--text-muted)]":
                      !status()?.connected && !error(),
                    "text-[var(--danger)]": Boolean(error()),
                  }}
                  data-testid="google-status"
                >
                  {error() ??
                    status()?.error ??
                    (status()?.mailbox
                      ? `Mailbox: ${status()?.mailbox}`
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
              </Panel>
            )}
          </Show>
        </section>
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
