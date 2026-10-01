import { Button, TextField } from "@borg/ui-kit";
import type { AssistQuestion } from "./contract";
import { HelpCircle, LoaderCircle, RefreshCw, Send, Sparkles, X } from "lucide-solid";
import {
  For,
  Show,
  createEffect,
  createSignal,
  on,
  type Component,
} from "solid-js";

export interface AssistFollowUp {
  readonly label: string;
  readonly prompt: string;
}

export interface AssistPanelAnswer {
  readonly text?: string;
  readonly choiceIds?: readonly string[];
}

export interface AssistPanelProps {
  readonly prompt: string;
  readonly loading: boolean;
  readonly response: string;
  readonly error?: string | undefined;
  readonly pendingQuestion?: AssistQuestion | undefined;
  readonly onPromptChange: (value: string) => void;
  readonly onSend: (prompt?: string) => void;
  readonly onAnswer: (answer: AssistPanelAnswer) => void;
  readonly onClose: () => void;
  readonly onNewConversation: () => void;
}

const FOLLOW_UPS: readonly AssistFollowUp[] = [
  {
    label: "Add error handling",
    prompt:
      "Add onError skip or retry to task steps that call tools or agents and still fail the whole graph.",
  },
  {
    label: "Add approval steps",
    prompt:
      "Add feedback_gate confirm steps before high-stakes actions such as sending messages or calling external tools.",
  },
  {
    label: "Make more robust",
    prompt:
      "Review this graph: add timeouts where useful, keep every path reaching an end node, and validate required inputs.",
  },
];

