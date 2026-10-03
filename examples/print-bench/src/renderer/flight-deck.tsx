import { Panel } from "@borg/ui-kit";
import type { FlightDeckProps } from "./control.js";

export function FlightDeck(props: FlightDeckProps) {
  return (
    <section class="h-full overflow-y-auto p-8" data-testid="surface-flightDeck">
      <div class="mx-auto max-w-5xl">
        <p class="text-xs font-semibold uppercase tracking-[0.22em] text-[var(--accent)]">Flight deck</p>
        <h1 class="mt-2 text-3xl font-semibold">What the bench is doing</h1>
        <p class="mt-2 text-sm text-[var(--text-muted)]">Inspection and the designer.</p>
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
              {props.pending?.kind === "human_input" ? "Asking a question" : props.busy ? "Building" : "Idle"}
            </p>
            <p class="mt-1 text-sm text-[var(--text-muted)]">{props.snapshot.design.title}</p>
          </Panel>
        </div>
        <p class="mt-8 text-xs text-[var(--text-subtle)]">
          Active since {new Date(props.startedAt).toLocaleTimeString()}
        </p>
      </div>
    </section>
  );
}
