import {
  copilotConnect,
  copilotDisconnect,
  copilotGetStatus,
  copilotPollDeviceFlow,
  copilotStartDeviceFlow,
} from "@borg/contracts";
import { defineUiPlugin } from "@borg/plugin-sdk";
import { Button, Panel } from "@borg/ui-kit";
import { Sparkles } from "lucide-solid";
import { Show, createSignal, onCleanup, onMount, type Component } from "solid-js";

export default defineUiPlugin<Component>({
  id: "borg.copilot",
  activate(context) {
    const CopilotSetup: Component = () => {
      const [hasToken, setHasToken] = createSignal(false);
      const [connected, setConnected] = createSignal(false);
      const [userCode, setUserCode] = createSignal<string>();
      const [verificationUri, setVerificationUri] = createSignal<string>();
      const [busy, setBusy] = createSignal(false);
      const [message, setMessage] = createSignal(
        "Optional. Sign in with GitHub to use Copilot models.",
      );
      const [error, setError] = createSignal<string>();
      let pollTimer: number | undefined;

      const stopPolling = (): void => {
        if (pollTimer !== undefined) {
          window.clearTimeout(pollTimer);
          pollTimer = undefined;
        }
      };

      const refresh = async (): Promise<void> => {
        const [stored, status] = await Promise.all([
          context.secrets.has("githubOauthToken"),
          context.bus.invoke(copilotGetStatus, {}),
        ]);
        setHasToken(stored || status.hasToken);
        setConnected(status.connected);
      };

      onMount(() => {
        void refresh().catch((failure: unknown) =>
          setError(failure instanceof Error ? failure.message : String(failure)),
        );
      });

      onCleanup(() => {
        stopPolling();
      });

      const poll = async (intervalSeconds: number): Promise<void> => {
        stopPolling();
        pollTimer = window.setTimeout(() => {
          void (async () => {
            try {
              const result = await context.bus.invoke(copilotPollDeviceFlow, {});
              if (result.status === "pending") {
                await poll(intervalSeconds);
                return;
              }
              setUserCode(undefined);
              setVerificationUri(undefined);
              if (result.status === "complete") {
                const status = await context.bus.invoke(copilotConnect, {});
                setHasToken(status.hasToken);
                setConnected(status.connected);
                setMessage("Copilot models are available in assistant setup.");
                setError(undefined);
                return;
              }
              setError(result.error ?? "Copilot sign-in failed.");
            } catch (failure) {
              setError(
                failure instanceof Error ? failure.message : String(failure),
              );
            }
          })();
        }, intervalSeconds * 1000);
      };

      const start = async (): Promise<void> => {
        setBusy(true);
        setError(undefined);
        try {
          const started = await context.bus.invoke(copilotStartDeviceFlow, {});
          setUserCode(started.userCode);
          setVerificationUri(started.verificationUri);
          setMessage("Enter the code on GitHub to finish Copilot sign-in.");
          await poll(started.interval);
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure));
        } finally {
          setBusy(false);
        }
      };

      const connect = async (): Promise<void> => {
        setBusy(true);
        setError(undefined);
        try {
          const status = await context.bus.invoke(copilotConnect, {});
          setHasToken(status.hasToken);
          setConnected(status.connected);
          setMessage(
            status.connected
              ? "Copilot models are available in assistant setup."
              : "Copilot is not connected.",
          );
        } catch (failure) {
          setConnected(false);
          setError(failure instanceof Error ? failure.message : String(failure));
        } finally {
          setBusy(false);
        }
      };

      const removeToken = async (): Promise<void> => {
        setBusy(true);
        setError(undefined);
        try {
          try {
            await context.bus.invoke(copilotDisconnect, {});
          } finally {
            await context.secrets.delete("githubOauthToken");
          }
          setHasToken(false);
          setConnected(false);
          setUserCode(undefined);
          setVerificationUri(undefined);
          setMessage("GitHub token removed.");
          await refresh();
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure));
        } finally {
          setBusy(false);
        }
      };

      return (
        <Panel data-testid="copilot-setup-step">
          <div class="flex items-start gap-4">
            <div class="rounded-xl bg-[var(--accent)]/10 p-2.5 text-[var(--accent)]">
              <Sparkles aria-hidden="true" size={20} />
            </div>
            <div class="min-w-0 flex-1">
              <p class="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--accent)]">
                Optional
              </p>
              <h3 class="mt-2 text-xl font-semibold">Connect Copilot</h3>
              <p class="mt-2 text-sm text-[var(--text-muted)]">
                Sign in with GitHub using a device code. Access tokens stay in
                the vault.
              </p>

              <Show when={userCode() && verificationUri()}>
                <p class="mt-5 text-sm" data-testid="copilot-user-code">
                  Code: <span class="font-mono">{userCode()}</span>
                </p>
                <a
                  class="mt-2 inline-block text-sm text-[var(--accent)] underline"
                  href={verificationUri()}
                  target="_blank"
                  rel="noreferrer"
                  data-testid="copilot-verification-uri"
                >
                  {verificationUri()}
                </a>
              </Show>

              <div class="mt-4 flex flex-wrap gap-2">
                <Button
                  type="button"
                  disabled={busy()}
                  onClick={() => void start()}
                  data-testid="copilot-start-device-flow"
                >
                  {busy() ? "Starting…" : "Sign in with GitHub"}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={busy() || !hasToken()}
                  onClick={() => void connect()}
                  data-testid="copilot-connect"
                >
                  {connected() ? "Reconnect" : "Verify and connect"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  disabled={busy() || (!hasToken() && !connected())}
                  onClick={() => void removeToken()}
                  data-testid="copilot-disconnect"
                >
                  Remove token
                </Button>
              </div>

              <p
                class="mt-3 text-xs"
                classList={{
                  "text-[var(--success)]": connected() && !error(),
                  "text-[var(--text-muted)]": !connected() && !error(),
                  "text-[var(--danger)]": Boolean(error()),
                }}
                data-testid="copilot-status"
              >
                {error() ??
                  (connected()
                    ? "Copilot is connected for this Borg session."
                    : hasToken()
                      ? "A GitHub token is saved. Verify it to enable Copilot models."
                      : message())}
              </p>
            </div>
          </div>
        </Panel>
      );
    };

    const wizard = context.ui.registerWizardStep({
      id: "borg.copilot.setup",
      label: "Copilot",
      order: 28,
      required: false,
      isComplete: () => true,
      component: CopilotSetup,
    });
    const settings = context.ui.registerSettingsPage({
      id: "borg.copilot.settings",
      label: "Copilot",
      order: 28,
      component: CopilotSetup,
    });
    return {
      dispose: async () => {
        await settings.dispose();
        await wizard.dispose();
      },
    };
  },
});
