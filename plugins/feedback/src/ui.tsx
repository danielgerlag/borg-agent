import type { PendingInteraction } from "@borg/contracts";
import type { InteractionRendererProps } from "@borg/plugin-sdk";
import { defineUiPlugin } from "@borg/plugin-sdk";
import { Button, Panel } from "@borg/ui-kit";
import { MessageCircleQuestion } from "lucide-solid";
import {
  For,
  Show,
  createSignal,
  onCleanup,
  onMount,
  type Component,
} from "solid-js";

const timeoutPresets = [60_000, 300_000, 900_000, 3_600_000, 86_400_000];

export default defineUiPlugin<Component>({
  id: "borg.feedback",
  activate(context) {
    const HumanInputRenderer: Component<InteractionRendererProps> = (props) => {
      const [text, setText] = createSignal("");
      const [submitting, setSubmitting] = createSignal(false);

      const respond = async (
        response: Parameters<InteractionRendererProps["respond"]>[0],
      ): Promise<void> => {
        setSubmitting(true);
        try {
          await props.respond(response);
        } finally {
          setSubmitting(false);
        }
      };

      return (
        <div data-testid="human-input-interaction">
          <Show when={props.interaction.form === "text"}>
            <input
              value={text()}
              onInput={(event) => setText(event.currentTarget.value)}
              class="mt-4 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2.5 text-sm outline-none focus:border-[var(--accent)]"
              placeholder="Type your answer"
              data-testid="human-input-text"
            />
            <button
              type="button"
              class="mt-3 w-full rounded-xl bg-[var(--accent)] px-4 py-2.5 text-sm font-semibold text-[var(--background)] disabled:opacity-50"
              disabled={submitting()}
              onClick={() => void respond({ kind: "text", text: text() })}
              data-testid="human-input-submit"
            >
              Continue
            </button>
          </Show>

          <Show when={props.interaction.form === "confirm"}>
            <div class="mt-4 grid grid-cols-2 gap-3">
              <button
                type="button"
                class="rounded-xl border border-[var(--border)] px-4 py-2.5 text-sm"
                onClick={() =>
                  void respond({ kind: "confirm", confirmed: false })
                }
              >
                No
              </button>
              <button
                type="button"
                class="rounded-xl bg-[var(--accent)] px-4 py-2.5 text-sm font-semibold text-[var(--background)]"
                onClick={() =>
                  void respond({ kind: "confirm", confirmed: true })
                }
              >
                Yes
              </button>
            </div>
          </Show>

          <Show when={props.interaction.form === "choice"}>
            <div class="mt-4 grid gap-2">
              <For each={props.interaction.choices}>
                {(choice) => (
                  <button
                    type="button"
                    class="rounded-xl border border-[var(--border)] px-4 py-2.5 text-left text-sm hover:border-[var(--accent)]"
                    onClick={() =>
                      void respond({
                        kind: "choice",
                        choiceId: choice.id,
                      })
                    }
                  >
                    {choice.label}
                  </button>
                )}
              </For>
            </div>
          </Show>
        </div>
      );
    };

    const PendingQuestions: Component = () => {
      const [pending, setPending] =
        createSignal<readonly PendingInteraction[]>([]);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let active = true;
      const refresh = async (): Promise<void> => {
        try {
          const interactions = await context.interactions.list();
          if (active) {
            setPending(
              interactions.filter(({ kind }) => kind === "human_input"),
            );
          }
        } catch (error) {
          console.error("[borg.feedback] failed to refresh interactions", error);
        } finally {
          if (active) {
            timer = setTimeout(() => void refresh(), 250);
          }
        }
      };
      onMount(() => void refresh());
      onCleanup(() => {
        active = false;
        if (timer) {
          clearTimeout(timer);
        }
      });

      return (
        <Panel data-testid="feedback-widget">
          <div class="flex items-center gap-3">
            <MessageCircleQuestion
              aria-hidden="true"
              size={20}
              class="text-[var(--accent)]"
            />
            <div>
              <p class="text-sm font-semibold">Pending questions</p>
              <p class="text-xs text-[var(--text-muted)]">
                <span data-testid="pending-question-count">
                  {pending().length}
                </span>{" "}
                waiting for input
              </p>
            </div>
          </div>
          <Show when={pending().length > 0}>
            <ul class="mt-4 grid gap-2 border-t border-[var(--border)] pt-4">
              <For each={pending()}>
                {(interaction) => (
                  <li class="rounded-lg bg-[var(--background)] px-3 py-2">
                    <p class="text-xs font-semibold">{interaction.title}</p>
                    <p class="mt-1 line-clamp-2 text-xs text-[var(--text-muted)]">
                      {interaction.prompt}
                    </p>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </Panel>
      );
    };

    const FeedbackSettings: Component = () => {
      const [timeoutMs, setTimeoutMs] = createSignal(300_000);
      const [notifyOnRequest, setNotifyOnRequest] = createSignal(true);
      const [focusOnRequest, setFocusOnRequest] = createSignal(false);
      const [status, setStatus] = createSignal("Loading settings…");

      onMount(() => {
        void context.config
          .get()
          .then((config) => {
            setTimeoutMs(Number(config.defaultTimeoutMs ?? 300_000));
            setNotifyOnRequest(config.notifyOnRequest !== false);
            setFocusOnRequest(config.focusOnRequest === true);
            setStatus("Settings loaded");
          })
          .catch((error: unknown) =>
            setStatus(error instanceof Error ? error.message : String(error)),
          );
      });

      const save = async (): Promise<void> => {
        setStatus("Saving…");
        try {
          await context.config.update({
            defaultTimeoutMs: timeoutMs(),
            notifyOnRequest: notifyOnRequest(),
            focusOnRequest: focusOnRequest(),
          });
          setStatus("Saved");
        } catch (error) {
          setStatus(error instanceof Error ? error.message : String(error));
        }
      };

      return (
        <section data-testid="feedback-settings-page">
          <p class="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--accent)]">
            Attention
          </p>
          <h3 class="mt-2 text-xl font-semibold">When Borg needs your input</h3>
          <p class="mt-2 text-sm leading-6 text-[var(--text-muted)]">
            Choose how long work should wait and how Borg should get your attention.
          </p>
          <label class="mt-4 block text-sm text-[var(--text-muted)]">
            Wait for an answer
            <select
              value={timeoutMs()}
              onInput={(event) =>
                setTimeoutMs(Number(event.currentTarget.value))
              }
              class="mt-2 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2"
            >
              <Show when={!timeoutPresets.includes(timeoutMs())}>
                <option value={timeoutMs()}>
                  Current setting ({Math.round(timeoutMs() / 1000)} seconds)
                </option>
              </Show>
              <option value={60_000}>1 minute</option>
              <option value={300_000}>5 minutes</option>
              <option value={900_000}>15 minutes</option>
              <option value={3_600_000}>1 hour</option>
              <option value={86_400_000}>Until tomorrow</option>
            </select>
          </label>
          <label class="mt-4 flex items-center gap-3 text-sm">
            <input
              type="checkbox"
              checked={notifyOnRequest()}
              onChange={(event) =>
                setNotifyOnRequest(event.currentTarget.checked)
              }
            />
            Send a notification when Borg needs an answer
          </label>
          <label class="mt-3 flex items-center gap-3 text-sm">
            <input
              type="checkbox"
              checked={focusOnRequest()}
              onChange={(event) =>
                setFocusOnRequest(event.currentTarget.checked)
              }
            />
            Bring Borg to the front when work is blocked
          </label>
          <div class="mt-5 flex items-center gap-3">
            <Button
              type="button"
              onClick={() => void save()}
            >
              Save attention settings
            </Button>
            <span class="text-xs text-[var(--text-muted)]">{status()}</span>
          </div>
        </section>
      );
    };

    const renderer = context.ui.registerInteractionRenderer({
      id: "borg.feedback.human-input",
      kind: "human_input",
      component: HumanInputRenderer,
    });
    const widget = context.ui.registerFlightDeckWidget({
      id: "borg.feedback.pending-questions",
      label: "Pending questions",
      order: 20,
      component: PendingQuestions,
    });
    const settings = context.ui.registerSettingsPage({
      id: "borg.feedback.settings",
      label: "Attention",
      order: 30,
      component: FeedbackSettings,
    });
    return {
      dispose: async () => {
        await settings.dispose();
        await widget.dispose();
        await renderer.dispose();
      },
    };
  },
});
