import { Button, Panel, TextField } from "@borg/ui-kit";
import { For, Show } from "solid-js";
import { acceptToolId, askToolId, reviseToolId } from "../contract.js";
import type { BenchControl } from "./control.js";
import { Viewport } from "./viewport.js";

type Parameters = BenchControl["snapshot"]["parameters"];
type Finding = Extract<
  BenchControl["snapshot"]["inspection"],
  { kind: "fail" }
>["findings"][number];

export function DesignView(props: BenchControl) {
  const allowed = (toolId: string): boolean =>
    props.snapshot.persona.allowedTools.includes(toolId);
  const commit = (parameters: Parameters): void => {
    if (sameParameters(props.snapshot.parameters, parameters) || !allowed(reviseToolId)) {
      return;
    }
    props.run({ tool: reviseToolId, parameters });
  };
  return (
    <section class="grid h-full min-h-0 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div class="grid min-h-0 grid-rows-[auto_minmax(0,1fr)]">
        <header class="border-b border-[var(--border)] px-5 py-4">
          <h1 class="text-xl font-semibold">Fan bracket</h1>
          <p class="mt-1 text-sm text-[var(--text-muted)]">
            {props.snapshot.inspection.kind === "fail"
              ? "It will not print in PETG on this MK4."
              : "It passes the MK4 PETG rules."}
          </p>
          <ul data-testid="print-bench-findings" class="mt-3 grid gap-1 text-sm">
            <Show
              when={props.snapshot.inspection.findings.length > 0}
              fallback={<li class="text-[var(--success)]">Wall, hole, footprint, and overhang all pass.</li>}
            >
              <For each={props.snapshot.inspection.findings}>
                {(finding) => <li class="text-[var(--danger)]">{findingSentence(finding)}</li>}
              </For>
            </Show>
          </ul>
        </header>
        <div class="min-h-0 p-4">
          <div class="h-full overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--sidebar)]">
            <Viewport
              positions={props.snapshot.inspection.solid.mesh.positions}
              indices={props.snapshot.inspection.solid.mesh.indices}
              failed={props.snapshot.inspection.kind === "fail"}
            />
          </div>
        </div>
      </div>
      <aside class="flex min-h-0 flex-col border-t border-[var(--border)] lg:border-t-0 lg:border-l">
        <div class="min-h-0 flex-1 overflow-y-auto p-4">
          <h2 class="text-sm font-semibold">Dimensions</h2>
          <p class="mt-1 text-sm text-[var(--text-muted)]">
            Drag to orbit the bed. These fields edit the solid.
          </p>
          <div class="mt-4 grid gap-3">
            <Dimension
              label="Wall thickness"
              testid="print-bench-wall"
              value={props.snapshot.parameters.wallMm}
              min={0.4}
              max={4}
              step={0.1}
              unit="mm"
              disabled={props.busy || !allowed(reviseToolId)}
              onCommit={(wallMm) => commit({ ...props.snapshot.parameters, wallMm })}
            />
            <Dimension
              label="Mounting hole"
              testid="print-bench-hole"
              value={props.snapshot.parameters.holeMm}
              min={1}
              max={20}
              step={0.5}
              unit="mm"
              disabled={props.busy || !allowed(reviseToolId)}
              onCommit={(holeMm) => commit({ ...props.snapshot.parameters, holeMm })}
            />
            <Dimension
              label="Width"
              testid="print-bench-width"
              value={props.snapshot.parameters.footprint.widthMm}
              min={10}
              max={250}
              step={1}
              unit="mm"
              disabled={props.busy || !allowed(reviseToolId)}
              onCommit={(widthMm) =>
                commit({
                  ...props.snapshot.parameters,
                  footprint: { ...props.snapshot.parameters.footprint, widthMm },
                })
              }
            />
            <Dimension
              label="Depth"
              testid="print-bench-depth"
              value={props.snapshot.parameters.footprint.depthMm}
              min={10}
              max={210}
              step={1}
              unit="mm"
              disabled={props.busy || !allowed(reviseToolId)}
              onCommit={(depthMm) =>
                commit({
                  ...props.snapshot.parameters,
                  footprint: { ...props.snapshot.parameters.footprint, depthMm },
                })
              }
            />
            <Dimension
              label="Chamfer"
              testid="print-bench-chamfer"
              value={props.snapshot.parameters.chamferDeg}
              min={0}
              max={90}
              step={1}
              unit="°"
              disabled={props.busy || !allowed(reviseToolId)}
              onCommit={(chamferDeg) => commit({ ...props.snapshot.parameters, chamferDeg })}
            />
          </div>
          <Show when={props.snapshot.proposal}>
            {(proposal) => (
              <Panel data-testid="print-bench-proposal" class="mt-4 grid gap-3">
                <h2 class="text-sm font-semibold">Proposal</h2>
                <p class="text-sm text-[var(--text-muted)]">
                  Staged wall {proposal().parameters.wallMm} mm, chamfer {proposal().parameters.chamferDeg}°.
                  This is not the part yet.
                </p>
                <Button
                  data-testid="print-bench-accept"
                  disabled={props.busy || !allowed(acceptToolId)}
                  onClick={() => props.run({ tool: acceptToolId })}
                >
                  Accept
                </Button>
              </Panel>
            )}
          </Show>
        </div>
        <div class="border-t border-[var(--border)] p-4">
          <Button
            class="w-full"
            data-testid="print-bench-ask"
            disabled={props.busy || !allowed(askToolId)}
            onClick={() => props.run({ tool: askToolId })}
          >
            Propose a revision
          </Button>
        </div>
      </aside>
    </section>
  );
}

function Dimension(props: {
  label: string;
  testid: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  disabled: boolean;
  onCommit: (value: number) => void;
}) {
  function publish(raw: string): void {
    const value = Number(raw);
    if (!Number.isFinite(value) || value < props.min || value > props.max) {
      return;
    }
    props.onCommit(value);
  }
  return (
    <label class="grid gap-1 text-sm">
      <span class="text-[var(--text-muted)]">
        {props.label} {props.value}
        {props.unit}
      </span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        disabled={props.disabled}
        onInput={(event) => publish(event.currentTarget.value)}
      />
      <TextField
        size="sm"
        type="number"
        value={String(props.value)}
        min={props.min}
        max={props.max}
        step={props.step}
        disabled={props.disabled}
        data-testid={props.testid}
        aria-label={props.label}
        onChange={publish}
      />
    </label>
  );
}

function findingSentence(finding: Finding): string {
  const measured = finding.measured.toFixed(2);
  switch (finding.code) {
    case "wall":
      return `Wall is ${measured} mm thick. PETG on this machine needs at least ${finding.limit} mm.`;
    case "hole":
      return `Hole is ${measured} mm. The limit on this profile is ${finding.limit} mm.`;
    case "footprint":
      return `Footprint is ${measured} mm. The bed allows ${finding.limit} mm.`;
    case "overhang":
      return `Overhang is ${measured}°. This printer holds up to ${finding.limit}°.`;
  }
}

function sameParameters(left: Parameters, right: Parameters): boolean {
  return (
    left.wallMm === right.wallMm &&
    left.holeMm === right.holeMm &&
    left.chamferDeg === right.chamferDeg &&
    left.footprint.widthMm === right.footprint.widthMm &&
    left.footprint.depthMm === right.footprint.depthMm
  );
}
