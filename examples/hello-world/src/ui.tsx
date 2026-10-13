/**
 * Hello world workspace for the desktop shell. It loads the snapshot and sends acts to the plugin.
 */

import { defineUiPlugin } from "@borg-agent/plugin-sdk";
import { Folder } from "lucide-solid";
import { createSignal, onCleanup, onMount, Show, type Component } from "solid-js";
import { helloWorldAct, helloWorldSnapshot, type ActInput, type HelloWorldSnapshot } from "./contract.js";
import { ChatView } from "./renderer/chat.js";

export default defineUiPlugin<Component>({
  id: "example.hello-world",
  activate(context) {
    const HelloWorldWorkspace: Component = () => {
      const [snapshot, setSnapshot] = createSignal<HelloWorldSnapshot | undefined>();
      const [busy, setBusy] = createSignal(false);
      const [unavailable, setUnavailable] = createSignal(false);
      let ticket = 0;
      let timer: ReturnType<typeof setInterval> | undefined;
      let disposed = false;

      const refresh = (): void => {
        const mine = ++ticket;
        void context.bus.invoke(helloWorldSnapshot, {}).then(
          (next) => {
            if (!disposed && mine === ticket) {
              setSnapshot(next);
              setUnavailable(false);
            }
          },
          () => {
            if (!disposed && mine === ticket && snapshot() === undefined) {
              setUnavailable(true);
            }
          },
        );
      };

      onMount(refresh);
      onCleanup(() => {
        disposed = true;
        if (timer !== undefined) {
          clearInterval(timer);
        }
      });

      const run = (input: ActInput): void => {
        if (busy()) {
          return;
        }
        setBusy(true);
        timer = setInterval(refresh, 400);
        void context.bus
          .invoke(helloWorldAct, input)
          .then(
            (result) => {
              ticket += 1;
              if (!disposed) {
                setSnapshot(result.snapshot);
              }
            },
            () => {
              refresh();
            },
          )
          .finally(() => {
            if (timer !== undefined) {
              clearInterval(timer);
              timer = undefined;
            }
            if (!disposed) {
              setBusy(false);
            }
          });
      };

      return (
        <div class="h-full min-h-0">
          <Show
            when={snapshot()}
            fallback={
              <p class="p-6 text-sm text-[var(--text-muted)]" data-testid="hello-world-loading">
                {unavailable() ? "Hello world is unavailable." : "Opening Hello world."}
              </p>
            }
          >
            {(current) => <ChatView snapshot={current()} busy={busy()} run={run} />}
          </Show>
        </div>
      );
    };

    return context.ui.registerWorkspaceView({
      id: "example.hello-world.chat",
      label: "Hello world",
      order: 20,
      placement: "primary",
      icon: Folder,
      component: HelloWorldWorkspace,
    });
  },
});
