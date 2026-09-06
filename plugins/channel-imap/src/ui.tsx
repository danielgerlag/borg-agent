import { defineUiPlugin } from "@borg/plugin-sdk";
import { Button, Panel } from "@borg/ui-kit";
import { KeyRound, Mail, Save } from "lucide-solid";
import { createSignal, onMount, type Component } from "solid-js";
import {
  describeImapConfigError,
  imapChannelConfigSchema,
  parseImapChannelConfig,
} from "./config";
import { IMAP_DEFAULT_MAILBOX, IMAP_PASSWORD_SECRET_KEY } from "./runtime";

export default defineUiPlugin<Component>({
  id: "borg.channel.imap",
  activate(context) {
    const ImapSettings: Component = () => {
      const [passwordDraft, setPasswordDraft] = createSignal("");
      const [hasPassword, setHasPassword] = createSignal(false);
      const [enabled, setEnabled] = createSignal(false);
      const [host, setHost] = createSignal("");
      const [port, setPort] = createSignal("993");
      const [username, setUsername] = createSignal("");
      const [mailbox, setMailbox] = createSignal(IMAP_DEFAULT_MAILBOX);
      const [busy, setBusy] = createSignal(false);
      const [notice, setNotice] = createSignal(
        "Save host, username, mailbox, and password, then enable IMAP.",
      );
      const [error, setError] = createSignal<string>();

      const refresh = async (): Promise<void> => {
        const [document, stored] = await Promise.all([
          context.config.get(),
          context.secrets.has(IMAP_PASSWORD_SECRET_KEY),
        ]);
        const parsed = parseImapChannelConfig(document);
        setEnabled(parsed.enabled);
        setHost(parsed.host);
        setPort(String(parsed.port));
        setUsername(parsed.username);
        setMailbox(parsed.mailbox);
        setHasPassword(stored);
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

      const savePassword = (): Promise<void> =>
        withBusy(async () => {
          const value = passwordDraft().trim();
          if (value.length === 0) {
            throw new Error("Enter a password to save.");
          }
          await context.secrets.set(IMAP_PASSWORD_SECRET_KEY, value);
          setPasswordDraft("");
          await syncAfterSecretWrite();
          setNotice("Password saved.");
          await refresh();
        });

      const deletePassword = (): Promise<void> =>
        withBusy(async () => {
          await context.secrets.delete(IMAP_PASSWORD_SECRET_KEY);
          setPasswordDraft("");
          await syncAfterSecretWrite();
          setNotice("Password removed.");
          await refresh();
        });

      const saveSettings = (): Promise<void> =>
        withBusy(async () => {
          const parsedPort = Number.parseInt(port(), 10);
          const settings = imapChannelConfigSchema.parse({
            enabled: enabled(),
            host: host().trim(),
            port: parsedPort,
            username: username().trim(),
            mailbox: mailbox().trim() || IMAP_DEFAULT_MAILBOX,
          });
          await context.config.update(settings);
          setNotice("IMAP settings saved.");
          await refresh();
        });

      return (
        <Panel data-testid="imap-settings-page">
          <div class="flex items-start gap-4">
            <div class="rounded-xl bg-[var(--accent)]/10 p-2.5 text-[var(--accent)]">
              <Mail aria-hidden="true" size={20} />
            </div>
            <div class="min-w-0 flex-1">
              <h3 class="text-xl font-semibold">IMAP channel</h3>
              <p class="mt-2 text-sm text-[var(--text-muted)]">
                Borg uses IMAP as a private mailbox destination. Save the host,
                username, mailbox, and password. The channel registers when it
                is enabled and those values are present.
              </p>

              <label
                class="mt-5 block text-sm text-[var(--text-muted)]"
                for="imap-password"
              >
                Password
              </label>
              <input
                id="imap-password"
                type="password"
                autocomplete="off"
                spellcheck={false}
                value={passwordDraft()}
                onInput={(event) => setPasswordDraft(event.currentTarget.value)}
                class="mt-2 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm"
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

              <label class="mt-6 flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={enabled()}
                  onChange={(event) => setEnabled(event.currentTarget.checked)}
                  data-testid="imap-enabled"
                />
                Enable the IMAP channel
              </label>

              <label
                class="mt-5 block text-sm text-[var(--text-muted)]"
                for="imap-host"
              >
                Host
              </label>
              <input
                id="imap-host"
                type="text"
                autocomplete="off"
                spellcheck={false}
                value={host()}
                onInput={(event) => setHost(event.currentTarget.value)}
                class="mt-2 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm"
                placeholder="imap.example.com"
                data-testid="imap-host"
              />

              <label
                class="mt-4 block text-sm text-[var(--text-muted)]"
                for="imap-port"
              >
                Port
              </label>
              <input
                id="imap-port"
                type="number"
                min="1"
                max="65535"
                value={port()}
                onInput={(event) => setPort(event.currentTarget.value)}
                class="mt-2 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm"
                data-testid="imap-port"
              />

              <label
                class="mt-4 block text-sm text-[var(--text-muted)]"
                for="imap-username"
              >
                Username
              </label>
              <input
                id="imap-username"
                type="text"
                autocomplete="off"
                spellcheck={false}
                value={username()}
                onInput={(event) => setUsername(event.currentTarget.value)}
                class="mt-2 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm"
                placeholder="borg@example.com"
                data-testid="imap-username"
              />

              <label
                class="mt-4 block text-sm text-[var(--text-muted)]"
                for="imap-mailbox"
              >
                Mailbox
              </label>
              <input
                id="imap-mailbox"
                type="text"
                autocomplete="off"
                spellcheck={false}
                value={mailbox()}
                onInput={(event) => setMailbox(event.currentTarget.value)}
                class="mt-2 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm"
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
            </div>
          </div>
        </Panel>
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
