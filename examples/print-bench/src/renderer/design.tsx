import { Button, TextField } from "@borg/ui-kit";
import { For, Show, createSignal } from "solid-js";
import {
  addToolId,
  deleteToolId,
  promptToolId,
  selectToolId,
  transformToolId,
  type Primitive,
} from "../contract.js";
import type { Body } from "../domain.js";
import type { BenchAnswer, BenchInteraction } from "./bridge.js";
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

export function DesignView(
  props: BenchControl & {
    readonly pending: BenchInteraction | null;
    onAnswer(response: BenchAnswer): void;
  },
) {
  const [mode, setMode] = createSignal<Mode>("translate");
  const [prompt, setPrompt] = createSignal("");
  const [heldId, setHeldId] = createSignal<string | null>(null);
  const allowed = (toolId: string): boolean => props.snapshot.persona.allowedTools.includes(toolId);
  const question = (): BenchInteraction | undefined =>
    props.pending?.kind === "human_input" ? props.pending : undefined;
  const holding = (): boolean => heldId() !== null && heldId() === question()?.id;
  const lock = (): boolean => {
    if (question()?.form === "text" && !holding()) {
      return false;
    }
    return props.busy || !allowed(promptToolId) || holding();
  };
  const selected = (): Body | undefined =>
    props.snapshot.scene.bodies.find((body) => body.id === props.snapshot.scene.selectedId);
  const replace = (body: Body): void => {
    if (!allowed(transformToolId)) {
      return;
    }
    props.run({ tool: transformToolId, body });
  };
  return (
    <section class="grid h-full min-h-0 grid-cols-1 lg:grid-cols-[9rem_minmax(0,1fr)_18rem]">
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
      <div class="grid min-h-0 grid-rows-[auto_minmax(0,1fr)_auto]">
        <header class="border-b border-[var(--border)] px-5 py-3">
          <h1 class="text-xl font-semibold">Model</h1>
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
            <Show when={question()}>
              {(item) => (
                <div data-testid="print-bench-question" class="grid gap-2">
                  <p>
                    <span class="mr-2 text-xs uppercase tracking-[0.14em] text-[var(--text-subtle)]">Designer</span>
                    {item().prompt}
                  </p>
                  <Show when={item().form === "choice" ? item().choices : undefined}>
                    {(choices) => (
                      <div class="flex flex-wrap gap-2">
                        <For each={choices()}>
                          {(choice) => (
                            <Button
                              variant="secondary"
                              data-testid={`print-bench-choice-${choice.id}`}
                              disabled={holding()}
                              onClick={() => {
                                setHeldId(item().id);
                                props.onAnswer({ kind: "choice", choiceId: choice.id });
                              }}
                            >
                              {choice.label}
                            </Button>
                          )}
                        </For>
                      </div>
                    )}
                  </Show>
                  <Show when={item().form === "confirm"}>
                    <div class="flex gap-2">
                      <Button
                        data-testid="print-bench-confirm-yes"
                        disabled={holding()}
                        onClick={() => {
                          setHeldId(item().id);
                          props.onAnswer({ kind: "confirm", confirmed: true });
                        }}
                      >
                        Yes
                      </Button>
                      <Button
                        variant="secondary"
                        data-testid="print-bench-confirm-no"
                        disabled={holding()}
                        onClick={() => {
                          setHeldId(item().id);
                          props.onAnswer({ kind: "confirm", confirmed: false });
                        }}
                      >
                        No
                      </Button>
                    </div>
                  </Show>
                </div>
              )}
            </Show>
            <Show when={props.busy && !question()}>
              <p data-testid="print-bench-working" class="text-[var(--text-muted)]">Designer is working.</p>
            </Show>
          </div>
          <form
            class="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const text = prompt().trim();
              const current = question();
              if (current?.form === "text") {
                if (text.length === 0 || holding()) {
                  return;
                }
                setHeldId(current.id);
                setPrompt("");
                props.onAnswer({ kind: "text", text });
                return;
              }
              if (text.length === 0 || props.busy || !allowed(promptToolId)) {
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
              placeholder={question()?.form === "text" ? "Your answer" : "Tell the designer what to change"}
              aria-label="Prompt"
              data-testid="print-bench-prompt"
              disabled={lock()}
            />
            <Button type="submit" data-testid="print-bench-build" disabled={lock()}>
              {question()?.form === "text" ? "Answer" : "Send"}
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
  );
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
