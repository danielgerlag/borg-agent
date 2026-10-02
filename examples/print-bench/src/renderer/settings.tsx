import { Panel, Select } from "@borg/ui-kit";
import { For, Show } from "solid-js";
import { SHOP } from "../domain.js";
import {
  designerPersonaId,
  frontDeskPersonaId,
  operatorPersonaId,
  usePersonaToolId,
} from "../contract.js";
import type { BenchControl } from "./control.js";

type Section = "machine" | "seats" | "model";

const sections: readonly { id: Section; label: string }[] = [
  { id: "machine", label: "Machine" },
  { id: "seats", label: "Seats" },
  { id: "model", label: "Model" },
];

const seatTools: Record<string, readonly string[]> = {
  [designerPersonaId]: [
    "Add a box, cylinder, sphere, or cone",
    "Move, rotate, and scale the selection",
    "Delete the selection",
    "Talk to the designer. It draws a gear or a solid, and asks when a size is missing",
    "Change seat",
  ],
  [frontDeskPersonaId]: ["Send the quote", "Change seat"],
  [operatorPersonaId]: ["Start the printer", "Change seat"],
};

export function SettingsView(
  props: BenchControl & {
    readonly section: Section;
    onSection(section: Section): void;
  },
) {
  const allowed = () => props.snapshot.persona.allowedTools.includes(usePersonaToolId);
  return (
    <section
      class="grid h-full min-h-0 grid-cols-1 lg:grid-cols-[15rem_minmax(0,1fr)]"
      data-testid="surface-settings"
    >
      <aside class="min-h-0 overflow-y-auto border-b border-[var(--border)] bg-[var(--panel)] p-5 lg:border-r lg:border-b-0">
        <p class="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--text-subtle)]">Settings</p>
        <h1 class="mt-2 text-2xl font-semibold">Shop</h1>
        <nav class="mt-7 grid gap-1" aria-label="Settings sections">
          <For each={sections}>
            {(section) => (
              <button
                type="button"
                class="rounded-xl px-3 py-2.5 text-left text-sm transition"
                classList={{
                  "bg-[var(--accent)]/12 text-[var(--accent)]": props.section === section.id,
                  "text-[var(--text-muted)] hover:bg-[var(--panel-muted)] hover:text-[var(--text)]":
                    props.section !== section.id,
                }}
                data-testid={`settings-section-${section.id}`}
                onClick={() => props.onSection(section.id)}
              >
                {section.label}
              </button>
            )}
          </For>
        </nav>
      </aside>
      <div class="min-h-0 overflow-y-auto p-8" data-testid="settings-page">
        <div class="mx-auto max-w-3xl">
          <Show when={props.section === "machine"}>
            <h2 class="mb-2 text-2xl font-semibold">Machine</h2>
            <p class="mb-5 text-sm text-[var(--text-muted)]">
              The inspector uses these numbers. The model cannot change them.
            </p>
            <Panel>
              <dl class="grid gap-3 text-sm">
                <Row label="Printer" value="Prusa MK4" />
                <Row label="Material" value="PETG" />
                <Row
                  label="Bed"
                  value={`${SHOP.bedMm.x} × ${SHOP.bedMm.y} × ${SHOP.bedMm.z} mm`}
                />
                <Row label="Minimum wall" value={`${SHOP.minWallMm} mm`} />
                <Row label="Maximum overhang" value={`${SHOP.maxOverhangDeg}°`} />
                <Row label="Density" value={`${SHOP.densityGPerCm3} g/cm³`} />
                <Row label="Print rate" value={`${SHOP.gramsPerHour} g/hour`} />
                <Row
                  label="Price"
                  value={`${SHOP.usdPerGram} USD/g and ${SHOP.usdPerHour} USD/hour`}
                />
              </dl>
            </Panel>
          </Show>
          <Show when={props.section === "seats"}>
            <h2 class="mb-2 text-2xl font-semibold">Seats</h2>
            <p class="mb-5 text-sm text-[var(--text-muted)]">
              The seat decides which tools can run. Design, Quote, and Printer stay where they are.
            </p>
            <Select
              label="Seat"
              aria-label="Seat"
              data-testid="print-bench-persona"
              value={props.snapshot.persona.id}
              options={props.snapshot.personas.map((seat) => ({
                value: seat.id,
                label: seat.name,
              }))}
              onChange={(personaId) => {
                if (personaId === props.snapshot.persona.id) {
                  return;
                }
                props.run({ tool: usePersonaToolId, personaId });
              }}
              disabled={props.busy || !allowed()}
            />
            <ul class="mt-5 grid gap-2 text-sm">
              <For each={seatTools[props.snapshot.persona.id] ?? []}>
                {(tool) => <li>{tool}</li>}
              </For>
            </ul>
          </Show>
          <Show when={props.section === "model"}>
            <h2 class="mb-2 text-2xl font-semibold">Model</h2>
            <p class="mb-5 text-sm text-[var(--text-muted)]">
              Send on Design starts a designer turn on this model. It can draw a gear, or add, move, and delete solids, and it asks when a size is missing. The palette calls the same solid tools without the model.
            </p>
            <Panel>
              <dl class="grid gap-3 text-sm">
                <Row label="Provider" value="example.print-bench" />
                <Row label="Model" value="scripted" />
                <Row label="Tools it may call" value="Add, move, delete, and ask" />
              </dl>
            </Panel>
          </Show>
        </div>
      </div>
    </section>
  );
}

function Row(props: { label: string; value: string }) {
  return (
    <div class="grid grid-cols-[10rem_minmax(0,1fr)] gap-3">
      <dt class="text-[var(--text-muted)]">{props.label}</dt>
      <dd>{props.value}</dd>
    </div>
  );
}