const AssistPanel: Component<AssistPanelProps> = (props) => {
  const [freeform, setFreeform] = createSignal("");
  const [selectedIds, setSelectedIds] = createSignal<readonly string[]>([]);

  createEffect(
    on(
      () => props.pendingQuestion?.id,
      () => {
        setFreeform("");
        setSelectedIds([]);
      },
    ),
  );

  const questionPending = () => props.pendingQuestion !== undefined;
  const sendDisabled = () =>
    props.loading || questionPending() || props.prompt.trim().length === 0;

  const toggleChoice = (id: string): void => {
    setSelectedIds((current) =>
      current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id],
    );
  };

  const submitChoices = (choiceIds: readonly string[]): void => {
    if (props.loading || choiceIds.length === 0) {
      return;
    }
    props.onAnswer({ choiceIds });
  };

  const submitFreeform = (): void => {
    const text = freeform().trim();
    if (props.loading || text.length === 0) {
      return;
    }
    props.onAnswer({ text });
  };

  return (
    <div
      class="flex flex-col border-t border-[var(--border)] bg-[var(--panel-muted)]/80"
      data-testid="graph-assist-panel"
    >
      <div class="flex items-center justify-between gap-2 border-b border-[var(--border)] px-3 py-2">
        <p class="flex items-center gap-2 text-xs font-semibold text-amber-300">
          <Sparkles aria-hidden="true" size={14} />
          AI Assist
        </p>
        <div class="flex items-center gap-1">
          <Show when={props.response || props.error || questionPending()}>
            <button
              type="button"
              class="rounded-md px-1.5 py-1 text-[var(--text-muted)] hover:bg-[var(--panel)] hover:text-[var(--text)]"
              aria-label="New conversation"
              onClick={() => props.onNewConversation()}
              data-testid="graph-assist-new"
            >
              <RefreshCw aria-hidden="true" size={14} />
            </button>
          </Show>
          <button
            type="button"
            class="rounded-md p-1 text-[var(--text-muted)] hover:bg-[var(--panel)] hover:text-[var(--text)]"
            aria-label="Close AI Assist"
            onClick={() => props.onClose()}
            data-testid="graph-assist-close"
          >
            <X aria-hidden="true" size={14} />
          </button>
        </div>
      </div>
      <Show
        when={
          props.response || props.error || props.loading || questionPending()
        }
      >
        <div
          class="max-h-72 min-h-16 overflow-y-auto px-3 py-2 text-xs leading-5 text-[var(--text)]"
          data-testid="graph-assist-response"
        >
          <Show when={props.error}>
            {(message) => (
              <p class="text-[var(--danger)]" role="alert">
                {message()}
              </p>
            )}
          </Show>
          <Show when={props.response}>
            <p class="whitespace-pre-wrap">{props.response}</p>
          </Show>
          <Show when={props.loading && !props.response && !props.error}>
            <p class="text-[var(--text-muted)]">Working…</p>
          </Show>
          <Show when={props.pendingQuestion}>
            {(question) => (
              <div
                class="mt-2 rounded-md border border-[var(--accent)]/25 bg-[var(--accent)]/10 p-2.5"
                data-testid="graph-assist-question"
              >
                <p class="mb-2 flex items-center gap-1.5 text-[0.7rem] font-semibold text-[var(--accent)]">
                  <HelpCircle aria-hidden="true" size={14} />
                  Question
                </p>
                <p class="mb-2 whitespace-pre-wrap">{question().text}</p>
                <Show when={question().choices.length > 0}>
                  <div class="mb-2 flex flex-wrap gap-1.5">
                    <For each={question().choices}>
                      {(choice) => (
                        <button
                          type="button"
                          class="rounded-md border border-[var(--border)] bg-[var(--panel)] px-2.5 py-1 text-[11px] text-[var(--text)] disabled:cursor-not-allowed disabled:opacity-45"
                          classList={{
                            "border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-contrast)]":
                              question().multiSelect &&
                              selectedIds().includes(choice.id),
                          }}
                          disabled={props.loading}
                          data-testid={`graph-assist-choice-${choice.id}`}
                          onClick={() => {
                            if (question().multiSelect) {
                              toggleChoice(choice.id);
                              return;
                            }
                            submitChoices([choice.id]);
                          }}
                        >
                          {choice.label}
                        </button>
                      )}
                    </For>
                  </div>
                  <Show when={question().multiSelect}>
                    <div class="mb-2">
                      <Button
                        type="button"
                        size="sm"
                        variant="secondary"
                        disabled={
                          props.loading || selectedIds().length === 0
                        }
                        data-testid="graph-assist-choice-submit"
                        onClick={() => submitChoices(selectedIds())}
                      >
                        {props.loading ? "Sending…" : "Submit"}
                      </Button>
                    </div>
                  </Show>
                </Show>
                <Show when={question().allowFreeform}>
                  <div class="flex items-end gap-1.5">
                    <TextField
                      class="min-w-0 flex-1"
                      size="sm"
                      value={freeform()}
                      onChange={setFreeform}
                      placeholder="Type your answer…"
                      disabled={props.loading}
                      aria-label="AI Assist answer"
                      data-testid="graph-assist-answer"
                      onKeyDown={(event) => {
                        if (
                          event.key === "Enter" &&
                          !event.shiftKey &&
                          !props.loading
                        ) {
                          event.preventDefault();
                          submitFreeform();
                        }
                      }}
                    />
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={props.loading || freeform().trim().length === 0}
                      onClick={() => submitFreeform()}
                      data-testid="graph-assist-answer-send"
                    >
                      <Show
                        when={!props.loading}
                        fallback={
                          <LoaderCircle
                            aria-hidden="true"
                            class="animate-spin"
                            size={14}
                          />
                        }
                      >
                        <Send aria-hidden="true" size={14} />
                      </Show>
                    </Button>
                  </div>
                </Show>
              </div>
            )}
          </Show>
        </div>
      </Show>
      <Show
        when={
          !props.loading &&
          !props.error &&
          !questionPending() &&
          props.response.length > 0
        }
      >
        <div
          class="flex flex-wrap gap-1 border-t border-[var(--border)]/60 px-3 py-1.5"
          data-testid="graph-assist-followups"
        >
          <For each={FOLLOW_UPS}>
            {(action) => (
              <button
                type="button"
                class="rounded-md border border-[var(--border)] bg-[var(--panel)] px-2 py-1 text-[10px] text-[var(--text-muted)] hover:text-[var(--text)]"
                onClick={() => props.onSend(action.prompt)}
              >
                {action.label}
              </button>
            )}
          </For>
        </div>
      </Show>
      <div class="flex items-end gap-2 border-t border-[var(--border)] p-2">
        <TextField
          class="min-w-0 flex-1"
          value={props.prompt}
          onChange={props.onPromptChange}
          placeholder="Describe what you want the graph to do…"
          disabled={props.loading || questionPending()}
          aria-label="AI Assist prompt"
          data-testid="graph-assist-prompt"
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !props.loading &&
              !questionPending()
            ) {
              event.preventDefault();
              if (props.prompt.trim().length > 0) {
                props.onSend();
              }
            }
          }}
        />
        <Button
          type="button"
          size="sm"
          disabled={sendDisabled()}
          onClick={() => props.onSend()}
          data-testid="graph-assist-send"
        >
          <Show
            when={!props.loading}
            fallback={
              <LoaderCircle
                aria-hidden="true"
                class="animate-spin"
                size={14}
              />
            }
          >
            <Send aria-hidden="true" size={14} />
          </Show>
          {props.loading ? "Working…" : "Send"}
        </Button>
      </div>
    </div>
  );
};

export default AssistPanel;
