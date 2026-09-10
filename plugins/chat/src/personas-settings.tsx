import type { ModelDescriptor, Persona, Skill } from "@borg/contracts";
import { Button, Checkbox, Panel, Select, TextField } from "@borg/ui-kit";
import type { PluginUiContext } from "@borg/plugin-sdk";
import { Plus, Star, Trash2 } from "lucide-solid";
import {
  For,
  Index,
  Show,
  createSignal,
  onMount,
  type Component,
} from "solid-js";
import {
  PERSONA_COLOR_PRESETS,
  PersonaMark,
} from "./persona-mark";
import {
  displayModelName,
  displayProviderName,
  matchesModelPreference,
} from "./model-preference";

type PromptTemplate = Persona["promptTemplates"][number];

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
    const [secondaryModels, setSecondaryModels] = createSignal<string[]>([]);
    const [avatar, setAvatar] = createSignal("");
    const [color, setColor] = createSignal("");
    const [promptTemplates, setPromptTemplates] = createSignal<
      PromptTemplate[]
    >([]);
    const [loopStrategy, setLoopStrategy] = createSignal<"react" | "code-act">(
      "react",
    );
    const [skillIds, setSkillIds] = createSignal<string[]>([]);
    const [catalogSkills, setCatalogSkills] = createSignal<readonly Skill[]>([]);
    const [allowAllTools, setAllowAllTools] = createSignal(true);
    const [allowedPatterns, setAllowedPatterns] = createSignal("");
    const [contextMapStrategy, setContextMapStrategy] = createSignal<
      "general" | "code" | "advanced"
    >("general");
    const [newSkillName, setNewSkillName] = createSignal("");
    const [newSkillInstructions, setNewSkillInstructions] = createSignal("");
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

    const unusedSecondaryModels = (): readonly ModelDescriptor[] =>
      models().filter(
        (model) =>
          !secondaryModels().some((preference) =>
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
      setSecondaryModels([...persona.secondaryModels]);
      setAvatar(persona.avatar ?? "");
      setColor(persona.color ?? "");
      setPromptTemplates(
        persona.promptTemplates.map((template) => ({ ...template })),
      );
      setLoopStrategy(persona.loopStrategy);
      setSkillIds([...persona.skillIds]);
      setAllowAllTools(persona.allowedTools.includes("*"));
      setAllowedPatterns(
        persona.allowedTools.filter((pattern) => pattern !== "*").join("\n"),
      );
      setContextMapStrategy(persona.contextMapStrategy ?? "general");
      setCreating(false);
    };

    const reload = async (selectId?: string): Promise<void> => {
      const [available, current, availableModels, availableSkills] =
        await Promise.all([
          context.personas.list(),
          context.personas.getDefault(),
          context.models.list(),
          context.skills.list(),
        ]);
      setPersonas(available);
      setModels(availableModels);
      setCatalogSkills(availableSkills);
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

    const persistSecondaryModels = async (
      next: readonly string[],
    ): Promise<void> => {
      const persona = selected();
      if (!persona) {
        return;
      }
      const previous = secondaryModels();
      setSecondaryModels([...next]);
      setError(undefined);
      try {
        const updated = await context.personas.update(persona.id, {
          secondaryModels: [...next],
        });
        setPersonas((current) =>
          current.map((item) => (item.id === updated.id ? updated : item)),
        );
      } catch (failure) {
        setSecondaryModels(previous);
        setError(describeError(failure));
      }
    };

    const addSecondaryModel = (preferenceId: string): void => {
      if (
        !preferenceId ||
        secondaryModels().some((preference) => preference === preferenceId)
      ) {
        return;
      }
      void persistSecondaryModels([...secondaryModels(), preferenceId]);
    };

    const removeSecondaryModel = (preferenceId: string): void => {
      void persistSecondaryModels(
        secondaryModels().filter((preference) => preference !== preferenceId),
      );
    };

    const toggleSkill = (skillId: string, attached: boolean): void => {
      setSkillIds((current) =>
        attached
          ? current.includes(skillId)
            ? current
            : [...current, skillId]
          : current.filter((id) => id !== skillId),
      );
    };

    const createSkill = async (): Promise<void> => {
      const slug = slugify(newSkillName());
      if (!slug || !newSkillInstructions().trim()) {
        setError("Skill name and instructions are required.");
        return;
      }
      setBusy(true);
      setError(undefined);
      try {
        const skill = await context.skills.create({
          id: `user/${slug}`,
          name: newSkillName().trim(),
          instructions: newSkillInstructions().trim(),
        });
        setCatalogSkills((current) =>
          [...current, skill].sort((left, right) =>
            left.name.localeCompare(right.name),
          ),
        );
        setSkillIds((current) =>
          current.includes(skill.id) ? current : [...current, skill.id],
        );
        setNewSkillName("");
        setNewSkillInstructions("");
      } catch (failure) {
        setError(describeError(failure));
      } finally {
        setBusy(false);
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
        const tools = allowAllTools()
          ? ["*"]
          : allowedPatterns()
              .split("\n")
              .map((pattern) => pattern.trim())
              .filter((pattern) => pattern.length > 0);
        await context.personas.update(persona.id, {
          name: name().trim(),
          description: description().trim() || undefined,
          instructions: instructions().trim(),
          loopStrategy: loopStrategy(),
          skillIds: skillIds(),
          allowedTools: tools.length > 0 ? tools : ["*"],
          contextMapStrategy: contextMapStrategy(),
          secondaryModels: secondaryModels(),
          avatar: avatar().trim() || undefined,
          color: color().trim() || undefined,
          promptTemplates: promptTemplates().filter(
            (template) =>
              template.name.trim().length > 0 &&
              template.prompt.trim().length > 0,
          ),
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
                <span class="flex items-center gap-2">
                  <PersonaMark persona={persona} class="size-6" />
                  <span class="font-medium">{persona.name}</span>
                </span>
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
            <TextField
              class="mt-3"
              value={newName()}
              onChange={setNewName}
              placeholder="Name"
              data-testid="settings-persona-name"
            />
            <TextField
              class="mt-3"
              value={newInstructions()}
              onChange={setNewInstructions}
              rows={5}
              inputClass="min-h-28"
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

              <TextField
                class="mt-4"
                label="Name"
                value={name()}
                onChange={setName}
                data-testid="persona-name"
              />
              <TextField
                class="mt-4"
                label="Description"
                value={description()}
                onChange={setDescription}
                data-testid="persona-description"
              />
              <TextField
                class="mt-4"
                label="Instructions"
                value={instructions()}
                onChange={setInstructions}
                rows={8}
                inputClass="min-h-36"
                data-testid="persona-instructions"
              />

              <Select
                class="mt-4"
                label="Loop"
                value={loopStrategy()}
                onChange={(value) =>
                  setLoopStrategy(value === "code-act" ? "code-act" : "react")
                }
                options={[
                  { value: "react", label: "ReAct. Think, then use tools." },
                  {
                    value: "code-act",
                    label: "CodeAct. Write and run code to act.",
                  },
                ]}
                data-testid="persona-loop-strategy"
              />

              <div class="mt-5">
                <p class="text-sm font-medium">Preferred models</p>
                <p class="mt-1 text-xs text-[var(--text-muted)]">
                  First connected match wins.
                </p>
                <Select
                  class="mt-3"
                  label="Primary model"
                  value={primaryModelValue()}
                  onOpenChange={(open) => {
                    if (open) void refreshModels();
                  }}
                  onChange={(value) => {
                    setPrimaryModel(value);
                  }}
                  groups={groupModelsByProvider(models()).map(
                    ([providerId, group]) => ({
                      label: displayProviderName(providerId),
                      options: group.map((model) => ({
                        value: model.preferenceId,
                        label: displayModelName(model),
                      })),
                    }),
                  )}
                  data-testid="persona-primary-model"
                />
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
                <Select
                  class="mt-3"
                  label="Add a connected model"
                  value={addModelId()}
                  placeholder="Select a model"
                  onOpenChange={(open) => {
                    if (open) void refreshModels();
                  }}
                  onChange={(value) => {
                    addPreferredModel(value);
                  }}
                  groups={groupModelsByProvider(unusedModels()).map(
                    ([providerId, group]) => ({
                      label: displayProviderName(providerId),
                      options: group.map((model) => ({
                        value: model.preferenceId,
                        label: displayModelName(model),
                      })),
                    }),
                  )}
                  data-testid="persona-add-model"
                />
              </div>

              <div class="mt-5">
                <p class="text-sm font-medium">Secondary models</p>
                <p class="mt-1 text-xs text-[var(--text-muted)]">
                  Used for one-shot prompts such as graph invoke_prompt. Falls
                  back to preferred models when empty.
                </p>
                <div class="mt-3 grid gap-2">
                  <For
                    each={secondaryModels()}
                    fallback={
                      <p class="text-sm text-[var(--text-muted)]">
                        No secondary models. Auxiliary calls use preferred
                        models.
                      </p>
                    }
                  >
                    {(preference) => (
                      <div
                        class="flex items-center gap-2 rounded-xl border border-[var(--border)] px-3 py-2"
                        data-testid={`persona-secondary-${preference}`}
                      >
                        <p class="min-w-0 flex-1 text-sm">
                          {resolvePreferenceLabel(preference, models())}
                        </p>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => removeSecondaryModel(preference)}
                        >
                          Remove
                        </Button>
                      </div>
                    )}
                  </For>
                </div>
                <Select
                  class="mt-3"
                  label="Add a secondary model"
                  value=""
                  placeholder="Select a model"
                  onOpenChange={(open) => {
                    if (open) void refreshModels();
                  }}
                  onChange={(value) => {
                    addSecondaryModel(value);
                  }}
                  groups={groupModelsByProvider(unusedSecondaryModels()).map(
                    ([providerId, group]) => ({
                      label: displayProviderName(providerId),
                      options: group.map((model) => ({
                        value: model.preferenceId,
                        label: displayModelName(model),
                      })),
                    }),
                  )}
                  data-testid="persona-add-secondary-model"
                />
              </div>

              <div class="mt-5">
                <p class="text-sm font-medium">Appearance</p>
                <TextField
                  class="mt-3"
                  label="Avatar"
                  value={avatar()}
                  onChange={setAvatar}
                  data-testid="persona-avatar"
                />
                <p class="mt-1 text-xs text-[var(--text-muted)]">
                  Emoji or short mark shown next to the persona name.
                </p>
                <p class="mt-3 text-xs font-medium">Color</p>
                <div class="mt-2 flex flex-wrap gap-2">
                  <For each={[...PERSONA_COLOR_PRESETS]}>
                    {(preset) => (
                      <button
                        type="button"
                        class="size-7 rounded-full border"
                        classList={{
                          "border-[var(--text)]": color() === preset,
                          "border-transparent": color() !== preset,
                        }}
                        style={{ "background-color": preset }}
                        aria-label={`Persona color ${preset}`}
                        data-testid={`persona-color-${preset.slice(1)}`}
                        onClick={() => setColor(preset)}
                      />
                    )}
                  </For>
                </div>
                <TextField
                  class="mt-3"
                  label="Color hex"
                  value={color()}
                  onChange={setColor}
                  data-testid="persona-color"
                />
              </div>

              <div class="mt-5">
                <p class="text-sm font-medium">Prompt templates</p>
                <p class="mt-1 text-xs text-[var(--text-muted)]">
                  Saved prompts appear as starters in new chats.
                </p>
                <div class="mt-3 grid gap-3">
                  <Index each={promptTemplates()}>
                    {(template, index) => (
                      <div class="rounded-xl border border-[var(--border)] p-3">
                        <TextField
                          label="Template name"
                          value={template().name}
                          onChange={(value) =>
                            setPromptTemplates((current) =>
                              current.map((item, itemIndex) =>
                                itemIndex === index
                                  ? { ...item, name: value }
                                  : item,
                              ),
                            )
                          }
                          data-testid={`persona-template-name-${index}`}
                        />
                        <TextField
                          class="mt-3"
                          label="Template prompt"
                          value={template().prompt}
                          onChange={(value) =>
                            setPromptTemplates((current) =>
                              current.map((item, itemIndex) =>
                                itemIndex === index
                                  ? { ...item, prompt: value }
                                  : item,
                              ),
                            )
                          }
                          rows={3}
                          data-testid={`persona-template-prompt-${index}`}
                        />
                        <Button
                          class="mt-3"
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() =>
                            setPromptTemplates((current) =>
                              current.filter(
                                (_item, itemIndex) => itemIndex !== index,
                              ),
                            )
                          }
                        >
                          Remove template
                        </Button>
                      </div>
                    )}
                  </Index>
                </div>
                <Button
                  class="mt-3"
                  type="button"
                  variant="secondary"
                  size="sm"
                  data-testid="persona-template-add"
                  onClick={() =>
                    setPromptTemplates((current) => [
                      ...current,
                      {
                        id: `tpl${Date.now().toString(36)}`,
                        name: "New prompt",
                        prompt: "Help me with ",
                      },
                    ])
                  }
                >
                  Add prompt template
                </Button>
              </div>

              <Select
                class="mt-4"
                label="Context map"
                value={contextMapStrategy()}
                onChange={(value) =>
                  setContextMapStrategy(
                    value === "code"
                      ? "code"
                      : value === "advanced"
                        ? "advanced"
                        : "general",
                  )
                }
                options={[
                  {
                    value: "general",
                    label: "General. List workspace files.",
                  },
                  {
                    value: "code",
                    label: "Code. List source files only.",
                  },
                  {
                    value: "advanced",
                    label: "Advanced. List files and include small file contents.",
                  },
                ]}
                data-testid="persona-context-map"
              />

              <div class="mt-5">
                <p class="text-sm font-medium">Tools</p>
                <p class="mt-1 text-xs text-[var(--text-muted)]">
                  Patterns are exact IDs or globs such as filesystem.*.
                </p>
                <Checkbox
                  class="mt-3"
                  checked={allowAllTools()}
                  onChange={setAllowAllTools}
                  label="Allow all tools"
                  data-testid="persona-allow-all-tools"
                />
                <Show when={!allowAllTools()}>
                  <TextField
                    class="mt-3"
                    label="Allowed tool patterns"
                    value={allowedPatterns()}
                    onChange={setAllowedPatterns}
                    rows={4}
                    inputClass="min-h-24 font-mono text-xs"
                    data-testid="persona-allowed-tools"
                  />
                </Show>
              </div>

              <div class="mt-5">
                <p class="text-sm font-medium">Skills</p>
                <p class="mt-1 text-xs text-[var(--text-muted)]">
                  Attached skill instructions are injected into the system prompt.
                </p>
                <div class="mt-3 grid gap-2">
                  <For
                    each={catalogSkills()}
                    fallback={
                      <p class="text-sm text-[var(--text-muted)]">
                        No skills yet. Create one below.
                      </p>
                    }
                  >
                    {(skill) => (
                      <Checkbox
                        checked={skillIds().includes(skill.id)}
                        onChange={(checked) => toggleSkill(skill.id, checked)}
                        label={skill.name}
                        data-testid={`persona-skill-${skill.id}`}
                      />
                    )}
                  </For>
                </div>
                <TextField
                  class="mt-4"
                  label="New skill name"
                  value={newSkillName()}
                  onChange={setNewSkillName}
                  data-testid="persona-skill-name"
                />
                <TextField
                  class="mt-3"
                  label="New skill instructions"
                  value={newSkillInstructions()}
                  onChange={setNewSkillInstructions}
                  rows={4}
                  inputClass="min-h-24"
                  data-testid="persona-skill-instructions"
                />
                <Button
                  class="mt-3"
                  type="button"
                  variant="secondary"
                  size="sm"
                  disabled={busy()}
                  data-testid="persona-skill-create"
                  onClick={() => void createSkill()}
                >
                  Create and attach skill
                </Button>
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
