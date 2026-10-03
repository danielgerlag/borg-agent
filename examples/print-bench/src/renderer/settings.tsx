import { Panel, Select } from "@borg/ui-kit";
import { z } from "@borg-agent/plugin-sdk";
import { createEffect, createSignal, For, onCleanup, Show } from "solid-js";
import { SHOP } from "../domain.js";
import {
  designerPersonaId,
  frontDeskPersonaId,
  operatorPersonaId,
  preferModelToolId,
  usePersonaToolId,
} from "../contract.js";
import { benchApi } from "./bridge.js";
import type { BenchControl } from "./control.js";
import { ProviderScreens } from "./provider-setup.js";

type Section = "machine" | "seats" | "model";

const sections: readonly { id: Section; label: string }[] = [
  { id: "machine", label: "Machine" },
  { id: "seats", label: "Seats" },
  { id: "model", label: "Model" },
];

const modelListSchema = z.array(
  z
    .object({
      providerId: z.string().min(1),
      modelId: z.string().min(1),
      preferenceId: z.string().min(1),
    })
    .strict(),
);

const providerLabels: Readonly<Record<string, string>> = {
  "borg.anthropic": "Anthropic",
  "borg.azure": "Azure",
  "borg.copilot": "Copilot",
  "borg.mock-llm": "Demo",
  "borg.ollama": "Ollama",
  "borg.openai": "OpenAI",
  "borg.openrouter": "OpenRouter",
};

const modelLabels: Readonly<Record<string, string>> = {
  "mock:scripted": "Built-in demo model",
  "claude-sonnet-5": "Claude Sonnet 5",
  "claude-haiku-4-5": "Claude Haiku 4.5",
  "claude-opus-5": "Claude Opus 5",
  "gpt-5-mini": "GPT-5 Mini",
  "gpt-5-nano": "GPT-5 Nano",
  "gpt-5": "GPT-5",
};

function modelLabel(providerId: string, modelId: string): string {
  const provider = providerLabels[providerId] ?? providerId.replace(/^borg\./, "");
  const model = modelLabels[modelId] ?? modelId;
  return `${provider} · ${model}`;
}

function sameCatalog(
  left: readonly { readonly preferenceId: string }[],
  right: readonly { readonly preferenceId: string }[],
): boolean {
  return (
    left.length === right.length &&
    left.every((model, index) => model.preferenceId === right[index]?.preferenceId)
  );
}

const seatTools: Record<string, readonly string[]> = {
  [designerPersonaId]: [
    "Add a box, cylinder, sphere, or cone",
    "Move, rotate, and scale the selection",
    "Delete the selection",
    "Talk to the designer. It calls tools to change the model, and asks when a size is missing",
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
  const [models, setModels] = createSignal<z.output<typeof modelListSchema>>([]);
  const [modelError, setModelError] = createSignal<string | undefined>();
  let menuOpen = false;
  let catalogStopped = false;

  const pullModels = (): void => {
    // A replaced option list closes the open menu, so leave it alone until it closes.
    if (menuOpen || catalogStopped) {
      return;
    }
    void benchApi()
      .provider.call({ method: "models.list" })
      .then((value) => {
        if (menuOpen || catalogStopped) {
          return;
        }
        const next = modelListSchema.parse(value);
        setModels((current) => (sameCatalog(current, next) ? current : next));
        setModelError(undefined);
      })
      .catch((caught: unknown) => {
        if (!catalogStopped) {
          setModelError(caught instanceof Error ? caught.message : String(caught));
        }
      });
  };

  createEffect(() => {
    if (props.section !== "model") {
      return;
    }
    catalogStopped = false;
    pullModels();
    const timer = setInterval(pullModels, 500);
    onCleanup(() => {
      catalogStopped = true;
      clearInterval(timer);
    });
  });

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
              Connect a provider, then choose that model for the designer. It changes the solid by calling tools, and it asks when a size or a count is missing. The built-in demo answers in text and does not change the solid. The palette calls the same tools without a model.
            </p>
            <Select
              label="Designer model"
              aria-label="Designer model"
              data-testid="print-bench-model"
              placeholder="Choose a model"
              value={props.snapshot.designerModel ?? ""}
              options={models().map((model) => ({
                value: model.preferenceId,
                label: modelLabel(model.providerId, model.modelId),
              }))}
              onChange={(preferenceId) => {
                if (preferenceId === (props.snapshot.designerModel ?? "")) {
                  return;
                }
                props.run({ tool: preferModelToolId, preferenceId });
              }}
              onOpenChange={(open) => {
                menuOpen = open;
                if (!open) {
                  pullModels();
                }
              }}
              disabled={props.busy}
            />
            <Show when={modelError()}>
              {(message) => <p class="mt-3 text-sm text-[var(--danger)]">{message()}</p>}
            </Show>
            <ProviderScreens />
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
