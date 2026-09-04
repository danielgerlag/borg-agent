import type { CostSummary } from "@borg/contracts";
import { defineUiPlugin, type Disposable } from "@borg/plugin-sdk";
import { Panel } from "@borg/ui-kit";
import { CircleDollarSign } from "lucide-solid";
import { createSignal, onCleanup, onMount, type Component } from "solid-js";
import { formatCurrencyAmounts } from "./format";

export default defineUiPlugin<Component>({
  id: "borg.usage",
  activate(context) {
    const SessionUsage: Component = () => {
      const [summary, setSummary] = createSignal<CostSummary>({
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        amountsByCurrency: {},
      });
      let subscription: Disposable | undefined;
      let active = true;

      onMount(() => {
        void context.cost
          .subscribe((current) => {
            if (active) {
              setSummary(current);
            }
          })
          .then((disposable) => {
            if (!active) {
              void disposable.dispose();
              return;
            }
            subscription = disposable;
          })
          .catch(() => undefined);
      });

      onCleanup(() => {
        active = false;
        void subscription?.dispose();
      });

      return (
        <Panel data-testid="flightdeck-session-usage">
          <div class="flex items-start gap-3">
            <CircleDollarSign
              aria-hidden="true"
              size={20}
              class="text-[var(--accent)]"
            />
            <div class="min-w-0 flex-1">
              <p class="text-sm font-semibold">This Borg session</p>
              <p class="mt-1 text-xs text-[var(--text-muted)]">
                Tokens and cost for the current app session, including chats,
                bots, and graphs.
              </p>
              <dl class="mt-4 grid gap-2 text-xs sm:grid-cols-2">
                <div>
                  <dt class="text-[var(--text-subtle)]">Input</dt>
                  <dd data-testid="usage-input-tokens">
                    {summary().inputTokens}
                  </dd>
                </div>
                <div>
                  <dt class="text-[var(--text-subtle)]">Output</dt>
                  <dd data-testid="usage-output-tokens">
                    {summary().outputTokens}
                  </dd>
                </div>
                <div>
                  <dt class="text-[var(--text-subtle)]">Cache read</dt>
                  <dd data-testid="usage-cached-tokens">
                    {summary().cachedInputTokens}
                  </dd>
                </div>
                <div>
                  <dt class="text-[var(--text-subtle)]">Cache write</dt>
                  <dd data-testid="usage-cache-write-tokens">
                    {summary().cacheWriteTokens}
                  </dd>
                </div>
              </dl>
              <p class="mt-3 text-xs text-[var(--text-muted)]" data-testid="usage-cost">
                {formatCurrencyAmounts(summary().amountsByCurrency)}
              </p>
            </div>
          </div>
        </Panel>
      );
    };

    return context.ui.registerFlightDeckWidget({
      id: "borg.usage.session",
      label: "This Borg session",
      order: 5,
      component: SessionUsage,
    });
  },
});
