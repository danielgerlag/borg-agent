import {
  CONNECTOR_ACCOUNT_NAME_MAX,
  MAX_CONNECTOR_ACCOUNTS,
  allocateConnectorAccountId,
  coinbaseDisconnect,
  coinbaseGetStatus,
  coinbaseVerify,
  connectorSecretKey,
  type CoinbaseStatus,
} from "@borg/contracts";
import { defineUiPlugin } from "@borg/plugin-sdk";
import { Button, Checkbox, Panel, TextField } from "@borg/ui-kit";
import { Coins, KeyRound, Plus, Save, Trash2 } from "lucide-solid";
import { For, Show, createSignal, onMount, type Component } from "solid-js";
import {
  coinbaseSettingsSchema,
  describeConfigError,
  parseCoinbaseConfig,
  parseKeyName,
  type CoinbaseConnectorAccount,
} from "./config";
import { COINBASE_PRIVATE_KEY_SECRET } from "./protocol";

export default defineUiPlugin<Component>({
  id: "borg.coinbase",
  activate(context) {
    const CoinbaseSettings: Component = () => {
      const [accounts, setAccounts] = createSignal<CoinbaseConnectorAccount[]>(
        [],
      );
      const [selectedId, setSelectedId] = createSignal("");
      const [status, setStatus] = createSignal<CoinbaseStatus>();
      const [accountName, setAccountName] = createSignal("");
      const [keyName, setKeyName] = createSignal("");
      const [privateKeyDraft, setPrivateKeyDraft] = createSignal("");
      const [enabled, setEnabled] = createSignal(false);
      const [sandbox, setSandbox] = createSignal(false);
      const [busy, setBusy] = createSignal(false);
      const [creating, setCreating] = createSignal(false);
      const [newName, setNewName] = createSignal("");
      const [notice, setNotice] = createSignal(
        "Add a Coinbase account, save a CDP API key name and EC private key, then verify.",
      );
      const [error, setError] = createSignal<string>();

      const selected = (): CoinbaseConnectorAccount | undefined =>
        accounts().find((account) => account.id === selectedId());

      const loadAccount = (
        account: CoinbaseConnectorAccount,
        current?: CoinbaseStatus,
      ): void => {
        setSelectedId(account.id);
        setAccountName(account.name);
        setEnabled(account.enabled);
        setSandbox(account.sandbox);
        setKeyName(account.keyName);
        setPrivateKeyDraft("");
        if (current) {
          setStatus(current);
        }
      };

      const refresh = async (selectId?: string): Promise<void> => {
        const config = parseCoinbaseConfig(await context.config.get());
        setAccounts([...config.accounts]);
        const next =
          config.accounts.find((account) => account.id === selectId) ??
          config.accounts.find((account) => account.id === selectedId()) ??
          config.accounts[0];
        if (!next) {
          setSelectedId("");
          setAccountName("");
          setEnabled(false);
          setSandbox(false);
          setKeyName("");
          setStatus(undefined);
          return;
        }
        const current = await context.bus.invoke(coinbaseGetStatus, {
          accountId: next.id,
        });
        loadAccount(next, current);
      };

      onMount(() => {
        void refresh().catch((failure: unknown) =>
          setError(describeConfigError(failure)),
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
          setError(describeConfigError(failure));
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
            throw new Error("Coinbase supports at most 8 accounts.");
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
              sandbox: false,
              keyName: "",
            },
          ];
          await context.config.update({ accounts: next });
          setNewName("");
          setCreating(false);
          setNotice(
            `Added ${name}. Save a CDP API key name and private key, then verify.`,
          );
          await refresh(id);
        });

      const deleteAccount = (): Promise<void> =>
        withBusy(async () => {
          const account = selected();
          if (!account) {
            return;
          }
          await context.bus.invoke(coinbaseDisconnect, {
            accountId: account.id,
          });
          await context.secrets.delete(
            connectorSecretKey(account.id, COINBASE_PRIVATE_KEY_SECRET),
          );
          const next = accounts().filter((item) => item.id !== account.id);
          await context.config.update({ accounts: next });
          setNotice(`Removed ${account.name}.`);
          await refresh(next[0]?.id);
        });

      const savePrivateKey = (): Promise<void> =>
        withBusy(async () => {
          const account = selected();
          if (!account) {
            throw new Error("Select a Coinbase account first.");
          }
          const value = privateKeyDraft().trim();
          if (value.length === 0) {
            throw new Error("Enter an EC private key to save.");
          }
          await context.secrets.set(
            connectorSecretKey(account.id, COINBASE_PRIVATE_KEY_SECRET),
            value,
          );
          setPrivateKeyDraft("");
          setNotice("Private key saved. Verify to test the connection.");
          await refresh(account.id);
        });

      const deletePrivateKey = (): Promise<void> =>
        withBusy(async () => {
          const account = selected();
          if (!account) {
            return;
          }
          await context.bus.invoke(coinbaseDisconnect, {
            accountId: account.id,
          });
          await context.secrets.delete(
            connectorSecretKey(account.id, COINBASE_PRIVATE_KEY_SECRET),
          );
          setPrivateKeyDraft("");
          setNotice("Private key removed.");
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
          const settings = coinbaseSettingsSchema.parse({
            enabled: enabled(),
            sandbox: sandbox(),
            keyName: parseKeyName(keyName()),
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
          setNotice("Coinbase settings saved.");
          await refresh(account.id);
        });

      const verify = (): Promise<void> =>
        withBusy(async () => {
          const account = selected();
          if (!account) {
            return;
          }
          const next = await context.bus.invoke(coinbaseVerify, {
            accountId: account.id,
          });
          setStatus(next);
          setNotice(
            next.connected && next.error === undefined
              ? "Connected to Coinbase."
              : "Coinbase is not connected.",
          );
        });

      const disconnect = (): Promise<void> =>
        withBusy(async () => {
          const account = selected();
          if (!account) {
            return;
          }
          const next = await context.bus.invoke(coinbaseDisconnect, {
            accountId: account.id,
          });
          setStatus(next);
          setNotice("Disconnected from Coinbase.");
        });

      return (
        <section data-testid="coinbase-settings-page">
          <div class="flex items-start gap-4">
            <div class="rounded-xl bg-[var(--accent)]/10 p-2.5 text-[var(--accent)]">
              <Coins aria-hidden="true" size={20} />
            </div>
            <div class="min-w-0 flex-1">
              <h3 class="text-xl font-semibold">Coinbase</h3>
              <p class="mt-2 text-sm text-[var(--text-muted)]">
                Each account is a separate Coinbase CDP API key. Borg talks to
                Coinbase Advanced Trade with that key. Create an ECDSA key at
                portal.cdp.coinbase.com. Buy, sell, and send require approval.
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
                  data-testid={`coinbase-account-row-${account.id}`}
                  onClick={() => {
                    setCreating(false);
                    void refresh(account.id).catch((failure: unknown) =>
                      setError(describeConfigError(failure)),
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
              data-testid="coinbase-account-new"
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
              <p class="text-sm font-semibold">New Coinbase account</p>
              <TextField
                class="mt-3"
                value={newName()}
                onChange={setNewName}
                placeholder="Account name"
                data-testid="coinbase-new-account-name"
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
                      data-testid="coinbase-account-id"
                    >
                      {account().id}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="danger"
                    size="sm"
                    disabled={busy()}
                    data-testid="coinbase-account-delete"
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
                  data-testid="coinbase-account-name"
                />

                <TextField
                  class="mt-5"
                  label="API key name"
                  id="coinbase-key-name"
                  type="text"
                  autocomplete="off"
                  spellcheck={false}
                  inputClass="font-mono"
                  value={keyName()}
                  onChange={setKeyName}
                  placeholder="organizations/{org_id}/apiKeys/{key_id}"
                  data-testid="coinbase-key-name"
                />

                <TextField
                  class="mt-5"
                  label="Private key (PEM)"
                  id="coinbase-private-key"
                  rows={5}
                  autocomplete="off"
                  spellcheck={false}
                  inputClass="font-mono"
                  value={privateKeyDraft()}
                  onChange={setPrivateKeyDraft}
                  placeholder={
                    status()?.hasPrivateKey
                      ? "Key saved. Paste a new PEM to replace it."
                      : "-----BEGIN EC PRIVATE KEY-----"
                  }
                  data-testid="coinbase-private-key"
                />
                <div class="mt-3 flex flex-wrap gap-2">
                  <Button
                    type="button"
                    disabled={busy() || privateKeyDraft().trim().length === 0}
                    onClick={() => void savePrivateKey()}
                    data-testid="coinbase-save-private-key"
                  >
                    <KeyRound aria-hidden="true" size={16} />
                    Save private key
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busy() || !status()?.hasPrivateKey}
                    onClick={() => void deletePrivateKey()}
                    data-testid="coinbase-delete-private-key"
                  >
                    Remove private key
                  </Button>
                </div>

                <Checkbox
                  class="mt-6"
                  checked={enabled()}
                  onChange={setEnabled}
                  label="Enable Coinbase trading tools"
                  data-testid="coinbase-enabled"
                />
                <Checkbox
                  class="mt-2"
                  checked={sandbox()}
                  onChange={setSandbox}
                  label="Use the Coinbase sandbox API"
                  data-testid="coinbase-sandbox"
                />

                <div class="mt-4 flex flex-wrap gap-2">
                  <Button
                    type="button"
                    disabled={busy()}
                    onClick={() => void saveSettings()}
                    data-testid="coinbase-save-settings"
                  >
                    <Save aria-hidden="true" size={16} />
                    Save settings
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={
                      busy() ||
                      !status()?.hasPrivateKey ||
                      !status()?.hasKeyName
                    }
                    onClick={() => void verify()}
                    data-testid="coinbase-verify"
                  >
                    Verify
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busy() || !status()?.connected}
                    onClick={() => void disconnect()}
                    data-testid="coinbase-disconnect"
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
                  data-testid="coinbase-status"
                >
                  {error() ?? status()?.error ?? notice()}
                </p>
                <Show when={error()}>
                  <p
                    class="mt-1 text-xs text-[var(--danger)]"
                    data-testid="coinbase-error"
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
      id: "borg.coinbase.settings",
      label: "Coinbase",
      order: 50,
      component: CoinbaseSettings,
    });
  },
});
