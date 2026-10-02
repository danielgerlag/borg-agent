import { Button, Panel } from "@borg/ui-kit";
import { Show } from "solid-js";
import { sendQuoteToolId } from "../contract.js";
import type { BenchControl } from "./control.js";

export function QuoteView(props: BenchControl) {
  const priced = () => {
    const inspection = props.snapshot.inspection;
    return inspection.kind === "pass" ? inspection.quote : undefined;
  };
  const allowed = () => props.snapshot.persona.allowedTools.includes(sendQuoteToolId);
  const sent = () => props.snapshot.quoteSent?.revision === props.snapshot.revision;
  return (
    <section class="h-full overflow-y-auto p-8">
      <div class="mx-auto grid max-w-3xl gap-6">
        <header>
          <p class="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--text-subtle)]">Quote</p>
          <h1 class="mt-2 text-3xl font-semibold">Revision {props.snapshot.revision}</h1>
        </header>
        <div data-testid="print-bench-quote">
          <Show
            when={priced()}
            fallback={
              <Panel>
                <p class="text-sm text-[var(--text-muted)]">
                  No price until the model passes inspection.
                </p>
              </Panel>
            }
          >
            {(quote) => (
              <div class="grid gap-4 sm:grid-cols-3">
                <Panel>
                  <p class="text-xs text-[var(--text-subtle)]">Material</p>
                  <p class="mt-2 text-2xl font-semibold">{quote().grams.toFixed(1)} g</p>
                </Panel>
                <Panel>
                  <p class="text-xs text-[var(--text-subtle)]">Time</p>
                  <p class="mt-2 text-2xl font-semibold">{quote().hours.toFixed(2)} h</p>
                </Panel>
                <Panel>
                  <p class="text-xs text-[var(--text-subtle)]">Price</p>
                  <p class="mt-2 text-2xl font-semibold">{quote().price.amount.toFixed(2)} USD</p>
                </Panel>
              </div>
            )}
          </Show>
        </div>
        <div class="flex items-center gap-4">
          <Button
            data-testid="print-bench-send"
            disabled={props.busy || !allowed()}
            onClick={() => props.run({ tool: sendQuoteToolId })}
          >
            Send the quote
          </Button>
          <Show when={!allowed()}>
            <p class="text-sm text-[var(--text-muted)]">The front desk sends quotes. Change the seat in Settings.</p>
          </Show>
          <Show when={sent()}>
            <p data-testid="print-bench-sent" class="text-sm text-[var(--success)]">
              Quote sent
            </p>
          </Show>
        </div>
      </div>
    </section>
  );
}
