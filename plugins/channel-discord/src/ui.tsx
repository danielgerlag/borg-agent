import {
  CONNECTOR_ACCOUNT_NAME_MAX,
  MAX_CONNECTOR_ACCOUNTS,
  allocateConnectorAccountId,
  connectorAdapterId,
  connectorSecretKey,
  discordChannelDisconnect,
  discordChannelGetStatus,
  discordChannelVerify,
  type DiscordChannelStatus,
} from "@borg/contracts";
import { defineUiPlugin } from "@borg/plugin-sdk";
import { Button, Checkbox, Panel, TextField } from "@borg/ui-kit";
import { KeyRound, Plus, PlugZap, Save, Trash2 } from "lucide-solid";
import { For, Show, createSignal, onMount, type Component } from "solid-js";
import {
  describeConfigError,
  discordChannelSettingsSchema,
  formatSnowflakeList,
  parseDiscordChannelConfig,
  parseSnowflakeList,
  type DiscordChannelAccount,
} from "./config";
import { DISCORD_ADAPTER_ID, DISCORD_TOKEN_SECRET_KEY } from "./protocol";

export default defineUiPlugin<Component>({
  id: "borg.channel.discord",
  activate(context) {
    const DiscordSettings: Component = () => {
      const [accounts, setAccounts] = createSignal<DiscordChannelAccount[]>([]);
      const [selectedId, setSelectedId] = createSignal("");
      const [status, setStatus] = createSignal<DiscordChannelStatus>();
      const [tokenDraft, setTokenDraft] = createSignal("");
      const [accountName, setAccountName] = createSignal("");
      const [enabled, setEnabled] = createSignal(false);
      const [guildText, setGuildText] = createSignal("");
      const [channelText, setChannelText] = createSignal("");
      const [busy, setBusy] = createSignal(false);
      const [creating, setCreating] = createSignal(false);
      const [newName, setNewName] = createSignal("");
      const [notice, setNotice] = createSignal(
        "Add a Discord account, save a bot token, allow the channels Borg may read, then verify.",
      );
      const [error, setError] = createSignal<string>();

      const selected = (): DiscordChannelAccount | undefined =>
        accounts().find((account) => account.id === selectedId());

      const loadAccount = (
        account: DiscordChannelAccount,
        current?: DiscordChannelStatus,
      ): void => {
        setSelectedId(account.id);
        setAccountName(account.name);
        setEnabled(account.enabled);
        setGuildText(formatSnowflakeList(account.allowedGuildIds));
        setChannelText(formatSnowflakeList(account.allowedChannelIds));
        setTokenDraft("");
        if (current) {
          setStatus(current);
        }
      };

      const refresh = async (selectId?: string): Promise<void> => {
        const config = parseDiscordChannelConfig(await context.config.get());
        setAccounts([...config.accounts]);
        const next =
          config.accounts.find((account) => account.id === selectId) ??
          config.accounts.find((account) => account.id === selectedId()) ??
          config.accounts[0];
        if (!next) {
          setSelectedId("");
          setAccountName("");
          setEnabled(false);
          setGuildText("");
          setChannelText("");
          setStatus(undefined);
          return;
        }
        const current = await context.bus.invoke(discordChannelGetStatus, {
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
            throw new Error("Discord supports at most 8 accounts.");
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
              ignoreBots: true,
              allowedGuildIds: [],
              allowedChannelIds: [],
            },
          ];
          await context.config.update({ accounts: next });
          setNewName("");
          setCreating(false);
          setNotice(
            `Added ${name}. Save a bot token and allow channels, then verify.`,
          );
          await refresh(id);
        });

      const deleteAccount = (): Promise<void> =>
        withBusy(async () => {
          const account = selected();
          if (!account) {
            return;
          }
          await context.bus.invoke(discordChannelDisconnect, {
            accountId: account.id,
          });
          await context.secrets.delete(
            connectorSecretKey(account.id, DISCORD_TOKEN_SECRET_KEY),
          );
          const next = accounts().filter((item) => item.id !== account.id);
          await context.config.update({ accounts: next });
          setNotice(`Removed ${account.name}.`);
          await refresh(next[0]?.id);
        });

      const saveToken = (): Promise<void> =>
        withBusy(async () => {
          const account = selected();
          if (!account) {
            throw new Error("Select a Discord account first.");
          }
          const value = tokenDraft().trim();
          if (value.length === 0) {
            throw new Error("Enter a bot token to save.");
          }
          await context.secrets.set(
            connectorSecretKey(account.id, DISCORD_TOKEN_SECRET_KEY),
            value,
          );
          setTokenDraft("");
          setNotice("Bot token saved. Verify to connect.");
          await refresh(account.id);
        });

      const deleteToken = (): Promise<void> =>
        withBusy(async () => {
          const account = selected();
          if (!account) {
            return;
          }
          await context.bus.invoke(discordChannelDisconnect, {
            accountId: account.id,
          });
          await context.secrets.delete(
            connectorSecretKey(account.id, DISCORD_TOKEN_SECRET_KEY),
          );
          setTokenDraft("");
          setNotice("Bot token removed.");
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
          const settings = discordChannelSettingsSchema.parse({
            enabled: enabled(),
            ignoreBots: true,
            allowedGuildIds: parseSnowflakeList(guildText(), "Guild ids"),
            allowedChannelIds: parseSnowflakeList(channelText(), "Channel ids"),
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
          setNotice("Discord settings saved.");
          await refresh(account.id);
        });

      const verify = (): Promise<void> =>
        withBusy(async () => {
          const account = selected();
          if (!account) {
            return;
          }
          const next = await context.bus.invoke(discordChannelVerify, {
            accountId: account.id,
          });
          setStatus(next);
          setNotice(
            next.connected
              ? "Connected to the Discord gateway."
              : `Gateway is ${next.gatewayState}.`,
          );
        });

      const disconnect = (): Promise<void> =>
        withBusy(async () => {
          const account = selected();
          if (!account) {
            return;
          }
          const next = await context.bus.invoke(discordChannelDisconnect, {
            accountId: account.id,
          });
          setStatus(next);
          setNotice("Disconnected from the Discord gateway.");
        });

      return (
        <section data-testid="discord-settings-page">
          <div class="flex items-start gap-4">
            <div class="rounded-xl bg-[var(--accent)]/10 p-2.5 text-[var(--accent)]">
              <PlugZap aria-hidden="true" size={20} />
            </div>
            <div class="min-w-0 flex-1">
              <h3 class="text-xl font-semibold">Discord channel</h3>
              <p class="mt-2 text-sm text-[var(--text-muted)]">
                Each account is a separate Discord bot. Borg joins as a bot
                over the realtime gateway. In the Discord developer portal,
                enable the privileged <strong>MESSAGE CONTENT</strong> intent
                for this application. Without it Discord delivers empty message
                bodies and Borg has nothing to read. Invite the bot to the
                server and give it access to every channel listed below.
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
                  data-testid={`discord-account-row-${account.id}`}
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
              data-testid="discord-account-new"
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
              <p class="text-sm font-semibold">New Discord account</p>
              <TextField
                class="mt-3"
                value={newName()}
                onChange={setNewName}
                placeholder="Bot name"
                data-testid="discord-new-account-name"
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
                      data-testid="discord-account-id"
                    >
                      {account().id}
                    </p>
                    <p
                      class="mt-1 font-mono text-xs text-[var(--text-muted)]"
                      data-testid="discord-account-adapter-id"
                    >
                      {connectorAdapterId(DISCORD_ADAPTER_ID, account().id)}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="danger"
                    size="sm"
                    disabled={busy()}
                    data-testid="discord-account-delete"
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
                  data-testid="discord-account-name"
                />

                <TextField
                  class="mt-5"
                  label="Bot token"
                  id="discord-bot-token"
                  type="password"
                  autocomplete="off"
                  spellcheck={false}
                  value={tokenDraft()}
                  onChange={setTokenDraft}
                  placeholder={
                    status()?.hasToken
                      ? "Token saved. Enter a new token to replace it."
                      : "Bot token from the Discord developer portal"
                  }
                  data-testid="discord-bot-token"
                />
                <div class="mt-3 flex flex-wrap gap-2">
                  <Button
                    type="button"
                    disabled={busy() || tokenDraft().trim().length === 0}
                    onClick={() => void saveToken()}
                    data-testid="discord-save-token"
                  >
                    <KeyRound aria-hidden="true" size={16} />
                    Save token
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busy() || !status()?.hasToken}
                    onClick={() => void deleteToken()}
                    data-testid="discord-delete-token"
                  >
                    Remove token
                  </Button>
                </div>

                <Checkbox
                  class="mt-6"
                  checked={enabled()}
                  onChange={setEnabled}
                  label="Enable the Discord channel"
                  data-testid="discord-enabled"
                />
                <Checkbox
                  class="mt-2"
                  checked
                  disabled
                  label="Messages from bots are always ignored"
                  data-testid="discord-ignore-bots"
                />

                <TextField
                  class="mt-5"
                  label="Allowed server (guild) ids. One per line; blank allows any server"
                  id="discord-allowed-guilds"
                  rows={3}
                  inputClass="font-mono"
                  value={guildText()}
                  onChange={setGuildText}
                  data-testid="discord-allowed-guilds"
                />

                <TextField
                  class="mt-4"
                  label="Allowed channel ids. One per line; required"
                  id="discord-allowed-channels"
                  rows={4}
                  inputClass="font-mono"
                  value={channelText()}
                  onChange={setChannelText}
                  data-testid="discord-allowed-channels"
                />

                <div class="mt-4 flex flex-wrap gap-2">
                  <Button
                    type="button"
                    disabled={busy()}
                    onClick={() => void saveSettings()}
                    data-testid="discord-save-settings"
                  >
                    <Save aria-hidden="true" size={16} />
                    Save settings
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={busy() || !status()?.hasToken}
                    onClick={() => void verify()}
                    data-testid="discord-verify"
                  >
                    Verify and connect
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busy() || !status()?.connected}
                    onClick={() => void disconnect()}
                    data-testid="discord-disconnect"
                  >
                    Disconnect
                  </Button>
                </div>

                <p
                  class="mt-4 text-xs text-[var(--text-muted)]"
                  data-testid="discord-gateway-state"
                >
                  Gateway: {status()?.gatewayState ?? "idle"}
                  {status()?.botUserId ? ` · bot ${status()?.botUserId}` : ""}
                </p>
                <p
                  class="mt-1 text-xs"
                  classList={{
                    "text-[var(--success)]":
                      Boolean(status()?.connected) && !error(),
                    "text-[var(--text-muted)]":
                      !status()?.connected && !error(),
                    "text-[var(--danger)]": Boolean(error()),
                  }}
                  data-testid="discord-status"
                >
                  {error() ?? status()?.error ?? notice()}
                </p>
                <Show when={error()}>
                  <p
                    class="mt-1 text-xs text-[var(--danger)]"
                    data-testid="discord-error"
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
      id: "borg.channel.discord.settings",
      label: "Discord",
      order: 45,
      component: DiscordSettings,
    });
  },
});
