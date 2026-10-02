import { Panel } from "@borg/ui-kit";
import { Show } from "solid-js";
import type { FlightDeckProps } from "./control.js";

export function FlightDeck(props: FlightDeckProps) {
  const priced = () => {
    const inspection = props.snapshot.inspection;
    return inspection.kind === "pass" ? inspection.quote : undefined;
  };
  return (
    <section class="h-full overflow-y-auto p-8" data-testid="surface-flightDeck">
      <div class="mx-auto max-w-5xl">
        <p class="text-xs font-semibold uppercase tracking-[0.22em] text-[var(--accent)]">Flight deck</p>
        <h1 class="mt-2 text-3xl font-semibold">What the bench is doing</h1>
        <p class="mt-2 text-sm text-[var(--text-muted)]">
          Inspection, the designer, the quote, and the printer.
        </p>
        <div class="mt-8 grid gap-5 lg:grid-cols-2">
          <Panel>
            <h2 class="text-sm font-semibold">Inspection</h2>
            <p class="mt-2 text-sm" data-testid="flightdeck-inspection">
              {props.snapshot.inspection.kind === "fail"
                ? `${props.snapshot.inspection.findings.length} measurements failed`
                : "Passes"}
            </p>
          </Panel>
          <Panel>
            <h2 class="text-sm font-semibold">Designer</h2>
            <p class="mt-2 text-sm" data-testid="flightdeck-designer">
              {props.busy ? "Proposing a revision" : "Idle"}
            </p>
            <p class="mt-1 text-sm text-[var(--text-muted)]">Seat {props.snapshot.persona.name}</p>
          </Panel>
          <Panel>
            <h2 class="text-sm font-semibold">Quote</h2>
            <p class="mt-2 text-sm">
              <Show when={priced()} fallback={<span>No quote</span>}>
                {(quote) => <span>{quote().price.amount.toFixed(2)} USD</span>}
              </Show>
            </p>
          </Panel>
          <Panel>
            <h2 class="text-sm font-semibold">Printer</h2>
            <p class="mt-2 text-sm">
              {props.snapshot.machine.status === "running" ? "Running this revision" : "Idle"}
            </p>
          </Panel>
          <Panel>
            <h2 class="text-sm font-semibold">Approvals</h2>
            <p class="mt-2 text-sm" data-testid="flightdeck-approvals">
              {props.pending ? props.pending.title : "None waiting"}
            </p>
          </Panel>
        </div>
        <p class="mt-8 text-xs text-[var(--text-subtle)]">
          Active since {new Date(props.startedAt).toLocaleTimeString()}
        </p>
      </div>
    </section>
  );
}
