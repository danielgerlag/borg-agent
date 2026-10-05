import { Button, Panel, TextField } from "@borg/ui-kit";
import { For, Show, createSignal } from "solid-js";
import {
  addToolId,
  deleteDesignToolId,
  deleteToolId,
  newDesignToolId,
  openDesignToolId,
  promptToolId,
  selectToolId,
  transformToolId,
  type Primitive,
} from "../contract.js";
import type { Body } from "../domain.js";
import type { BenchControl } from "./control.js";
import { Viewport } from "./viewport.js";

type Mode = "translate" | "rotate" | "scale";
type Finding = Extract<BenchControl["snapshot"]["inspection"], { kind: "fail" }>["findings"][number];

const palette: readonly { label: string; testid: string; solid: Primitive }[] = [
  { label: "Box", testid: "print-bench-tool-box", solid: { kind: "box", widthMm: 40, depthMm: 30, heightMm: 20 } },
  { label: "Cylinder", testid: "print-bench-tool-cylinder", solid: { kind: "cylinder", radiusMm: 12, heightMm: 30 } },
  { label: "Sphere", testid: "print-bench-tool-sphere", solid: { kind: "sphere", radiusMm: 15 } },
  { label: "Cone", testid: "print-bench-tool-cone", solid: { kind: "cone", radiusMm: 16, heightMm: 28 } },
];

