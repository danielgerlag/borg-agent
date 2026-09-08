import type { ModelDescriptor, Persona } from "@borg/contracts";
import type { PluginUiContext } from "@borg/plugin-sdk";
import { UserRoundCog } from "lucide-solid";
import { For, createSignal, onMount, type Component } from "solid-js";
import { displayModelName, matchesModelPreference } from "./model-preference";

export function createPersonaWizardStep(
  context: PluginUiContext<Component>,
  setPersonaReady: (ready: boolean) => void,
): Component {
  return () => {
    const [personas, setPersonas] = createSignal<readonly Persona[]>([]);
    const [models, setModels] = createSignal<readonly ModelDescriptor[]>([]);
    const [selected, setSelected] = createSignal("");
    const [selectedModel, setSelectedModel] = createSignal("");
    const [status, setStatus] = createSignal("Loading personas…");

    const ensureAvailableModel = async (
      persona: Persona,
      availableModels: readonly ModelDescriptor[],
    ): Promise<string | undefined> => {
      const configured = persona.preferredModels
        .map((preference) =>
          availableModels.find((model) =>
            matchesModelPreference(model, preference),
          ),
        )
        .find((model) => model !== undefined);
      const fallback = availableModels[0]?.preferenceId;
      if (!configured && fallback) {
        await context.personas.update(persona.id, {
          preferredModels: [
            fallback,
            ...persona.preferredModels.filter(
              (preference) => preference !== fallback,
            ),
          ],
        });
      }
      return configured?.preferenceId ?? fallback;
    };

    const load = async (): Promise<void> => {
      const [available, current, availableModels] = await Promise.all([
        context.personas.list(),
        context.personas.getDefault(),
        context.models.list(),
      ]);
      setPersonas(available);
      setModels(availableModels);
      setSelected(current.id);
      const model = await ensureAvailableModel(current, availableModels);
      setSelectedModel(model ?? "");
      setPersonaReady(model !== undefined);
      setStatus(
        model
          ? "This persona will be used for new chats."
          : "This persona needs a connected model.",
      );
    };

    onMount(() => {
      void load().catch((error: unknown) => {
        setPersonaReady(false);
        setStatus(error instanceof Error ? error.message : String(error));
      });
    });

    const choose = async (personaId: string): Promise<void> => {
      setSelected(personaId);
      setStatus("Saving…");
      try {
        await context.personas.setDefault(personaId);
        const persona = await context.personas.get(personaId);
        const model = persona
          ? await ensureAvailableModel(persona, models())
          : undefined;
        setSelectedModel(model ?? "");
        setPersonaReady(model !== undefined);
        setStatus("Default persona saved");
      } catch (error) {
        setPersonaReady(false);
        setStatus(error instanceof Error ? error.message : String(error));
      }
    };

    const chooseModel = async (preferenceId: string): Promise<void> => {
      if (!preferenceId || !selected()) {
        setPersonaReady(false);
        return;
      }
      setSelectedModel(preferenceId);
      setStatus("Saving model…");
      try {
        const persona = await context.personas.get(selected());
        if (!persona) {
          throw new Error("Selected persona is unavailable");
        }
        await context.personas.update(persona.id, {
          preferredModels: [
            preferenceId,
            ...persona.preferredModels.filter(
              (preference) => preference !== preferenceId,
            ),
          ],
        });
        setPersonaReady(true);
        setStatus("Preferred model saved on this persona");
      } catch (error) {
        setPersonaReady(false);
        setStatus(error instanceof Error ? error.message : String(error));
      }
    };

    return (
      <section data-testid="wizard-persona-step">
        <div class="flex items-center gap-3">
          <UserRoundCog
            aria-hidden="true"
            size={20}
            class="text-[var(--accent)]"
          />
          <div>
            <h3 class="text-xl font-semibold">Choose a persona</h3>
            <p class="mt-1 text-sm text-[var(--text-muted)]">
              A persona is who Borg is: instructions, preferred models, and
              tools. New chats use the default persona.
            </p>
          </div>
        </div>
        <label class="mt-5 block text-sm text-[var(--text-muted)]">
          Persona
          <select
            value={selected()}
            onChange={(event) => void choose(event.currentTarget.value)}
            class="mt-2 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2"
            data-testid="wizard-persona-select"
          >
            <For each={personas()}>
              {(persona) => (
                <option value={persona.id}>{persona.name}</option>
              )}
            </For>
          </select>
        </label>
        <label class="mt-4 block text-sm text-[var(--text-muted)]">
          Preferred model for this persona
          <select
            value={selectedModel()}
            onFocus={() => void load()}
            onChange={(event) => void chooseModel(event.currentTarget.value)}
            class="mt-2 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2"
            data-testid="wizard-model-select"
          >
            <For each={models()}>
              {(model) => (
                <option value={model.preferenceId}>
                  {displayModelName(model)}
                </option>
              )}
            </For>
          </select>
        </label>
        <p class="mt-3 text-xs text-[var(--text-muted)]">{status()}</p>
      </section>
    );
  };
}
