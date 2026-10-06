/**
 * Design workspace for the desktop shell. It loads the snapshot and sends acts to the plugin.
 */

import { defineUiPlugin } from "@borg-agent/plugin-sdk";
import { createSignal, onCleanup, onMount, Show, type Component } from "solid-js";
import {
  printBenchAct,
  printBenchSnapshot,
  type ActInput,
  type BenchSnapshot,
} from "./contract.js";
import { DesignView } from "./renderer/design.js";

export default defineUiPlugin<Component>({
  id: "example.print-bench",
  activate(context) {
    const DesignWorkspace: Component = () => {
      const [snapshot, setSnapshot] = createSignal<BenchSnapshot | undefined>();
      const [busy, setBusy] = createSignal(false);
      const [unavailable, setUnavailable] = createSignal(false);
      let ticket = 0;
      let timer: ReturnType<typeof setInterval> | undefined;
      let disposed = false;

      const refresh = (): void => {
        const mine = ++ticket;
        void context.bus.invoke(printBenchSnapshot, {}).then(
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
          .invoke(printBenchAct, input)
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
              <p class="p-6 text-sm text-[var(--text-muted)]" data-testid="print-bench-loading">
                {unavailable() ? "The design bench is unavailable." : "Opening the design bench."}
              </p>
            }
          >
            {(current) => <DesignView snapshot={current()} busy={busy()} run={run} />}
          </Show>
        </div>
      );
    };

    return context.ui.registerWorkspaceView({
      id: "example.print-bench.design",
      label: "Design",
      order: 20,
      placement: "primary",
      component: DesignWorkspace,
    });
  },
});
