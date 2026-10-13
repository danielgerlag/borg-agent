/**
 * Chat screen: the chat list, transcript, and the files in the current folder.
 */

import { Button, Panel, TextField } from "@borg/ui-kit";
import { For, Show, createEffect, createSignal } from "solid-js";
import {
  connectModelMessage,
  deleteChatToolId,
  newChatToolId,
  openChatToolId,
  promptToolId,
} from "../contract.js";
import type { HelloWorldControl } from "./control.js";

const stickThresholdPx = 24;

function isNearBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= stickThresholdPx;
}

export function ChatView(props: HelloWorldControl) {
  const [prompt, setPrompt] = createSignal("");
  const [confirming, setConfirming] = createSignal(false);
  const [followLatest, setFollowLatest] = createSignal(true);
  let transcript: HTMLDivElement | undefined;
  let followedChatId = "";
  const pinTranscript = (): void => {
    const element = transcript;
    if (!element || !followLatest()) {
      return;
    }
    element.scrollTop = element.scrollHeight;
  };
  createEffect(() => {
    const chatId = props.snapshot.chat.id;
    const revision = `${props.snapshot.turns.length}:${props.snapshot.turns.at(-1)?.text ?? ""}:${String(props.busy)}`;
    if (chatId !== followedChatId) {
      followedChatId = chatId;
      setFollowLatest(true);
    }
    void revision;
    queueMicrotask(pinTranscript);
  });
  const allowed = (toolId: string): boolean => props.snapshot.persona.allowedTools.includes(toolId);
  const promptLocked = (): boolean => props.busy || !allowed(promptToolId);
  return (
    <>
      <section class="grid h-full min-h-0 grid-cols-1 lg:grid-cols-[14rem_minmax(0,1fr)_16rem]">
        <aside
          class="flex max-h-52 min-h-0 flex-col gap-2 border-b border-[var(--border)] p-3 lg:max-h-none lg:border-r lg:border-b-0"
          data-testid="hello-world-chats"
          aria-label="Chats"
        >
          <Button
            data-testid="hello-world-new"
            {...(props.busy ? { disabled: true } : {})}
            onClick={() => props.run({ tool: newChatToolId })}
          >
            New chat
          </Button>
          <div class="grid min-h-0 gap-1 overflow-y-auto">
            <For each={props.snapshot.chats}>
              {(chat) => {
                const current = (): boolean => chat.id === props.snapshot.chat.id;
                return (
                  <button
                    type="button"
                    class="w-full rounded-xl px-3 py-2 text-left text-sm transition hover:bg-[var(--panel)]"
                    classList={{
                      "bg-[var(--panel)] text-[var(--accent)]": current(),
                      "text-[var(--text)]": !current(),
                    }}
                    aria-label={chat.title}
                    data-testid="hello-world-item"
                    {...(current() ? { "aria-current": "true" as const } : {})}
                    {...(props.busy ? { disabled: true } : {})}
                    onClick={() => props.run({ tool: openChatToolId, chatId: chat.id })}
                  >
                    <span class="block truncate font-medium">{chat.title}</span>
                  </button>
                );
              }}
            </For>
          </div>
          <Button
            variant="danger"
            data-testid="hello-world-delete"
            {...(props.busy ? { disabled: true } : {})}
            onClick={() => setConfirming(true)}
          >
            Delete chat
          </Button>
        </aside>
        <div class="grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)_auto]">
          <header class="border-b border-[var(--border)] px-5 py-3">
            <h1 data-testid="hello-world-title" class="truncate text-xl font-semibold">
              {props.snapshot.chat.title}
            </h1>
            <Show when={props.snapshot.model === null}>
              <p data-testid="hello-world-model" class="mt-1 text-sm text-[var(--text-muted)]">
                {connectModelMessage}
              </p>
            </Show>
          </header>
          <div
            ref={(element) => {
              transcript = element;
            }}
            data-testid="hello-world-transcript"
            class="grid min-h-0 content-start gap-2 overflow-y-auto px-5 py-4 text-sm"
            onScroll={(event) => setFollowLatest(isNearBottom(event.currentTarget))}
          >
            <Show
              when={props.snapshot.turns.length > 0}
              fallback={
                <p class="text-[var(--text-muted)]">Ask the assistant to read or write a file.</p>
              }
            >
              <For each={props.snapshot.turns}>
                {(turn) => (
                  <p class={turn.role === "user" ? "text-[var(--text-muted)]" : "text-[var(--text)]"}>
                    <span class="mr-2 text-xs uppercase tracking-[0.14em] text-[var(--text-subtle)]">
                      {turn.role === "user" ? "You" : "Assistant"}
                    </span>
                    {turn.text}
                  </p>
                )}
              </For>
            </Show>
            <Show when={props.busy}>
              <p data-testid="hello-world-working" class="text-[var(--text-muted)]">
                Assistant is working.
              </p>
            </Show>
          </div>
          <form
            class="flex gap-2 border-t border-[var(--border)] px-5 py-3"
            onSubmit={(event) => {
              event.preventDefault();
              const text = prompt().trim();
              if (text.length === 0 || promptLocked()) {
                return;
              }
              setPrompt("");
              setFollowLatest(true);
              props.run({ tool: promptToolId, text });
            }}
          >
            <TextField
              class="min-w-0 flex-1"
              value={prompt()}
              onChange={setPrompt}
              placeholder="Ask about the files in this chat"
              aria-label="Message"
              data-testid="hello-world-prompt"
              disabled={promptLocked()}
            />
            <Button type="submit" data-testid="hello-world-send" disabled={promptLocked()}>
              Send
            </Button>
          </form>
        </div>
        <aside
          class="flex min-h-0 flex-col gap-2 border-t border-[var(--border)] p-3 lg:border-t-0 lg:border-l"
          data-testid="hello-world-files"
          aria-label="Files"
        >
          <p class="px-1 text-xs font-semibold uppercase tracking-[0.16em] text-[var(--text-subtle)]">
            Files
          </p>
          <div class="grid min-h-0 gap-1 overflow-y-auto">
            <Show
              when={props.snapshot.files.length > 0}
              fallback={<p class="px-1 text-sm text-[var(--text-muted)]">No files in this chat yet.</p>}
            >
              <For each={props.snapshot.files}>
                {(file) => (
                  <p class="truncate px-1 text-sm" data-testid="hello-world-file">
                    {file.path}
                  </p>
                )}
              </For>
            </Show>
          </div>
        </aside>
      </section>
      <Show when={confirming()}>
        <div
          class="fixed inset-0 z-30 grid place-items-center bg-black/60 p-6"
          role="dialog"
          aria-modal="true"
          aria-labelledby="hello-world-delete-title"
          data-testid="hello-world-delete-confirm"
        >
          <Panel class="grid w-full max-w-md gap-3">
            <p class="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--danger)]">
              Delete chat
            </p>
            <h2 id="hello-world-delete-title" class="text-xl font-semibold">
              Delete “{props.snapshot.chat.title}”?
            </h2>
            <p class="text-sm text-[var(--text-muted)]">This chat and its files will be removed.</p>
            <div class="mt-3 flex justify-end gap-3">
              <Button
                type="button"
                variant="secondary"
                data-testid="hello-world-delete-cancel"
                onClick={() => setConfirming(false)}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="danger"
                data-testid="hello-world-delete-accept"
                onClick={() => {
                  const chatId = props.snapshot.chat.id;
                  setConfirming(false);
                  props.run({ tool: deleteChatToolId, chatId });
                }}
              >
                Delete
              </Button>
            </div>
          </Panel>
        </div>
      </Show>
    </>
  );
}
