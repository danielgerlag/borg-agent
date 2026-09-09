import {
  CONNECTOR_ACCOUNT_NAME_MAX,
  MAX_CONNECTOR_ACCOUNTS,
  allocateConnectorAccountId,
  connectorAdapterId,
  connectorSecretKey,
  slackChannelDisconnect,
  slackChannelGetStatus,
  slackChannelVerify,
  type SlackChannelStatus,
} from "@borg/contracts";
import { defineUiPlugin } from "@borg/plugin-sdk";
import { Button, Panel } from "@borg/ui-kit";
import { KeyRound, Plus, PlugZap, Save, Trash2 } from "lucide-solid";
import { For, Show, createSignal, onMount, type Component } from "solid-js";
import {
  describeConfigError,
  formatChannelList,
  parseChannelList,
  parseOptionalChannelId,
  parseSlackChannelConfig,
  slackChannelSettingsSchema,
  type SlackChannelAccount,
} from "./config";
import {
  SLACK_ADAPTER_ID,
  SLACK_APP_TOKEN_SECRET_KEY,
  SLACK_BOT_TOKEN_SECRET_KEY,
} from "./protocol";

export default defineUiPlugin<Component>({
  id: "borg.channel.slack",
  activate(context) {
    const SlackSettings: Component = () => {
      const [accounts, setAccounts] = createSignal<SlackChannelAccount[]>([]);
      const [selectedId, setSelectedId] = createSignal("");
      const [status, setStatus] = createSignal<SlackChannelStatus>();
      const [botTokenDraft, setBotTokenDraft] = createSignal("");
      const [appTokenDraft, setAppTokenDraft] = createSignal("");
      const [accountName, setAccountName] = createSignal("");
      const [enabled, setEnabled] = createSignal(false);
      const [channelText, setChannelText] = createSignal("");
      const [defaultSendText, setDefaultSendText] = createSignal("");
      const [busy, setBusy] = createSignal(false);
      const [creating, setCreating] = createSignal(false);
      const [newName, setNewName] = createSignal("");
      const [notice, setNotice] = createSignal(
        "Add a Slack workspace, save a bot token and app-level token, allow the channels Borg may read, then verify.",
      );
      const [error, setError] = createSignal<string>();

      const selected = (): SlackChannelAccount | undefined =>
        accounts().find((account) => account.id === selectedId());

      const loadAccount = (
        account: SlackChannelAccount,
        current?: SlackChannelStatus,
      ): void => {
        setSelectedId(account.id);
        setAccountName(account.name);
        setEnabled(account.enabled);
        setChannelText(formatChannelList(account.allowedChannelIds));
        setDefaultSendText(account.defaultSendChannelId);
        setBotTokenDraft("");
        setAppTokenDraft("");
        if (current) {
          setStatus(current);
        }
      };

      const refresh = async (selectId?: string): Promise<void> => {
        const config = parseSlackChannelConfig(await context.config.get());
        setAccounts([...config.accounts]);
        const next =
          config.accounts.find((account) => account.id === selectId) ??
          config.accounts.find((account) => account.id === selectedId()) ??
          config.accounts[0];
        if (!next) {
          setSelectedId("");
          setAccountName("");
          setEnabled(false);
          setChannelText("");
          setDefaultSendText("");
          setStatus(undefined);
          return;
        }
        const current = await context.bus.invoke(slackChannelGetStatus, {
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
            throw new Error("Slack supports at most 8 accounts.");
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
              allowedChannelIds: [],
              defaultSendChannelId: "",
            },
          ];
          await context.config.update({ accounts: next });
          setNewName("");
          setCreating(false);
          setNotice(`Added ${name}. Save tokens and allow channels, then verify.`);
          await refresh(id);
        });

      const deleteAccount = (): Promise<void> =>
        withBusy(async () => {
          const account = selected();
          if (!account) {
            return;
          }
          await context.bus.invoke(slackChannelDisconnect, {
            accountId: account.id,
          });
          await context.secrets.delete(
            connectorSecretKey(account.id, SLACK_BOT_TOKEN_SECRET_KEY),
          );
          await context.secrets.delete(
            connectorSecretKey(account.id, SLACK_APP_TOKEN_SECRET_KEY),
          );
          const next = accounts().filter((item) => item.id !== account.id);
          await context.config.update({ accounts: next });
          setNotice(`Removed ${account.name}.`);
          await refresh(next[0]?.id);
        });

      const saveBotToken = (): Promise<void> =>
        withBusy(async () => {
          const account = selected();
          if (!account) {
            throw new Error("Select a Slack account first.");
          }
          const value = botTokenDraft().trim();
          if (value.length === 0) {
            throw new Error("Enter a bot token to save.");
          }
          await context.secrets.set(
            connectorSecretKey(account.id, SLACK_BOT_TOKEN_SECRET_KEY),
            value,
          );
          setBotTokenDraft("");
          setNotice("Bot token saved. Verify to connect.");
          await refresh(account.id);
        });

      const deleteBotToken = (): Promise<void> =>
        withBusy(async () => {
          const account = selected();
          if (!account) {
            return;
          }
          await context.bus.invoke(slackChannelDisconnect, {
            accountId: account.id,
          });
          await context.secrets.delete(
            connectorSecretKey(account.id, SLACK_BOT_TOKEN_SECRET_KEY),
          );
          setBotTokenDraft("");
          setNotice("Bot token removed.");
          await refresh(account.id);
        });

      const saveAppToken = (): Promise<void> =>
        withBusy(async () => {
          const account = selected();
          if (!account) {
            throw new Error("Select a Slack account first.");
          }
          const value = appTokenDraft().trim();
          if (value.length === 0) {
            throw new Error("Enter an app-level token to save.");
          }
          await context.secrets.set(
            connectorSecretKey(account.id, SLACK_APP_TOKEN_SECRET_KEY),
            value,
          );
          setAppTokenDraft("");
          setNotice("App-level token saved. Verify to connect.");
          await refresh(account.id);
        });

      const deleteAppToken = (): Promise<void> =>
        withBusy(async () => {
          const account = selected();
          if (!account) {
            return;
          }
          await context.bus.invoke(slackChannelDisconnect, {
            accountId: account.id,
          });
          await context.secrets.delete(
            connectorSecretKey(account.id, SLACK_APP_TOKEN_SECRET_KEY),
          );
          setAppTokenDraft("");
          setNotice("App-level token removed.");
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
          const settings = slackChannelSettingsSchema.parse({
            enabled: enabled(),
            ignoreBots: true,
            allowedChannelIds: parseChannelList(
              channelText(),
              "Channel ids",
            ),
            defaultSendChannelId: parseOptionalChannelId(
              defaultSendText(),
              "Default send channel",
            ),
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
          setNotice("Slack settings saved.");
          await refresh(account.id);
        });

      const verify = (): Promise<void> =>
        withBusy(async () => {
          const account = selected();
          if (!account) {
            return;
          }
          const next = await context.bus.invoke(slackChannelVerify, {
            accountId: account.id,
          });
          setStatus(next);
          setNotice(
            next.connected
              ? "Connected to Slack Socket Mode."
              : `Socket is ${next.socketState}.`,
          );
        });

      const disconnect = (): Promise<void> =>
        withBusy(async () => {
          const account = selected();
          if (!account) {
            return;
          }
          const next = await context.bus.invoke(slackChannelDisconnect, {
            accountId: account.id,
          });
          setStatus(next);
          setNotice("Disconnected from Slack Socket Mode.");
        });

      return (
        <section data-testid="slack-settings-page">
          <div class="flex items-start gap-4">
            <div class="rounded-xl bg-[var(--accent)]/10 p-2.5 text-[var(--accent)]">
              <PlugZap aria-hidden="true" size={20} />
            </div>
            <div class="min-w-0 flex-1">
              <h3 class="text-xl font-semibold">Slack channel</h3>
              <p class="mt-2 text-sm text-[var(--text-muted)]">
                Each account is a separate Slack workspace. Borg joins as a bot
                over Socket Mode. Enable Socket Mode, subscribe to message
                events, and install the app, then save tokens and allow every
                channel listed below.
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
                  data-testid={`slack-account-row-${account.id}`}
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
              data-testid="slack-account-new"
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
              <p class="text-sm font-semibold">New Slack account</p>
              <input
                value={newName()}
                onInput={(event) => setNewName(event.currentTarget.value)}
                class="mt-3 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm"
                placeholder="Workspace name"
                data-testid="slack-new-account-name"
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
                      data-testid="slack-account-id"
                    >
                      {account().id}
                    </p>
                    <p
                      class="mt-1 font-mono text-xs text-[var(--text-muted)]"
                      data-testid="slack-account-adapter-id"
                    >
                      {connectorAdapterId(SLACK_ADAPTER_ID, account().id)}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="danger"
                    size="sm"
                    disabled={busy()}
                    data-testid="slack-account-delete"
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
                    data-testid="slack-account-name"
                  />
                </label>

                <label
                  class="mt-5 block text-sm text-[var(--text-muted)]"
                  for="slack-bot-token"
                >
                  Bot token
                </label>
                <input
                  id="slack-bot-token"
                  type="password"
                  autocomplete="off"
                  spellcheck={false}
                  value={botTokenDraft()}
                  onInput={(event) =>
                    setBotTokenDraft(event.currentTarget.value)
                  }
                  class="mt-2 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm"
                  placeholder={
                    status()?.hasBotToken
                      ? "Token saved. Enter a new token to replace it."
                      : "Bot token (xoxb-) from the Slack app"
                  }
                  data-testid="slack-bot-token"
                />
                <div class="mt-3 flex flex-wrap gap-2">
                  <Button
                    type="button"
                    disabled={busy() || botTokenDraft().trim().length === 0}
                    onClick={() => void saveBotToken()}
                    data-testid="slack-save-bot-token"
                  >
                    <KeyRound aria-hidden="true" size={16} />
                    Save bot token
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busy() || !status()?.hasBotToken}
                    onClick={() => void deleteBotToken()}
                    data-testid="slack-delete-bot-token"
                  >
                    Remove bot token
                  </Button>
                </div>

                <label
                  class="mt-5 block text-sm text-[var(--text-muted)]"
                  for="slack-app-token"
                >
                  App-level token
                </label>
                <input
                  id="slack-app-token"
                  type="password"
                  autocomplete="off"
                  spellcheck={false}
                  value={appTokenDraft()}
                  onInput={(event) =>
                    setAppTokenDraft(event.currentTarget.value)
                  }
                  class="mt-2 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm"
                  placeholder={
                    status()?.hasAppToken
                      ? "Token saved. Enter a new token to replace it."
                      : "App-level token (xapp-) with connections:write"
                  }
                  data-testid="slack-app-token"
                />
                <div class="mt-3 flex flex-wrap gap-2">
                  <Button
                    type="button"
                    disabled={busy() || appTokenDraft().trim().length === 0}
                    onClick={() => void saveAppToken()}
                    data-testid="slack-save-app-token"
                  >
                    <KeyRound aria-hidden="true" size={16} />
                    Save app token
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busy() || !status()?.hasAppToken}
                    onClick={() => void deleteAppToken()}
                    data-testid="slack-delete-app-token"
                  >
                    Remove app token
                  </Button>
                </div>

                <label class="mt-6 flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={enabled()}
                    onChange={(event) =>
                      setEnabled(event.currentTarget.checked)
                    }
                    data-testid="slack-enabled"
                  />
                  Enable the Slack channel
                </label>
                <label class="mt-2 flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked
                    disabled
                    data-testid="slack-ignore-bots"
                  />
                  Messages from bots are always ignored
                </label>

                <label
                  class="mt-5 block text-sm text-[var(--text-muted)]"
                  for="slack-allowed-channels"
                >
                  Allowed channel ids. One per line; required
                </label>
                <textarea
                  id="slack-allowed-channels"
                  rows={4}
                  class="mt-2 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2 font-mono text-sm"
                  value={channelText()}
                  onInput={(event) =>
                    setChannelText(event.currentTarget.value)
                  }
                  data-testid="slack-allowed-channels"
                />

                <label
                  class="mt-4 block text-sm text-[var(--text-muted)]"
                  for="slack-default-send-channel"
                >
                  Default send channel id. Must be in the allow-list when set
                </label>
                <input
                  id="slack-default-send-channel"
                  type="text"
                  spellcheck={false}
                  class="mt-2 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2 font-mono text-sm"
                  value={defaultSendText()}
                  onInput={(event) =>
                    setDefaultSendText(event.currentTarget.value)
                  }
                  data-testid="slack-default-send-channel"
                />

                <div class="mt-4 flex flex-wrap gap-2">
                  <Button
                    type="button"
                    disabled={busy()}
                    onClick={() => void saveSettings()}
                    data-testid="slack-save-settings"
                  >
                    <Save aria-hidden="true" size={16} />
                    Save settings
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={
                      busy() ||
                      !status()?.hasBotToken ||
                      !status()?.hasAppToken
                    }
                    onClick={() => void verify()}
                    data-testid="slack-verify"
                  >
                    Verify and connect
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={busy() || !status()?.connected}
                    onClick={() => void disconnect()}
                    data-testid="slack-disconnect"
                  >
                    Disconnect
                  </Button>
                </div>

                <p
                  class="mt-4 text-xs text-[var(--text-muted)]"
                  data-testid="slack-socket-state"
                >
                  Socket: {status()?.socketState ?? "idle"}
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
                  data-testid="slack-status"
                >
                  {error() ?? status()?.error ?? notice()}
                </p>
                <Show when={error()}>
                  <p
                    class="mt-1 text-xs text-[var(--danger)]"
                    data-testid="slack-error"
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
      id: "borg.channel.slack.settings",
      label: "Slack",
      order: 49,
      component: SlackSettings,
    });
  },
});
