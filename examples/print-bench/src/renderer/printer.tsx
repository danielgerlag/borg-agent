import { Button, Panel } from "@borg/ui-kit";
import { Show } from "solid-js";
import { startMachineToolId } from "../contract.js";
import type { BenchControl } from "./control.js";

export function PrinterView(props: BenchControl) {
  const allowed = () => props.snapshot.persona.allowedTools.includes(startMachineToolId);
  const printable = () => props.snapshot.inspection.kind === "pass";
  const running = () => props.snapshot.machine.status === "running";
  return (
    <section class="h-full overflow-y-auto p-8">
      <div class="mx-auto grid max-w-3xl gap-6">
        <header>
          <p class="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--text-subtle)]">Printer</p>
          <h1 class="mt-2 text-3xl font-semibold">Prusa MK4</h1>
        </header>
        <Panel>
          <Show
            when={running()}
            fallback={<p class="text-sm text-[var(--text-muted)]">Idle. Nothing is printing.</p>}
          >
            <p data-testid="print-bench-running" class="text-sm text-[var(--accent)]">
              Printer is running
            </p>
          </Show>
        </Panel>
        <div class="flex items-center gap-4">
          <Button
            data-testid="print-bench-start"
            disabled={props.busy || !allowed() || !printable()}
            onClick={() => {
              if (!printable()) {
                return;
              }
              props.run({ tool: startMachineToolId });
            }}
          >
            Start the printer
          </Button>
          <Show when={!allowed()}>
            <p class="text-sm text-[var(--text-muted)]">The operator starts the printer. Change the seat in Settings.</p>
          </Show>
          <Show when={allowed() && !printable()}>
            <p class="text-sm text-[var(--text-muted)]">The bracket has not passed inspection.</p>
          </Show>
        </div>
      </div>
    </section>
  );
}
