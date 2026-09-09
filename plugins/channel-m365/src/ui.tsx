import {
  CONNECTOR_ACCOUNT_NAME_MAX,
  MAX_CONNECTOR_ACCOUNTS,
  allocateConnectorAccountId,
  connectorAdapterId,
  m365ChannelConnect,
  m365ChannelDisconnect,
  m365ChannelGetStatus,
  type M365ChannelStatus,
} from "@borg/contracts";
import { defineUiPlugin } from "@borg/plugin-sdk";
import { Button, Checkbox, Panel, TextField } from "@borg/ui-kit";
import { Mail, Plus, Save, Trash2 } from "lucide-solid";
import { For, Show, createSignal, onMount, type Component } from "solid-js";
import {
  describeM365ConfigError,
  formatRecipientList,
  m365ChannelSettingsSchema,
  parseM365ChannelConfig,
  parseRecipientList,
  type M365ChannelAccount,
} from "./config";
import { M365_ADAPTER_ID, M365_DEFAULT_TENANT } from "./protocol";

export default defineUiPlugin<Component>({
  id: "borg.channel.m365",
  activate(context) {
    const M365Settings: Component = () => {
      const [accounts, setAccounts] = createSignal<M365ChannelAccount[]>([]);
      const [selectedId, setSelectedId] = createSignal("");
      const [status, setStatus] = createSignal<M365ChannelStatus>();
      const [accountName, setAccountName] = createSignal("");
      const [clientId, setClientId] = createSignal("");
      const [tenant, setTenant] = createSignal(M365_DEFAULT_TENANT);
      const [enabled, setEnabled] = createSignal(false);
      const [recipientText, setRecipientText] = createSignal("");
      const [busy, setBusy] = createSignal(false);
      const [creating, setCreating] = createSignal(false);
      const [newName, setNewName] = createSignal("");
      const [notice, setNotice] = createSignal(
        "Add a Microsoft 365 account, paste a public native client id, save, then connect.",
      );
      const [error, setError] = createSignal<string>();

      const selected = (): M365ChannelAccount | undefined =>
        accounts().find((account) => account.id === selectedId());

      const loadAccount = (
        account: M365ChannelAccount,
        current?: M365ChannelStatus,
      ): void => {
        setSelectedId(account.id);
        setAccountName(account.name);
        setEnabled(account.enabled);
        setClientId(account.clientId);
        setTenant(account.tenant);
        setRecipientText(formatRecipientList(account.allowedRecipients));
        if (current) {
          setStatus(current);
        }
      };

      const refresh = async (selectId?: string): Promise<void> => {
        const config = parseM365ChannelConfig(await context.config.get());
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
          setTenant(M365_DEFAULT_TENANT);
          setRecipientText("");
          setStatus(undefined);
          return;
        }
        const current = await context.bus.invoke(m365ChannelGetStatus, {
          accountId: next.id,
        });
        loadAccount(next, current);
      };

      onMount(() => {
        void refresh().catch((failure: unknown) =>
          setError(describeM365ConfigError(failure)),
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
          setError(describeM365ConfigError(failure));
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
            throw new Error("Microsoft 365 supports at most 8 accounts.");
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
              tenant: M365_DEFAULT_TENANT,
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
          await context.bus.invoke(m365ChannelDisconnect, {
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
          const settings = m365ChannelSettingsSchema.parse({
            enabled: enabled(),
            clientId: clientId().trim(),
            tenant: tenant().trim() || M365_DEFAULT_TENANT,
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
          setNotice("Microsoft 365 settings saved.");
          await refresh(account.id);
        });

      const connect = (): Promise<void> =>
        withBusy(async () => {
          const account = selected();
          if (!account) {
            return;
          }
          const next = await context.bus.invoke(m365ChannelConnect, {
            accountId: account.id,
          });
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
          const account = selected();
          if (!account) {
            return;
          }
          const next = await context.bus.invoke(m365ChannelDisconnect, {
            accountId: account.id,
          });
          setStatus(next);
          setNotice("Disconnected from Microsoft 365.");
        });

      return (
        <section data-testid="m365-settings-page">
          <div class="flex items-start gap-4">
            <div class="rounded-xl bg-[var(--accent)]/10 p-2.5 text-[var(--accent)]">
              <Mail aria-hidden="true" size={20} />
            </div>
            <div class="min-w-0 flex-1">
              <h3 class="text-xl font-semibold">Microsoft 365</h3>
              <p class="mt-2 text-sm text-[var(--text-muted)]">
                Each account is a separate Microsoft 365 mailbox. Register a
                public native/desktop app in Entra ID with loopback redirect{" "}
                <code>http://localhost</code> (any port). Paste the client id
                below. Borg opens the system browser to grant mail, calendar,
                Drive, and contacts. If you already connected, disconnect first
                so Microsoft can show the new consent screen.
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
                  data-testid={`m365-account-row-${account.id}`}
                  onClick={() => {
                    setCreating(false);
                    void refresh(account.id).catch((failure: unknown) =>
                      setError(describeM365ConfigError(failure)),
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
              data-testid="m365-account-new"
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
              <p class="text-sm font-semibold">New Microsoft 365 account</p>
              <TextField
                class="mt-3"
                value={newName()}
                onChange={setNewName}
                placeholder="Mailbox name"
                data-testid="m365-new-account-name"
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
                      data-testid="m365-account-id"
                    >
                      {account().id}
                    </p>
                    <p
                      class="mt-1 font-mono text-xs text-[var(--text-muted)]"
                      data-testid="m365-account-adapter-id"
                    >
                      {connectorAdapterId(M365_ADAPTER_ID, account().id)}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="danger"
                    size="sm"
                    disabled={busy()}
                    data-testid="m365-account-delete"
                    onClick={() => void deleteAccount()}
                  >
                    <Trash2 aria-hidden="true" size={14} />
                    Delete account
                  </Button>
                </div>

                <TextField
                  class="mt-4"
                  label="Name"
                  value={accountName()}
                  onChange={setAccountName}
                  data-testid="m365-account-name"
                />

                <TextField
                  class="mt-5"
                  label="Public native client id"
                  id="m365-client-id"
                  type="text"
                  autocomplete="off"
                  spellcheck={false}
                  value={clientId()}
                  onChange={setClientId}
                  placeholder="Application (client) ID"
                  data-testid="m365-client-id"
                />

                <TextField
                  class="mt-4"
                  label="Tenant"
                  id="m365-tenant"
                  type="text"
                  autocomplete="off"
                  spellcheck={false}
                  value={tenant()}
                  onChange={setTenant}
                  placeholder={M365_DEFAULT_TENANT}
                  data-testid="m365-tenant"
                />

                <Checkbox
                  class="mt-6"
                  checked={enabled()}
                  onChange={setEnabled}
                  label="Enable the Microsoft 365 channel"
                  data-testid="m365-enabled"
                />

                <TextField
                  class="mt-5"
                  label="Allowed recipients. One email per line; the connected mailbox can send to itself"
                  id="m365-allowed-recipients"
                  rows={4}
                  inputClass="font-mono"
                  value={recipientText()}
                  onChange={setRecipientText}
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
                    disabled={busy() || !status()?.connected}
                    onClick={() => void disconnect()}
                    data-testid="m365-disconnect"
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
                  data-testid="m365-status"
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
                    data-testid="m365-error"
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
      id: "borg.channel.m365.settings",
      label: "Microsoft 365",
      order: 47,
      component: M365Settings,
    });
  },
});
