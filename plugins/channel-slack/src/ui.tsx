import {
  slackChannelDisconnect,
  slackChannelGetStatus,
  slackChannelVerify,
  type SlackChannelStatus,
} from "@borg/contracts";
import { defineUiPlugin } from "@borg/plugin-sdk";
import { Button, Panel } from "@borg/ui-kit";
import { KeyRound, PlugZap, Save } from "lucide-solid";
import { Show, createSignal, onMount, type Component } from "solid-js";
import {
  describeConfigError,
  formatChannelList,
  parseChannelList,
  parseOptionalChannelId,
  parseSlackChannelConfig,
  slackChannelSettingsSchema,
} from "./config";
import {
  SLACK_APP_TOKEN_SECRET_KEY,
  SLACK_BOT_TOKEN_SECRET_KEY,
} from "./protocol";

const IDLE_STATUS: SlackChannelStatus = {
  hasBotToken: false,
  hasAppToken: false,
  connected: false,
  socketState: "idle",
};

export default defineUiPlugin<Component>({
  id: "borg.channel.slack",
  activate(context) {
    const SlackSettings: Component = () => {
      const [status, setStatus] = createSignal<SlackChannelStatus>(IDLE_STATUS);
      const [botTokenDraft, setBotTokenDraft] = createSignal("");
      const [appTokenDraft, setAppTokenDraft] = createSignal("");
      const [enabled, setEnabled] = createSignal(false);
      const [channelText, setChannelText] = createSignal("");
      const [defaultSendText, setDefaultSendText] = createSignal("");
      const [busy, setBusy] = createSignal(false);
      const [notice, setNotice] = createSignal(
        "Save a bot token and app-level token, allow the channels Borg may read, then verify.",
      );
      const [error, setError] = createSignal<string>();

      const refresh = async (): Promise<void> => {
        const [config, current] = await Promise.all([
          context.config.get(),
          context.bus.invoke(slackChannelGetStatus, {}),
        ]);
        const parsed = parseSlackChannelConfig(config);
        setEnabled(parsed.enabled);
        setChannelText(formatChannelList(parsed.allowedChannelIds));
        setDefaultSendText(parsed.defaultSendChannelId);
        setStatus(current);
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

      const saveBotToken = (): Promise<void> =>
        withBusy(async () => {
          const value = botTokenDraft().trim();
          if (value.length === 0) {
            throw new Error("Enter a bot token to save.");
          }
          await context.secrets.set(SLACK_BOT_TOKEN_SECRET_KEY, value);
          setBotTokenDraft("");
          setNotice("Bot token saved. Verify to connect.");
          await refresh();
        });

      const deleteBotToken = (): Promise<void> =>
        withBusy(async () => {
          await context.bus.invoke(slackChannelDisconnect, {});
          await context.secrets.delete(SLACK_BOT_TOKEN_SECRET_KEY);
          setBotTokenDraft("");
          setNotice("Bot token removed.");
          await refresh();
        });

      const saveAppToken = (): Promise<void> =>
        withBusy(async () => {
          const value = appTokenDraft().trim();
          if (value.length === 0) {
            throw new Error("Enter an app-level token to save.");
          }
          await context.secrets.set(SLACK_APP_TOKEN_SECRET_KEY, value);
          setAppTokenDraft("");
          setNotice("App-level token saved. Verify to connect.");
          await refresh();
        });

      const deleteAppToken = (): Promise<void> =>
        withBusy(async () => {
          await context.bus.invoke(slackChannelDisconnect, {});
          await context.secrets.delete(SLACK_APP_TOKEN_SECRET_KEY);
          setAppTokenDraft("");
          setNotice("App-level token removed.");
          await refresh();
        });

      const saveSettings = (): Promise<void> =>
        withBusy(async () => {
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
          await context.config.update(settings);
          setNotice("Slack settings saved.");
          await refresh();
        });

      const verify = (): Promise<void> =>
        withBusy(async () => {
          const next = await context.bus.invoke(slackChannelVerify, {});
          setStatus(next);
          setNotice(
            next.connected
              ? "Connected to Slack Socket Mode."
              : `Socket is ${next.socketState}.`,
          );
        });

      const disconnect = (): Promise<void> =>
        withBusy(async () => {
          const next = await context.bus.invoke(slackChannelDisconnect, {});
          setStatus(next);
          setNotice("Disconnected from Slack Socket Mode.");
        });

      return (
        <Panel data-testid="slack-settings-page">
          <div class="flex items-start gap-4">
            <div class="rounded-xl bg-[var(--accent)]/10 p-2.5 text-[var(--accent)]">
              <PlugZap aria-hidden="true" size={20} />
            </div>
            <div class="min-w-0 flex-1">
              <h3 class="text-xl font-semibold">Slack channel</h3>
              <p class="mt-2 text-sm text-[var(--text-muted)]">
                Borg joins Slack as a bot over Socket Mode. In the Slack app
                settings, enable Socket Mode, subscribe to message events, and
                install the app. Save the bot token and app-level token, then
                allow every channel listed below.
              </p>

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
                  status().hasBotToken
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
                  disabled={busy() || !status().hasBotToken}
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
                  status().hasAppToken
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
                  disabled={busy() || !status().hasAppToken}
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
                    busy() || !status().hasBotToken || !status().hasAppToken
                  }
                  onClick={() => void verify()}
                  data-testid="slack-verify"
                >
                  Verify and connect
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy() || !status().connected}
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
                Socket: {status().socketState}
                {status().botUserId ? ` · bot ${status().botUserId}` : ""}
              </p>
              <p
                class="mt-1 text-xs"
                classList={{
                  "text-[var(--success)]": status().connected && !error(),
                  "text-[var(--text-muted)]": !status().connected && !error(),
                  "text-[var(--danger)]": Boolean(error()),
                }}
                data-testid="slack-status"
              >
                {error() ?? status().error ?? notice()}
              </p>
              <Show when={error()}>
                <p
                  class="mt-1 text-xs text-[var(--danger)]"
                  data-testid="slack-error"
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
      id: "borg.channel.slack.settings",
      label: "Slack",
      order: 49,
      component: SlackSettings,
    });
  },
});
