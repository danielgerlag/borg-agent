import {
  discordChannelDisconnect,
  discordChannelGetStatus,
  discordChannelVerify,
  type DiscordChannelStatus,
} from "@borg/contracts";
import { defineUiPlugin } from "@borg/plugin-sdk";
import { Button, Panel } from "@borg/ui-kit";
import { KeyRound, PlugZap, Save } from "lucide-solid";
import { Show, createSignal, onMount, type Component } from "solid-js";
import {
  describeConfigError,
  discordChannelSettingsSchema,
  formatSnowflakeList,
  parseDiscordChannelConfig,
  parseSnowflakeList,
} from "./config";
import { DISCORD_TOKEN_SECRET_KEY } from "./protocol";

const IDLE_STATUS: DiscordChannelStatus = {
  hasToken: false,
  connected: false,
  gatewayState: "idle",
};

export default defineUiPlugin<Component>({
  id: "borg.channel.discord",
  activate(context) {
    const DiscordSettings: Component = () => {
      const [status, setStatus] = createSignal<DiscordChannelStatus>(IDLE_STATUS);
      const [tokenDraft, setTokenDraft] = createSignal("");
      const [enabled, setEnabled] = createSignal(false);
      const [guildText, setGuildText] = createSignal("");
      const [channelText, setChannelText] = createSignal("");
      const [busy, setBusy] = createSignal(false);
      const [notice, setNotice] = createSignal(
        "Save a bot token, allow the channels Borg may read, then verify.",
      );
      const [error, setError] = createSignal<string>();

      const refresh = async (): Promise<void> => {
        const [config, current] = await Promise.all([
          context.config.get(),
          context.bus.invoke(discordChannelGetStatus, {}),
        ]);
        const parsed = parseDiscordChannelConfig(config);
        setEnabled(parsed.enabled);
        setGuildText(formatSnowflakeList(parsed.allowedGuildIds));
        setChannelText(formatSnowflakeList(parsed.allowedChannelIds));
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

      const saveToken = (): Promise<void> =>
        withBusy(async () => {
          const value = tokenDraft().trim();
          if (value.length === 0) {
            throw new Error("Enter a bot token to save.");
          }
          await context.secrets.set(DISCORD_TOKEN_SECRET_KEY, value);
          setTokenDraft("");
          setNotice("Bot token saved. Verify to connect.");
          await refresh();
        });

      const deleteToken = (): Promise<void> =>
        withBusy(async () => {
          await context.bus.invoke(discordChannelDisconnect, {});
          await context.secrets.delete(DISCORD_TOKEN_SECRET_KEY);
          setTokenDraft("");
          setNotice("Bot token removed.");
          await refresh();
        });

      const saveSettings = (): Promise<void> =>
        withBusy(async () => {
          const settings = discordChannelSettingsSchema.parse({
            enabled: enabled(),
            ignoreBots: true,
            allowedGuildIds: parseSnowflakeList(guildText(), "Guild ids"),
            allowedChannelIds: parseSnowflakeList(channelText(), "Channel ids"),
          });
          await context.config.update(settings);
          setNotice("Discord settings saved.");
          await refresh();
        });

      const verify = (): Promise<void> =>
        withBusy(async () => {
          const next = await context.bus.invoke(discordChannelVerify, {});
          setStatus(next);
          setNotice(
            next.connected
              ? "Connected to the Discord gateway."
              : `Gateway is ${next.gatewayState}.`,
          );
        });

      const disconnect = (): Promise<void> =>
        withBusy(async () => {
          const next = await context.bus.invoke(discordChannelDisconnect, {});
          setStatus(next);
          setNotice("Disconnected from the Discord gateway.");
        });

      return (
        <Panel data-testid="discord-settings-page">
          <div class="flex items-start gap-4">
            <div class="rounded-xl bg-[var(--accent)]/10 p-2.5 text-[var(--accent)]">
              <PlugZap aria-hidden="true" size={20} />
            </div>
            <div class="min-w-0 flex-1">
              <h3 class="text-xl font-semibold">Discord channel</h3>
              <p class="mt-2 text-sm text-[var(--text-muted)]">
                Borg joins Discord as a bot over the realtime gateway. In the
                Discord developer portal, enable the privileged{" "}
                <strong>MESSAGE CONTENT</strong> intent for this application.
                Without it Discord delivers empty message bodies and Borg has
                nothing to read. Invite the bot to the server and give it access
                to every channel listed below.
              </p>

              <label
                class="mt-5 block text-sm text-[var(--text-muted)]"
                for="discord-bot-token"
              >
                Bot token
              </label>
              <input
                id="discord-bot-token"
                type="password"
                autocomplete="off"
                spellcheck={false}
                value={tokenDraft()}
                onInput={(event) => setTokenDraft(event.currentTarget.value)}
                class="mt-2 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm"
                placeholder={
                  status().hasToken
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
                  disabled={busy() || !status().hasToken}
                  onClick={() => void deleteToken()}
                  data-testid="discord-delete-token"
                >
                  Remove token
                </Button>
              </div>

              <label class="mt-6 flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={enabled()}
                  onChange={(event) => setEnabled(event.currentTarget.checked)}
                  data-testid="discord-enabled"
                />
                Enable the Discord channel
              </label>
              <label class="mt-2 flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked
                  disabled
                  data-testid="discord-ignore-bots"
                />
                Messages from bots are always ignored
              </label>

              <label
                class="mt-5 block text-sm text-[var(--text-muted)]"
                for="discord-allowed-guilds"
              >
                Allowed server (guild) ids. One per line; blank allows any
                server
              </label>
              <textarea
                id="discord-allowed-guilds"
                rows={3}
                class="mt-2 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2 font-mono text-sm"
                value={guildText()}
                onInput={(event) => setGuildText(event.currentTarget.value)}
                data-testid="discord-allowed-guilds"
              />

              <label
                class="mt-4 block text-sm text-[var(--text-muted)]"
                for="discord-allowed-channels"
              >
                Allowed channel ids. One per line; required
              </label>
              <textarea
                id="discord-allowed-channels"
                rows={4}
                class="mt-2 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2 font-mono text-sm"
                value={channelText()}
                onInput={(event) => setChannelText(event.currentTarget.value)}
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
                  disabled={busy() || !status().hasToken}
                  onClick={() => void verify()}
                  data-testid="discord-verify"
                >
                  Verify and connect
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy() || !status().connected}
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
                Gateway: {status().gatewayState}
                {status().botUserId ? ` · bot ${status().botUserId}` : ""}
              </p>
              <p
                class="mt-1 text-xs"
                classList={{
                  "text-[var(--success)]": status().connected && !error(),
                  "text-[var(--text-muted)]": !status().connected && !error(),
                  "text-[var(--danger)]": Boolean(error()),
                }}
                data-testid="discord-status"
              >
                {error() ?? status().error ?? notice()}
              </p>
              <Show when={error()}>
                <p
                  class="mt-1 text-xs text-[var(--danger)]"
                  data-testid="discord-error"
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
      id: "borg.channel.discord.settings",
      label: "Discord",
      order: 45,
      component: DiscordSettings,
    });
  },
});