export function DesignView(props: BenchControl) {
  const [mode, setMode] = createSignal<Mode>("translate");
  const [prompt, setPrompt] = createSignal("");
  const [pendingDelete, setPendingDelete] = createSignal<string | null>(null);
  const allowed = (toolId: string): boolean => props.snapshot.persona.allowedTools.includes(toolId);
  const promptLocked = (): boolean => props.busy || !allowed(promptToolId);
  const selected = (): Body | undefined =>
    props.snapshot.scene.bodies.find((body) => body.id === props.snapshot.scene.selectedId);
  const replace = (body: Body): void => {
    if (!allowed(transformToolId)) {
      return;
    }
    props.run({ tool: transformToolId, body });
  };
  const pendingTitle = (): string =>
    props.snapshot.designs.find((design) => design.id === pendingDelete())?.title ??
    props.snapshot.design.title;
  return (
    <>
    <section class="grid h-full min-h-0 grid-cols-1 lg:grid-cols-[12rem_9rem_minmax(0,1fr)_16rem]">
      <aside
        class="flex max-h-44 min-h-0 flex-col gap-2 border-b border-[var(--border)] p-3 lg:max-h-none lg:border-r lg:border-b-0"
        data-testid="print-bench-designs"
        aria-label="Designs"
      >
        <Button
          data-testid="print-bench-new-design"
          {...(props.busy ? { disabled: true } : {})}
          onClick={() => props.run({ tool: newDesignToolId })}
        >
          New design
        </Button>
        <div class="grid min-h-0 gap-1 overflow-y-auto">
          <For each={props.snapshot.designs}>
            {(design) => {
              const current = (): boolean => design.id === props.snapshot.design.id;
              const label = (): string => `${design.title}, ${solidsLabel(design.solids)}`;
              return (
                <button
                  type="button"
                  class="w-full rounded-xl px-3 py-2 text-left text-sm transition hover:bg-[var(--panel)]"
                  classList={{
                    "bg-[var(--panel)] text-[var(--accent)]": current(),
                    "text-[var(--text)]": !current(),
                  }}
                  aria-label={label()}
                  data-testid="print-bench-design-item"
                  {...(current() ? { "aria-current": "true" as const } : {})}
                  {...(props.busy ? { disabled: true } : {})}
                  onClick={() => props.run({ tool: openDesignToolId, designId: design.id })}
                >
                  <span class="block truncate font-medium">{design.title}</span>
                  <span class="mt-1 block text-[10px] uppercase tracking-wider text-[var(--text-subtle)]">
                    {solidsLabel(design.solids)}
                  </span>
                </button>
              );
            }}
          </For>
        </div>
      </aside>
      <aside class="flex flex-col gap-2 border-b border-[var(--border)] p-3 lg:border-r lg:border-b-0" data-testid="print-bench-palette">
        <p class="px-1 text-xs font-semibold uppercase tracking-[0.16em] text-[var(--text-subtle)]">Palette</p>
        <ModeButton label="Move" mode="translate" current={mode()} onPick={setMode} />
        <ModeButton label="Rotate" mode="rotate" current={mode()} onPick={setMode} />
        <ModeButton label="Scale" mode="scale" current={mode()} onPick={setMode} />
        <For each={palette}>
          {(item) => (
            <Button
              variant="secondary"
              data-testid={item.testid}
              disabled={props.busy || !allowed(addToolId)}
              onClick={() => props.run({ tool: addToolId, solid: item.solid })}
            >
              {item.label}
            </Button>
          )}
        </For>
        <Button
          variant="danger"
          data-testid="print-bench-tool-delete"
          disabled={props.busy || !allowed(deleteToolId) || selected() === undefined}
          onClick={() => {
            const body = selected();
            if (body) {
              props.run({ tool: deleteToolId, id: body.id });
            }
          }}
        >
          Delete
        </Button>
      </aside>
      <div class="grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)_auto]">
        <header class="border-b border-[var(--border)] px-5 py-3">
          <div class="flex items-start justify-between gap-3">
            <h1 data-testid="print-bench-design-title" class="truncate text-xl font-semibold">
              {props.snapshot.design.title}
            </h1>
            <button
              type="button"
              class="shrink-0 rounded-lg px-2 py-1 text-xs text-[var(--text-muted)] hover:text-[var(--danger)]"
              aria-label="Delete design"
              data-testid="print-bench-delete-design"
              {...(props.busy ? { disabled: true } : {})}
              onClick={() => setPendingDelete(props.snapshot.design.id)}
            >
              Delete
            </button>
          </div>
          <p class="mt-1 text-sm text-[var(--text-muted)]">
            {props.snapshot.scene.bodies.length === 0
              ? "The bed is empty. Add a solid, or describe one."
              : props.snapshot.inspection.kind === "fail"
                ? "This mesh will not print on the MK4 in PETG."
                : "This mesh passes the MK4 PETG rules."}
          </p>
          <ul data-testid="print-bench-findings" class="mt-2 grid gap-1 text-sm">
            <Show
              when={props.snapshot.inspection.findings.length > 0}
              fallback={<li class="text-[var(--success)]">On the bed, and the overhang is printable.</li>}
            >
              <For each={props.snapshot.inspection.findings}>
                {(finding) => <li class="text-[var(--danger)]">{findingSentence(finding)}</li>}
              </For>
            </Show>
          </ul>
        </header>
        <div class="min-h-0">
          <Viewport
            bodies={props.snapshot.scene.bodies}
            selectedId={props.snapshot.scene.selectedId}
            failed={props.snapshot.inspection.kind === "fail"}
            mode={mode()}
            onSelect={(id) => {
              if (id !== props.snapshot.scene.selectedId && allowed(selectToolId)) {
                props.run({ tool: selectToolId, id });
              }
            }}
            onTransform={replace}
          />
        </div>
        <div class="border-t border-[var(--border)] p-3">
          <div data-testid="print-bench-transcript" class="mb-2 grid max-h-36 gap-2 overflow-y-auto text-sm">
            <For each={props.snapshot.turns}>
              {(turn) => (
                <p class={turn.role === "user" ? "text-[var(--text-muted)]" : "text-[var(--text)]"}>
                  <span class="mr-2 text-xs uppercase tracking-[0.14em] text-[var(--text-subtle)]">
                    {turn.role === "user" ? "You" : "Designer"}
                  </span>
                  {turn.text}
                </p>
              )}
            </For>
            <Show when={props.busy}>
              <p data-testid="print-bench-working" class="text-[var(--text-muted)]">Designer is working.</p>
            </Show>
          </div>
          <form
            class="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const text = prompt().trim();
              if (text.length === 0 || promptLocked()) {
                return;
              }
              setPrompt("");
              props.run({ tool: promptToolId, text });
            }}
          >
            <TextField
              class="min-w-0 flex-1"
              value={prompt()}
              onChange={setPrompt}
              placeholder="Tell the designer what to change"
              aria-label="Prompt"
              data-testid="print-bench-prompt"
              disabled={promptLocked()}
            />
            <Button type="submit" data-testid="print-bench-build" disabled={promptLocked()}>
              Send
            </Button>
          </form>
        </div>
      </div>
      <aside class="min-h-0 overflow-y-auto border-t border-[var(--border)] p-4 lg:border-t-0 lg:border-l">
        <h2 class="text-sm font-semibold">Selected</h2>
        <Show
          when={selected()}
          fallback={<p class="mt-2 text-sm text-[var(--text-muted)]">Click a solid, or add one from the palette.</p>}
        >
          {(body) => <Inspector body={body()} disabled={props.busy || !allowed(transformToolId)} onChange={replace} />}
        </Show>
      </aside>
    </section>
      <Show when={pendingDelete()}>
        <div
          class="fixed inset-0 z-30 grid place-items-center bg-black/60 p-6"
          role="dialog"
          aria-modal="true"
          aria-labelledby="print-bench-delete-title"
          data-testid="print-bench-delete-confirm"
        >
          <Panel class="grid w-full max-w-md gap-3">
            <p class="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--danger)]">Delete design</p>
            <h2 id="print-bench-delete-title" class="text-xl font-semibold">
              Delete “{pendingTitle()}”?
            </h2>
            <p class="text-sm text-[var(--text-muted)]">This design and its model will be removed.</p>
            <div class="mt-3 flex justify-end gap-3">
              <Button
                type="button"
                variant="secondary"
                data-testid="print-bench-delete-cancel"
                onClick={() => setPendingDelete(null)}
              >
                Keep design
              </Button>
              <Button
                type="button"
                variant="danger"
                data-testid="print-bench-delete-confirm-action"
                onClick={() => {
                  const designId = pendingDelete();
                  setPendingDelete(null);
                  if (designId) {
                    props.run({ tool: deleteDesignToolId, designId });
                  }
                }}
              >
                Delete design
              </Button>
            </div>
          </Panel>
        </div>
      </Show>
    </>
  );
}

