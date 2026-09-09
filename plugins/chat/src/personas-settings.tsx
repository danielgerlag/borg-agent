import type { ModelDescriptor, Persona } from "@borg/contracts";
import { Button, Panel } from "@borg/ui-kit";
import type { PluginUiContext } from "@borg/plugin-sdk";
import { Plus, Star, Trash2 } from "lucide-solid";
import { For, Show, createSignal, onMount, type Component } from "solid-js";
import {
  displayModelName,
  displayProviderName,
  matchesModelPreference,
} from "./model-preference";

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function resolvePreferenceLabel(
  preference: string,
  models: readonly ModelDescriptor[],
): string {
  const match = models.find((model) =>
    matchesModelPreference(model, preference),
  );
  return match ? displayModelName(match) : preference;
}

function groupModelsByProvider(
  models: readonly ModelDescriptor[],
): readonly (readonly [string, ModelDescriptor[]])[] {
  const groups = new Map<string, ModelDescriptor[]>();
  for (const model of models) {
    const list = groups.get(model.providerId) ?? [];
    list.push(model);
    groups.set(model.providerId, list);
  }
  return [...groups.entries()];
}

export function createPersonasSettings(
  context: PluginUiContext<Component>,
): Component {
  return () => {
    const [personas, setPersonas] = createSignal<readonly Persona[]>([]);
    const [models, setModels] = createSignal<readonly ModelDescriptor[]>([]);
    const [defaultId, setDefaultId] = createSignal("");
    const [selectedId, setSelectedId] = createSignal("");
    const [name, setName] = createSignal("");
    const [description, setDescription] = createSignal("");
    const [instructions, setInstructions] = createSignal("");
    const [preferredModels, setPreferredModels] = createSignal<string[]>([]);
    const [loopStrategy, setLoopStrategy] = createSignal<"react" | "code-act">(
      "react",
    );
    const [addModelId, setAddModelId] = createSignal("");
    const [status, setStatus] = createSignal("");
    const [error, setError] = createSignal<string>();
    const [busy, setBusy] = createSignal(false);
    const [creating, setCreating] = createSignal(false);
    const [newName, setNewName] = createSignal("");
    const [newInstructions, setNewInstructions] = createSignal("");

    const selected = (): Persona | undefined =>
      personas().find(({ id }) => id === selectedId());

    const unusedModels = (): readonly ModelDescriptor[] =>
      models().filter(
        (model) =>
          !preferredModels().some((preference) =>
            matchesModelPreference(model, preference),
          ),
      );

    const primaryModelValue = (): string => {
      const connected = preferredModels()
        .map((preference) =>
          models().find((model) => matchesModelPreference(model, preference)),
        )
        .find((model) => model !== undefined);
      return connected?.preferenceId ?? preferredModels()[0] ?? "";
    };

    const refreshModels = async (): Promise<void> => {
      setModels(await context.models.list());
    };

    const loadDraft = (persona: Persona): void => {
      setSelectedId(persona.id);
      setName(persona.name);
      setDescription(persona.description ?? "");
      setInstructions(persona.instructions);
      setPreferredModels([...persona.preferredModels]);
      setLoopStrategy(persona.loopStrategy);
      setCreating(false);
    };

    const reload = async (selectId?: string): Promise<void> => {
      const [available, current, availableModels] = await Promise.all([
        context.personas.list(),
        context.personas.getDefault(),
        context.models.list(),
      ]);
      setPersonas(available);
      setModels(availableModels);
      setDefaultId(current.id);
      const next =
        available.find(({ id }) => id === selectId) ??
        available.find(({ id }) => id === selectedId()) ??
        current;
      loadDraft(next);
    };

    onMount(() => {
      void reload().catch((failure: unknown) => setError(describeError(failure)));
    });

    const persistPreferredModels = async (
      next: readonly string[],
    ): Promise<void> => {
      const persona = selected();
      if (!persona || next.length === 0) {
        return;
      }
      const previous = preferredModels();
      setPreferredModels([...next]);
      setError(undefined);
      try {
        const updated = await context.personas.update(persona.id, {
          preferredModels: [...next],
        });
        setPersonas((current) =>
          current.map((item) => (item.id === updated.id ? updated : item)),
        );
      } catch (failure) {
        setPreferredModels(previous);
        setError(describeError(failure));
      }
    };

    const save = async (): Promise<void> => {
      const persona = selected();
      if (!persona) {
        return;
      }
      if (!name().trim() || !instructions().trim()) {
        setError("Name and instructions are required.");
        return;
      }
      setBusy(true);
      setError(undefined);
      try {
        await context.personas.update(persona.id, {
          name: name().trim(),
          description: description().trim() || undefined,
          instructions: instructions().trim(),
          loopStrategy: loopStrategy(),
        });
        await reload(persona.id);
        setStatus(`Saved ${name().trim()}.`);
      } catch (failure) {
        setError(describeError(failure));
      } finally {
        setBusy(false);
      }
    };

    const setAsDefault = async (): Promise<void> => {
      const persona = selected();
      if (!persona) {
        return;
      }
      setBusy(true);
      setError(undefined);
      try {
        await context.personas.setDefault(persona.id);
        setDefaultId(persona.id);
        setStatus(`${persona.name} is the default for new chats.`);
      } catch (failure) {
        setError(describeError(failure));
      } finally {
        setBusy(false);
      }
    };

    const createPersona = async (): Promise<void> => {
      const slug = slugify(newName());
      if (!slug || !newInstructions().trim()) {
        setError("Name and instructions are required.");
        return;
      }
      const preferred =
        preferredModels()[0] ??
        selected()?.preferredModels[0] ??
        models()[0]?.preferenceId;
      if (!preferred) {
        setError("Connect a model provider before creating a persona.");
        return;
      }
      setBusy(true);
      setError(undefined);
      try {
        const persona = await context.personas.create({
          id: `user/${slug}`,
          name: newName().trim(),
          instructions: newInstructions().trim(),
          preferredModels: [preferred],
          secondaryModels: [],
          allowedTools: ["*"],
          mcpServers: [],
          loopStrategy: "react",
          toolExecutionMode: "sequential-partial",
          skillIds: [],
          contextMapStrategy: "general",
          archived: false,
        });
        await context.personas.setDefault(persona.id);
        setNewName("");
        setNewInstructions("");
        setCreating(false);
        await reload(persona.id);
        setStatus(`${persona.name} is the default for new chats.`);
      } catch (failure) {
        setError(describeError(failure));
      } finally {
        setBusy(false);
      }
    };

    const archivePersona = async (): Promise<void> => {
      const persona = selected();
      if (!persona || persona.bundled) {
        return;
      }
      setBusy(true);
      setError(undefined);
      try {
        await context.personas.update(persona.id, { archived: true });
        await reload();
        setStatus(`Archived ${persona.name}.`);
      } catch (failure) {
        setError(describeError(failure));
      } finally {
        setBusy(false);
      }
    };

    const setPrimaryModel = (preferenceId: string): void => {
      if (!preferenceId) {
        return;
      }
      void persistPreferredModels([
        preferenceId,
        ...preferredModels().filter((preference) => preference !== preferenceId),
      ]);
    };

    const addPreferredModel = (preferenceId: string): void => {
      if (!preferenceId || preferredModels().includes(preferenceId)) {
        setAddModelId("");
        return;
      }
      setAddModelId("");
      void persistPreferredModels([...preferredModels(), preferenceId]);
    };

    const removePreferredModel = (preferenceId: string): void => {
      if (preferredModels().length === 1) {
        return;
      }
      void persistPreferredModels(
        preferredModels().filter((item) => item !== preferenceId),
      );
    };

    const movePreferredModel = (index: number, direction: -1 | 1): void => {
      const current = [...preferredModels()];
      const swap = index + direction;
      if (swap < 0 || swap >= current.length) {
        return;
      }
      const left = current[index];
      const right = current[swap];
      if (left === undefined || right === undefined) {
        return;
      }
      current[index] = right;
      current[swap] = left;
      void persistPreferredModels(current);
    };

    return (
      <section data-testid="personas-settings-page">
        <p class="text-sm text-[var(--text-muted)]">
          A persona is who Borg acts as. Chat, bots, and graphs use the default
          persona. Models belong to the persona.
        </p>

        <div class="mt-5 flex flex-wrap gap-2">
          <For each={personas()}>
            {(persona) => (
              <button
                type="button"
                class="rounded-xl border px-3 py-2 text-left text-sm"
                classList={{
                  "border-[var(--accent)] bg-[var(--accent)]/12 text-[var(--accent)]":
                    persona.id === selectedId(),
                  "border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]":
                    persona.id !== selectedId(),
                }}
                aria-current={persona.id === selectedId() ? "true" : undefined}
                data-testid={`persona-row-${persona.id}`}
                onClick={() => loadDraft(persona)}
              >
                <span class="font-medium">{persona.name}</span>
                <Show when={persona.id === defaultId()}>
                  <span class="ml-2 text-xs">Default</span>
                </Show>
              </button>
            )}
          </For>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={busy()}
            data-testid="persona-new"
            onClick={() => {
              setCreating(true);
              setError(undefined);
              setStatus("");
            }}
          >
            <Plus aria-hidden="true" size={14} />
            New persona
          </Button>
        </div>

        <Show when={creating()}>
          <Panel class="mt-5" data-testid="persona-create-form">
            <p class="text-sm font-semibold">New persona</p>
            <input
              value={newName()}
              onInput={(event) => setNewName(event.currentTarget.value)}
              class="mt-3 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm"
              placeholder="Name"
              data-testid="settings-persona-name"
            />
            <textarea
              value={newInstructions()}
              onInput={(event) =>
                setNewInstructions(event.currentTarget.value)
              }
              class="mt-3 min-h-28 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm"
              placeholder="Instructions. This is who the persona is and how it should work."
              data-testid="settings-persona-instructions"
            />
            <div class="mt-3 flex gap-2">
              <Button
                type="button"
                disabled={busy()}
                data-testid="settings-persona-create"
                onClick={() => void createPersona()}
              >
                Create and use
              </Button>
              <Button
                type="button"
                variant="ghost"
                disabled={busy()}
                onClick={() => setCreating(false)}
              >
                Cancel
              </Button>
            </div>
          </Panel>
        </Show>

        <Show when={!creating() && selected()}>
          {(persona) => (
            <Panel class="mt-5" data-testid="persona-editor">
              <div class="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p class="font-mono text-xs text-[var(--text-muted)]">
                    {persona().id}
                  </p>
                  <Show when={persona().bundled}>
                    <p class="mt-1 text-xs text-[var(--text-muted)]">
                      Built-in. You can edit it. You cannot archive it.
                    </p>
                  </Show>
                </div>
                <div class="flex flex-wrap gap-2">
                  <Show when={persona().id !== defaultId()}>
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      disabled={busy()}
                      data-testid="persona-set-default"
                      onClick={() => void setAsDefault()}
                    >
                      <Star aria-hidden="true" size={14} />
                      Use for new chats
                    </Button>
                  </Show>
                  <Show when={!persona().bundled}>
                    <Button
                      type="button"
                      variant="danger"
                      size="sm"
                      disabled={busy()}
                      data-testid="persona-archive"
                      onClick={() => void archivePersona()}
                    >
                      <Trash2 aria-hidden="true" size={14} />
                      Archive
                    </Button>
                  </Show>
                </div>
              </div>

              <label class="mt-4 block text-sm text-[var(--text-muted)]">
                Name
                <input
                  value={name()}
                  onInput={(event) => setName(event.currentTarget.value)}
                  class="mt-2 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--text)]"
                  data-testid="persona-name"
                />
              </label>
              <label class="mt-4 block text-sm text-[var(--text-muted)]">
                Description
                <input
                  value={description()}
                  onInput={(event) => setDescription(event.currentTarget.value)}
                  class="mt-2 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--text)]"
                  data-testid="persona-description"
                />
              </label>
              <label class="mt-4 block text-sm text-[var(--text-muted)]">
                Instructions
                <textarea
                  value={instructions()}
                  onInput={(event) =>
                    setInstructions(event.currentTarget.value)
                  }
                  class="mt-2 min-h-36 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--text)]"
                  data-testid="persona-instructions"
                />
              </label>

              <label class="mt-4 block text-sm text-[var(--text-muted)]">
                Loop
                <select
                  value={loopStrategy()}
                  onChange={(event) =>
                    setLoopStrategy(
                      event.currentTarget.value === "code-act"
                        ? "code-act"
                        : "react",
                    )
                  }
                  class="mt-2 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--text)]"
                  data-testid="persona-loop-strategy"
                >
                  <option value="react">ReAct. Think, then use tools.</option>
                  <option value="code-act">
                    CodeAct. Write and run code to act.
                  </option>
                </select>
              </label>

              <div class="mt-5">
                <p class="text-sm font-medium">Preferred models</p>
                <p class="mt-1 text-xs text-[var(--text-muted)]">
                  First connected match wins.
                </p>
                <label class="mt-3 block text-sm text-[var(--text-muted)]">
                  Primary model
                  <select
                    value={primaryModelValue()}
                    onFocus={() => {
                      void refreshModels();
                    }}
                    onChange={(event) => {
                      setPrimaryModel(event.currentTarget.value);
                    }}
                    class="mt-2 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--text)]"
                    data-testid="persona-primary-model"
                  >
                    <For each={groupModelsByProvider(models())}>
                      {([providerId, group]) => (
                        <optgroup label={displayProviderName(providerId)}>
                          <For each={group}>
                            {(model) => (
                              <option value={model.preferenceId}>
                                {displayModelName(model)}
                              </option>
                            )}
                          </For>
                        </optgroup>
                      )}
                    </For>
                  </select>
                </label>
                <div class="mt-3 grid gap-2">
                  <For
                    each={preferredModels()}
                    fallback={
                      <p class="text-sm text-[var(--danger)]">
                        Add a connected model or this persona cannot run.
                      </p>
                    }
                  >
                    {(preference, index) => (
                      <div
                        class="flex items-center gap-2 rounded-xl border border-[var(--border)] px-3 py-2"
                        data-testid={`persona-preferred-${preference}`}
                      >
                        <p class="min-w-0 flex-1 text-sm">
                          <Show when={index() === 0}>
                            <span class="mr-2 text-xs font-semibold text-[var(--accent)]">
                              Primary
                            </span>
                          </Show>
                          {resolvePreferenceLabel(preference, models())}
                        </p>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={index() === 0}
                          onClick={() => movePreferredModel(index(), -1)}
                        >
                          Up
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={index() === preferredModels().length - 1}
                          onClick={() => movePreferredModel(index(), 1)}
                        >
                          Down
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={preferredModels().length === 1}
                          onClick={() => removePreferredModel(preference)}
                        >
                          Remove
                        </Button>
                      </div>
                    )}
                  </For>
                </div>
                <label class="mt-3 block text-sm text-[var(--text-muted)]">
                  Add a connected model
                  <select
                    value={addModelId()}
                    onFocus={() => {
                      void refreshModels();
                    }}
                    onChange={(event) => {
                      addPreferredModel(event.currentTarget.value);
                    }}
                    class="mt-2 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--text)]"
                    data-testid="persona-add-model"
                  >
                    <option value="">Select a model</option>
                    <For each={groupModelsByProvider(unusedModels())}>
                      {([providerId, group]) => (
                        <optgroup label={displayProviderName(providerId)}>
                          <For each={group}>
                            {(model) => (
                              <option value={model.preferenceId}>
                                {displayModelName(model)}
                              </option>
                            )}
                          </For>
                        </optgroup>
                      )}
                    </For>
                  </select>
                </label>
              </div>

              <div class="mt-5">
                <Button
                  type="button"
                  disabled={busy()}
                  data-testid="persona-save"
                  onClick={() => void save()}
                >
                  Save persona
                </Button>
              </div>
            </Panel>
          )}
        </Show>

        <Show when={error()}>
          <p class="mt-4 text-sm text-[var(--danger)]" data-testid="persona-error">
            {error()}
          </p>
        </Show>
        <Show when={status() && !error()}>
          <p class="mt-4 text-xs text-[var(--text-muted)]">{status()}</p>
        </Show>
      </section>
    );
  };
}
