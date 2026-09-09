import {
  CONNECTOR_ACCOUNT_NAME_MAX,
  MAX_CONNECTOR_ACCOUNTS,
  allocateConnectorAccountId,
  connectorAdapterId,
  connectorSecretKey,
} from "@borg/contracts";
import { defineUiPlugin } from "@borg/plugin-sdk";
import { Button, Checkbox, Panel, TextField } from "@borg/ui-kit";
import { KeyRound, Mail, Plus, Save, Trash2 } from "lucide-solid";
import { For, Show, createSignal, onMount, type Component } from "solid-js";
import {
  describeImapConfigError,
  imapChannelSettingsSchema,
  parseImapChannelConfig,
  type ImapChannelAccount,
} from "./config";
import {
  IMAP_CHANNEL_ADAPTER_ID,
  IMAP_DEFAULT_MAILBOX,
  IMAP_PASSWORD_SECRET_KEY,
} from "./runtime";

export default defineUiPlugin<Component>({
  id: "borg.channel.imap",
  activate(context) {
    const ImapSettings: Component = () => {
      const [accounts, setAccounts] = createSignal<ImapChannelAccount[]>([]);
      const [selectedId, setSelectedId] = createSignal("");
      const [passwordDraft, setPasswordDraft] = createSignal("");
      const [hasPassword, setHasPassword] = createSignal(false);
      const [accountName, setAccountName] = createSignal("");
      const [enabled, setEnabled] = createSignal(false);
      const [host, setHost] = createSignal("");
      const [port, setPort] = createSignal("993");
      const [username, setUsername] = createSignal("");
      const [mailbox, setMailbox] = createSignal(IMAP_DEFAULT_MAILBOX);
      const [busy, setBusy] = createSignal(false);
      const [creating, setCreating] = createSignal(false);
      const [newName, setNewName] = createSignal("");
      const [notice, setNotice] = createSignal(
        "Add an IMAP account, save host, username, mailbox, and password, then enable IMAP.",
      );
      const [error, setError] = createSignal<string>();

      const selected = (): ImapChannelAccount | undefined =>
        accounts().find((account) => account.id === selectedId());

      const loadAccount = (
        account: ImapChannelAccount,
        stored: boolean,
      ): void => {
        setSelectedId(account.id);
        setAccountName(account.name);
        setEnabled(account.enabled);
        setHost(account.host);
        setPort(String(account.port));
        setUsername(account.username);
        setMailbox(account.mailbox);
        setPasswordDraft("");
        setHasPassword(stored);
      };

      const refresh = async (selectId?: string): Promise<void> => {
        const config = parseImapChannelConfig(await context.config.get());
        setAccounts([...config.accounts]);
        const next =
          config.accounts.find((account) => account.id === selectId) ??
          config.accounts.find((account) => account.id === selectedId()) ??
          config.accounts[0];
        if (!next) {
          setSelectedId("");
          setAccountName("");
          setEnabled(false);
          setHost("");
          setPort("993");
          setUsername("");
          setMailbox(IMAP_DEFAULT_MAILBOX);
          setHasPassword(false);
          return;
        }
        const stored = await context.secrets.has(
          connectorSecretKey(next.id, IMAP_PASSWORD_SECRET_KEY),
        );
        loadAccount(next, stored);
      };

      onMount(() => {
        void refresh().catch((failure: unknown) =>
          setError(describeImapConfigError(failure)),
        );
      });

      const withBusy = async (operation: () => Promise<void>): Promise<void> => {
        setBusy(true);
        setError(undefined);
        try {
          await operation();
        } catch (failure) {
          setError(describeImapConfigError(failure));
        } finally {
          setBusy(false);
        }
      };

      const syncAfterSecretWrite = async (): Promise<void> => {
        // Secret writes do not notify config.watch; an empty patch re-runs #syncNow.
        await context.config.update({});
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
            throw new Error("IMAP supports at most 8 accounts.");
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
              host: "",
              port: 993,
              username: "",
              mailbox: IMAP_DEFAULT_MAILBOX,
            },
          ];
          await context.config.update({ accounts: next });
          setNewName("");
          setCreating(false);
          setNotice(
            `Added ${name}. Save host, username, mailbox, and password, then enable IMAP.`,
          );
          await refresh(id);
        });

      const deleteAccount = (): Promise<void> =>
        withBusy(async () => {
          const account = selected();
          if (!account) {
            return;
          }
          await context.secrets.delete(
            connectorSecretKey(account.id, IMAP_PASSWORD_SECRET_KEY),
          );
          const next = accounts().filter((item) => item.id !== account.id);
          await context.config.update({ accounts: next });
          setNotice(`Removed ${account.name}.`);
          await refresh(next[0]?.id);
        });

      const savePassword = (): Promise<void> =>
        withBusy(async () => {
          const account = selected();
          if (!account) {
            throw new Error("Select an IMAP account first.");
          }
          const value = passwordDraft().trim();
          if (value.length === 0) {
            throw new Error("Enter a password to save.");
          }
          await context.secrets.set(
            connectorSecretKey(account.id, IMAP_PASSWORD_SECRET_KEY),
            value,
          );
          setPasswordDraft("");
          await syncAfterSecretWrite();
          setNotice("Password saved.");
          await refresh(account.id);
        });

      const deletePassword = (): Promise<void> =>
        withBusy(async () => {
          const account = selected();
          if (!account) {
            return;
          }
          await context.secrets.delete(
            connectorSecretKey(account.id, IMAP_PASSWORD_SECRET_KEY),
          );
          setPasswordDraft("");
          await syncAfterSecretWrite();
          setNotice("Password removed.");
          await refresh(account.id);
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
          const parsedPort = Number.parseInt(port(), 10);
          const settings = imapChannelSettingsSchema.parse({
            enabled: enabled(),
            host: host().trim(),
            port: parsedPort,
            username: username().trim(),
            mailbox: mailbox().trim() || IMAP_DEFAULT_MAILBOX,
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
          setNotice("IMAP settings saved.");
          await refresh(account.id);
        });

      return (
        <section data-testid="imap-settings-page">
          <div class="flex items-start gap-4">
            <div class="rounded-xl bg-[var(--accent)]/10 p-2.5 text-[var(--accent)]">
              <Mail aria-hidden="true" size={20} />
            </div>
            <div class="min-w-0 flex-1">
              <h3 class="text-xl font-semibold">IMAP channel</h3>
              <p class="mt-2 text-sm text-[var(--text-muted)]">
                Each account is a separate mailbox. Borg uses IMAP as a private
                destination. Save the host, username, mailbox, and password.
                The channel registers when it is enabled and those values are
                present.
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
                  data-testid={`imap-account-row-${account.id}`}
                  onClick={() => {
                    setCreating(false);
                    void refresh(account.id).catch((failure: unknown) =>
                      setError(describeImapConfigError(failure)),
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
              data-testid="imap-account-new"
              onClick={() => {
                setCreating(true);
                setError(undefined);
                setNotice("");
              }}
            >
              <Plus aria-hidden="true" size={14} />
              New account
            </Button>
          </div>

          <Show when={creating()}>
            <Panel class="mt-5">
              <p class="text-sm font-semibold">New IMAP account</p>
              <TextField
                class="mt-3"
                value={newName()}
                onChange={setNewName}
                placeholder="Mailbox name"
                data-testid="imap-new-account-name"
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
                      data-testid="imap-account-id"
                    >
                      {account().id}
                    </p>
                    <p
                      class="mt-1 font-mono text-xs text-[var(--text-muted)]"
                      data-testid="imap-account-adapter-id"
                    >
                      {connectorAdapterId(
                        IMAP_CHANNEL_ADAPTER_ID,
                        account().id,
                      )}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="danger"
                    size="sm"
                    disabled={busy()}
                    data-testid="imap-account-delete"
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
                  data-testid="imap-account-name"
                />

                <TextField
                  class="mt-5"
                  label="Password"
                  id="imap-password"
                  type="password"
                  autocomplete="off"
                  spellcheck={false}
                  value={passwordDraft()}
                  onChange={setPasswordDraft}
                  placeholder={
                    hasPassword()
                      ? "Password saved. Enter a new password to replace it."
                      : "Mailbox password"
                  }
                  data-testid="imap-password"
                />
                <div class="mt-3 flex flex-wrap gap-2">
                  <Button
                    type="button"
                    disabled={busy() || passwordDraft().trim().length === 0}
                    onClick={() => void savePassword()}
                    data-testid="imap-save-password"
                  >
                    <KeyRound aria-hidden="true" size={16} />
                    Save password
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busy() || !hasPassword()}
                    onClick={() => void deletePassword()}
                    data-testid="imap-delete-password"
                  >
                    Remove password
                  </Button>
                </div>

                <Checkbox
                  class="mt-6"
                  checked={enabled()}
                  onChange={setEnabled}
                  label="Enable the IMAP channel"
                  data-testid="imap-enabled"
                />

                <TextField
                  class="mt-5"
                  label="Host"
                  id="imap-host"
                  type="text"
                  autocomplete="off"
                  spellcheck={false}
                  value={host()}
                  onChange={setHost}
                  placeholder="imap.example.com"
                  data-testid="imap-host"
                />

                <TextField
                  class="mt-4"
                  label="Port"
                  id="imap-port"
                  type="number"
                  min="1"
                  max="65535"
                  value={port()}
                  onChange={setPort}
                  data-testid="imap-port"
                />

                <TextField
                  class="mt-4"
                  label="Username"
                  id="imap-username"
                  type="text"
                  autocomplete="off"
                  spellcheck={false}
                  value={username()}
                  onChange={setUsername}
                  placeholder="borg@example.com"
                  data-testid="imap-username"
                />

                <TextField
                  class="mt-4"
                  label="Mailbox"
                  id="imap-mailbox"
                  type="text"
                  autocomplete="off"
                  spellcheck={false}
                  value={mailbox()}
                  onChange={setMailbox}
                  placeholder={IMAP_DEFAULT_MAILBOX}
                  data-testid="imap-mailbox"
                />

                <div class="mt-4 flex flex-wrap gap-2">
                  <Button
                    type="button"
                    disabled={busy()}
                    onClick={() => void saveSettings()}
                    data-testid="imap-save-settings"
                  >
                    <Save aria-hidden="true" size={16} />
                    Save settings
                  </Button>
                </div>

                <p
                  class="mt-4 text-xs"
                  classList={{
                    "text-[var(--success)]":
                      hasPassword() && enabled() && !error(),
                    "text-[var(--text-muted)]":
                      !(hasPassword() && enabled()) && !error(),
                    "text-[var(--danger)]": Boolean(error()),
                  }}
                  data-testid="imap-status"
                >
                  {error() ?? notice()}
                </p>
              </Panel>
            )}
          </Show>
        </section>
      );
    };

    return context.ui.registerSettingsPage({
      id: "borg.channel.imap.settings",
      label: "IMAP",
      order: 46,
      component: ImapSettings,
    });
  },
});