function solidsLabel(count: number): string {
  if (count === 0) {
    return "Empty";
  }
  if (count === 1) {
    return "1 solid";
  }
  return `${count} solids`;
}

function ModeButton(props: { label: string; mode: Mode; current: Mode; onPick: (mode: Mode) => void }) {
  const active = () => props.current === props.mode;
  return (
    <Button
      variant={active() ? "primary" : "secondary"}
      aria-pressed={active()}
      data-testid={`print-bench-mode-${props.mode}`}
      onClick={() => props.onPick(props.mode)}
    >
      {props.label}
    </Button>
  );
}

function Inspector(props: { body: Body; disabled: boolean; onChange: (body: Body) => void }) {
  return (
    <div class="mt-3 grid gap-3">
      <p class="text-sm capitalize text-[var(--text-muted)]">{props.body.kind}</p>
      <Show when={props.body.kind === "box" ? props.body : undefined}>
        {(body) => (
          <>
            <NumberField label="Width" testid="print-bench-width" value={body().widthMm} disabled={props.disabled} onCommit={(widthMm) => props.onChange({ ...body(), widthMm })} />
            <NumberField label="Depth" testid="print-bench-depth" value={body().depthMm} disabled={props.disabled} onCommit={(depthMm) => props.onChange({ ...body(), depthMm })} />
            <NumberField label="Height" testid="print-bench-height" value={body().heightMm} disabled={props.disabled} onCommit={(heightMm) => props.onChange({ ...body(), heightMm })} />
          </>
        )}
      </Show>
      <Show when={props.body.kind === "cylinder" || props.body.kind === "cone" ? props.body : undefined}>
        {(body) => (
          <>
            <NumberField label="Radius" testid="print-bench-radius" value={body().radiusMm} disabled={props.disabled} onCommit={(radiusMm) => props.onChange({ ...body(), radiusMm })} />
            <NumberField label="Height" testid="print-bench-height" value={body().heightMm} disabled={props.disabled} onCommit={(heightMm) => props.onChange({ ...body(), heightMm })} />
          </>
        )}
      </Show>
      <Show when={props.body.kind === "sphere" ? props.body : undefined}>
        {(body) => (
          <NumberField label="Radius" testid="print-bench-radius" value={body().radiusMm} disabled={props.disabled} onCommit={(radiusMm) => props.onChange({ ...body(), radiusMm })} />
        )}
      </Show>
      <NumberField label="X" testid="print-bench-x" value={props.body.position.x} allowZero disabled={props.disabled} onCommit={(x) => props.onChange({ ...props.body, position: { ...props.body.position, x } })} />
      <NumberField label="Y" testid="print-bench-y" value={props.body.position.y} allowZero disabled={props.disabled} onCommit={(y) => props.onChange({ ...props.body, position: { ...props.body.position, y } })} />
      <NumberField label="Z" testid="print-bench-z" value={props.body.position.z} allowZero disabled={props.disabled} onCommit={(z) => props.onChange({ ...props.body, position: { ...props.body.position, z } })} />
    </div>
  );
}

function NumberField(props: {
  label: string;
  testid: string;
  value: number;
  disabled: boolean;
  allowZero?: boolean;
  onCommit: (value: number) => void;
}) {
  return (
    <label class="grid gap-1 text-sm">
      <span class="text-[var(--text-muted)]">
        {props.label} {props.value}
      </span>
      <TextField
        size="sm"
        type="number"
        value={String(props.value)}
        disabled={props.disabled}
        data-testid={props.testid}
        aria-label={props.label}
        onChange={(raw) => {
          const value = Number(raw);
          if (!Number.isFinite(value) || value < 0 || (!props.allowZero && value === 0) || value === props.value) {
            return;
          }
          props.onCommit(value);
        }}
      />
    </label>
  );
}

function findingSentence(finding: Finding): string {
  const measured = finding.measured.toFixed(2);
  switch (finding.code) {
    case "empty":
      return "Nothing is on the bed.";
    case "footprint":
      return `The solid extends ${measured} mm past the bed.`;
    case "overhang":
      return `Overhang is ${measured}°. This printer holds up to ${finding.limit}°.`;
  }
}
