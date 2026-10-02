import { Button, Panel, Select, TextField } from "@borg/ui-kit";
import { createSignal, For, onMount, Show } from "solid-js";
import { benchApi, type BenchInteraction } from "./bridge.js";
import {
  acceptToolId,
  askToolId,
  printBenchAct,
  printBenchSnapshot,
  reviseToolId,
  sendQuoteToolId,
  snapshotSchema,
  startMachineToolId,
  usePersonaToolId,
  type ActInput,
  type BenchSnapshot,
} from "../contract.js";
import { Viewport } from "./viewport.js";

type Parameters = BenchSnapshot["parameters"];

export function Bench() {
  const [snapshot, setSnapshot] = createSignal<BenchSnapshot | undefined>();
  const [pending, setPending] = createSignal<BenchInteraction | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  onMount(() => {
    void refresh().catch((caught: unknown) => setError(messageOf(caught)));
  });

  async function refresh(): Promise<void> {
    setSnapshot(snapshotSchema.parse(await benchApi().command.invoke(printBenchSnapshot.id, {})));
  }

  async function run(input: ActInput): Promise<void> {
    if (busy()) {
      return;
    }
    setBusy(true);
    setError(null);
    const stop = watchApprovals();
    try {
      const result = printBenchAct.output.parse(
        await benchApi().command.invoke(printBenchAct.id, input),
      );
      setSnapshot(result.snapshot);
    } catch (caught) {
      setError(messageOf(caught));
      await refresh().catch(() => undefined);
    } finally {
      stop();
      setPending(null);
      setBusy(false);
    }
  }

  function watchApprovals(): () => void {
    let stopped = false;
    const pull = (): void => {
      void benchApi()
        .interactions.list()
        .then((items) => {
          if (!stopped) {
            setPending(items[0] ?? null);
          }
        })
        .catch((caught: unknown) => {
          if (!stopped) {
            setError(messageOf(caught));
          }
        });
    };
    pull();
    const timer = setInterval(pull, 40);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }

  function allowed(toolId: string): boolean {
    return snapshot()?.persona.allowedTools.includes(toolId) ?? false;
  }

  function commit(parameters: Parameters): void {
    const current = snapshot();
    if (!current || sameParameters(current.parameters, parameters) || !allowed(reviseToolId)) {
      return;
    }
    void run({ tool: reviseToolId, parameters });
  }

  return (
    <Show
      when={snapshot()}
      fallback={<p class="p-6 text-[var(--text-muted)]">Opening the bench</p>}
    >
      {(current) => (
        <div class="grid h-full grid-cols-1 bg-[var(--background)] text-[var(--text)] lg:grid-cols-[minmax(0,1fr)_380px]">
          <div class="min-h-[420px] p-4">
            <div class="h-full overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--sidebar)]">
              <Viewport
                positions={current().inspection.solid.mesh.positions}
                indices={current().inspection.solid.mesh.indices}
                failed={current().inspection.kind === "fail"}
              />
            </div>
          </div>
          <aside class="grid content-start gap-4 overflow-y-auto border-[var(--border)] p-4 lg:border-l">
            <header class="grid gap-1">
              <p class="text-xs uppercase tracking-[0.16em] text-[var(--text-subtle)]">
                Prusa MK4 · PETG
              </p>
              <h1 class="text-2xl font-semibold">Fan bracket</h1>
              <p class="text-sm text-[var(--text-muted)]">
                Revision {current().revision}. The part stays red until the measured shell passes.
              </p>
            </header>
            <Select
              label="Persona"
              aria-label="Persona"
              data-testid="print-bench-persona"
              value={current().persona.id}
              options={current().personas.map((seat) => ({
                value: seat.id,
                label: seat.name,
              }))}
              onChange={(personaId) => {
                if (personaId === current().persona.id) {
                  return;
                }
                void run({ tool: usePersonaToolId, personaId });
              }}
              disabled={busy() || !allowed(usePersonaToolId)}
            />
            <Panel class="grid gap-3">
              <Dimension
                label="Wall"
                testid="print-bench-wall"
                value={current().parameters.wallMm}
                min={0.4}
                max={4}
                step={0.1}
                unit="mm"
                disabled={busy() || !allowed(reviseToolId)}
                onCommit={(wallMm) => commit({ ...current().parameters, wallMm })}
              />
              <Dimension
                label="Hole"
                testid="print-bench-hole"
                value={current().parameters.holeMm}
                min={1}
                max={20}
                step={0.5}
                unit="mm"
                disabled={busy() || !allowed(reviseToolId)}
                onCommit={(holeMm) => commit({ ...current().parameters, holeMm })}
              />
              <Dimension
                label="Width"
                testid="print-bench-width"
                value={current().parameters.footprint.widthMm}
                min={10}
                max={250}
                step={1}
                unit="mm"
                disabled={busy() || !allowed(reviseToolId)}
                onCommit={(widthMm) =>
                  commit({
                    ...current().parameters,
                    footprint: { ...current().parameters.footprint, widthMm },
                  })
                }
              />
              <Dimension
                label="Depth"
                testid="print-bench-depth"
                value={current().parameters.footprint.depthMm}
                min={10}
                max={210}
                step={1}
                unit="mm"
                disabled={busy() || !allowed(reviseToolId)}
                onCommit={(depthMm) =>
                  commit({
                    ...current().parameters,
                    footprint: { ...current().parameters.footprint, depthMm },
                  })
                }
              />
              <Dimension
                label="Chamfer"
                testid="print-bench-chamfer"
                value={current().parameters.chamferDeg}
                min={0}
                max={90}
                step={1}
                unit="°"
                disabled={busy() || !allowed(reviseToolId)}
                onCommit={(chamferDeg) => commit({ ...current().parameters, chamferDeg })}
              />
            </Panel>
            <Panel>
              <h2 class="mb-2 text-sm font-semibold">Inspection</h2>
              <ul data-testid="print-bench-findings" class="grid gap-1 text-sm">
                <Show
                  when={current().inspection.findings.length > 0}
                  fallback={<li class="text-[var(--success)]">Passes the MK4 PETG profile</li>}
                >
                  <For each={current().inspection.findings}>
                    {(finding) => (
                      <li class="text-[var(--danger)]">
                        {labelFor(finding.code)} {finding.measured.toFixed(2)} / {finding.limit}
                      </li>
                    )}
                  </For>
                </Show>
              </ul>
            </Panel>
            <Show when={current().proposal}>
              {(proposal) => (
                <Panel data-testid="print-bench-proposal" class="grid gap-3">
                  <h2 class="text-sm font-semibold">Proposal</h2>
                  <p class="text-sm text-[var(--text-muted)]">
                    Wall {proposal().parameters.wallMm} mm, chamfer {proposal().parameters.chamferDeg}°.
                    Nothing here is the current part yet.
                  </p>
                  <Button
                    data-testid="print-bench-accept"
                    disabled={busy() || !allowed(acceptToolId)}
                    onClick={() => void run({ tool: acceptToolId })}
                  >
                    Accept
                  </Button>
                </Panel>
              )}
            </Show>
            <Quote inspection={current().inspection} />
            <Show when={current().quoteSent?.revision === current().revision}>
              <p data-testid="print-bench-sent" class="text-sm text-[var(--success)]">
                Sent
              </p>
            </Show>
            <Show when={current().machine.status === "running"}>
              <p data-testid="print-bench-running" class="text-sm text-[var(--accent)]">
                Running
              </p>
            </Show>
            <div class="flex flex-wrap gap-2">
              <Button
                data-testid="print-bench-ask"
                variant="secondary"
                disabled={busy() || !allowed(askToolId)}
                onClick={() => void run({ tool: askToolId })}
              >
                Ask
              </Button>
              <Button
                data-testid="print-bench-send"
                variant="secondary"
                disabled={busy() || !allowed(sendQuoteToolId)}
                onClick={() => void run({ tool: sendQuoteToolId })}
              >
                Send
              </Button>
              <Button
                data-testid="print-bench-start"
                disabled={
                  busy() ||
                  !allowed(startMachineToolId) ||
                  current().inspection.kind !== "pass"
                }
                onClick={() => {
                  if (current().inspection.kind !== "pass") {
                    return;
                  }
                  void run({ tool: startMachineToolId });
                }}
              >
                Start
              </Button>
            </div>
            <Show when={error()}>
              <p class="text-sm text-[var(--danger)]">{error()}</p>
            </Show>
          </aside>
          <Show when={pending()}>
            {(item) => (
              <div class="fixed inset-0 z-20 grid place-items-center bg-black/60 p-6">
                <Panel data-testid="print-bench-approval" class="grid max-w-md gap-3">
                  <p class="text-xs uppercase tracking-[0.16em] text-[var(--text-subtle)]">
                    {item().kind}
                  </p>
                  <h2 class="text-lg font-semibold">{item().title}</h2>
                  <p class="text-sm text-[var(--text-muted)]">{item().prompt}</p>
                  <Button
                    data-testid="print-bench-approval-allow"
                    onClick={() =>
                      void benchApi().interactions.respond(item().id, {
                        kind: "approval",
                        decision: "allow",
                        duration: "once",
                      })
                    }
                  >
                    Allow once
                  </Button>
                </Panel>
              </div>
            )}
          </Show>
        </div>
      )}
    </Show>
  );
}

function Quote(props: { inspection: BenchSnapshot["inspection"] }) {
  const inspection = () => props.inspection;
  const priced = () => {
    const current = inspection();
    return current.kind === "pass" ? current.quote : undefined;
  };
  return (
    <Panel>
      <h2 class="mb-2 text-sm font-semibold">Quote</h2>
      <p data-testid="print-bench-quote" class="text-sm">
        <Show when={priced()} fallback={<span class="text-[var(--text-muted)]">Unquoted</span>}>
          {(quote) => (
            <span>
              {quote().grams.toFixed(1)} g · {quote().hours.toFixed(2)} h · {quote().price.amount.toFixed(2)} USD
            </span>
          )}
        </Show>
      </p>
    </Panel>
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

function labelFor(code: "wall" | "hole" | "footprint" | "overhang"): string {
  switch (code) {
    case "wall":
      return "Wall";
    case "hole":
      return "Hole";
    case "footprint":
      return "Footprint";
    case "overhang":
      return "Overhang";
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

function messageOf(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "The bench could not apply that";
}
