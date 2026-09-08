import {
  coinbaseDisconnect,
  coinbaseGetStatus,
  coinbaseVerify,
  type CoinbaseStatus,
} from "@borg/contracts";
import { defineUiPlugin } from "@borg/plugin-sdk";
import { Button, Panel } from "@borg/ui-kit";
import { Coins, KeyRound, Save } from "lucide-solid";
import { Show, createSignal, onMount, type Component } from "solid-js";
import {
  coinbaseSettingsSchema,
  describeConfigError,
  parseCoinbaseConfig,
  parseKeyName,
} from "./config";
import { COINBASE_PRIVATE_KEY_SECRET } from "./protocol";

const IDLE_STATUS: CoinbaseStatus = {
  hasPrivateKey: false,
  hasKeyName: false,
  enabled: false,
  sandbox: false,
  connected: false,
};

export default defineUiPlugin<Component>({
  id: "borg.coinbase",
  activate(context) {
    const CoinbaseSettings: Component = () => {
      const [status, setStatus] = createSignal<CoinbaseStatus>(IDLE_STATUS);
      const [keyName, setKeyName] = createSignal("");
      const [privateKeyDraft, setPrivateKeyDraft] = createSignal("");
      const [enabled, setEnabled] = createSignal(false);
      const [sandbox, setSandbox] = createSignal(false);
      const [busy, setBusy] = createSignal(false);
      const [notice, setNotice] = createSignal(
        "Save a Coinbase CDP API key name and EC private key, then verify.",
      );
      const [error, setError] = createSignal<string>();

      const refresh = async (): Promise<void> => {
        const [config, current] = await Promise.all([
          context.config.get(),
          context.bus.invoke(coinbaseGetStatus, {}),
        ]);
        const parsed = parseCoinbaseConfig(config);
        setEnabled(parsed.enabled);
        setSandbox(parsed.sandbox);
        setKeyName(parsed.keyName);
        setStatus(current);
      };

      onMount(() => {
        void refresh().catch((failure: unknown) =>
          setError(describeConfigError(failure)),
        );
      });

      const withBusy = async (operation: () => Promise<void>): Promise<void> => {
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

      const savePrivateKey = (): Promise<void> =>
        withBusy(async () => {
          const value = privateKeyDraft().trim();
          if (value.length === 0) {
            throw new Error("Enter an EC private key to save.");
          }
          await context.secrets.set(COINBASE_PRIVATE_KEY_SECRET, value);
          setPrivateKeyDraft("");
          setNotice("Private key saved. Verify to test the connection.");
          await refresh();
        });

      const deletePrivateKey = (): Promise<void> =>
        withBusy(async () => {
          await context.bus.invoke(coinbaseDisconnect, {});
          await context.secrets.delete(COINBASE_PRIVATE_KEY_SECRET);
          setPrivateKeyDraft("");
          setNotice("Private key removed.");
          await refresh();
        });

      const saveSettings = (): Promise<void> =>
        withBusy(async () => {
          const settings = coinbaseSettingsSchema.parse({
            enabled: enabled(),
            sandbox: sandbox(),
            keyName: parseKeyName(keyName()),
          });
          await context.config.update(settings);
          setNotice("Coinbase settings saved.");
          await refresh();
        });

      const verify = (): Promise<void> =>
        withBusy(async () => {
          const next = await context.bus.invoke(coinbaseVerify, {});
          setStatus(next);
          setNotice(
            next.connected && next.error === undefined
              ? "Connected to Coinbase."
              : "Coinbase is not connected.",
          );
        });

      const disconnect = (): Promise<void> =>
        withBusy(async () => {
          const next = await context.bus.invoke(coinbaseDisconnect, {});
          setStatus(next);
          setNotice("Disconnected from Coinbase.");
        });

      return (
        <Panel data-testid="coinbase-settings-page">
          <div class="flex items-start gap-4">
            <div class="rounded-xl bg-[var(--accent)]/10 p-2.5 text-[var(--accent)]">
              <Coins aria-hidden="true" size={20} />
            </div>
            <div class="min-w-0 flex-1">
              <h3 class="text-xl font-semibold">Coinbase</h3>
              <p class="mt-2 text-sm text-[var(--text-muted)]">
                Borg talks to Coinbase Advanced Trade with a CDP API key.
                Create an ECDSA key at portal.cdp.coinbase.com. Buy, sell, and
                send require approval.
              </p>

              <label
                class="mt-5 block text-sm text-[var(--text-muted)]"
                for="coinbase-key-name"
              >
                API key name
              </label>
              <input
                id="coinbase-key-name"
                type="text"
                autocomplete="off"
                spellcheck={false}
                value={keyName()}
                onInput={(event) => setKeyName(event.currentTarget.value)}
                class="mt-2 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2 font-mono text-sm"
                placeholder="organizations/{org_id}/apiKeys/{key_id}"
                data-testid="coinbase-key-name"
              />

              <label
                class="mt-5 block text-sm text-[var(--text-muted)]"
                for="coinbase-private-key"
              >
                Private key (PEM)
              </label>
              <textarea
                id="coinbase-private-key"
                rows={5}
                autocomplete="off"
                spellcheck={false}
                value={privateKeyDraft()}
                onInput={(event) =>
                  setPrivateKeyDraft(event.currentTarget.value)
                }
                class="mt-2 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2 font-mono text-sm"
                placeholder={
                  status().hasPrivateKey
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
                  disabled={busy() || !status().hasPrivateKey}
                  onClick={() => void deletePrivateKey()}
                  data-testid="coinbase-delete-private-key"
                >
                  Remove private key
                </Button>
              </div>

              <label class="mt-6 flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={enabled()}
                  onChange={(event) => setEnabled(event.currentTarget.checked)}
                  data-testid="coinbase-enabled"
                />
                Enable Coinbase trading tools
              </label>
              <label class="mt-2 flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={sandbox()}
                  onChange={(event) => setSandbox(event.currentTarget.checked)}
                  data-testid="coinbase-sandbox"
                />
                Use the Coinbase sandbox API
              </label>

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
                    busy() || !status().hasPrivateKey || !status().hasKeyName
                  }
                  onClick={() => void verify()}
                  data-testid="coinbase-verify"
                >
                  Verify
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy() || !status().connected}
                  onClick={() => void disconnect()}
                  data-testid="coinbase-disconnect"
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
                data-testid="coinbase-status"
              >
                {error() ?? status().error ?? notice()}
              </p>
              <Show when={error()}>
                <p
                  class="mt-1 text-xs text-[var(--danger)]"
                  data-testid="coinbase-error"
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
      id: "borg.coinbase.settings",
      label: "Coinbase",
      order: 50,
      component: CoinbaseSettings,
    });
  },
});
