import {
  chatSkillsDiscover,
  chatSkillsInstall,
  chatSkillsListSources,
  chatSkillsPreview,
  chatSkillsSetSources,
  type DiscoveredSkill,
  type Skill,
  type SkillSource,
} from "@borg/contracts";
import type { PluginUiContext } from "@borg/plugin-sdk";
import { Button, Checkbox, Dialog, Panel, TextField } from "@borg/ui-kit";
import { Plus, Trash2 } from "lucide-solid";
import {
  For,
  Show,
  createMemo,
  createSignal,
  onMount,
  type Component,
} from "solid-js";

type SkillsView = "installed" | "discover" | "sources";

const GITHUB_NAME = /^[A-Za-z0-9_.-]+$/;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createSkillsSettings(
  context: PluginUiContext<Component>,
): Component {
  return () => {
    const [view, setView] = createSignal<SkillsView>("installed");
    const [installed, setInstalled] = createSignal<readonly Skill[]>([]);
    const [discovered, setDiscovered] = createSignal<readonly DiscoveredSkill[]>(
      [],
    );
    const [sources, setSources] = createSignal<readonly SkillSource[]>([]);
    const [search, setSearch] = createSignal("");
    const [owner, setOwner] = createSignal("");
    const [repo, setRepo] = createSignal("");
    const [warnings, setWarnings] = createSignal<readonly string[]>([]);
    const [error, setError] = createSignal<string>();
    const [busy, setBusy] = createSignal(false);
    const [candidate, setCandidate] = createSignal<DiscoveredSkill>();
    const [preview, setPreview] = createSignal<{
      readonly name: string;
      readonly description: string;
      readonly instructions: string;
    }>();
    const [dialogError, setDialogError] = createSignal<string>();
    const [dialogBusy, setDialogBusy] = createSignal(false);

    const filteredDiscovered = createMemo(() => {
      const query = search().trim().toLowerCase();
      const items = discovered();
      if (!query) {
        return items;
      }
      return items.filter(
        (skill) =>
          skill.name.toLowerCase().includes(query) ||
          skill.description.toLowerCase().includes(query) ||
          skill.sourceId.toLowerCase().includes(query),
      );
    });

    const refreshInstalled = async (): Promise<void> => {
      setInstalled(await context.skills.list());
    };

    const refreshSources = async (): Promise<void> => {
      const result = await context.bus.invoke(chatSkillsListSources, {});
      setSources(result.sources);
    };

    onMount(() => {
      void Promise.all([refreshInstalled(), refreshSources()]).catch(
        (failure: unknown) => setError(describeError(failure)),
      );
    });

    const persistSources = async (
      next: readonly SkillSource[],
    ): Promise<void> => {
      setBusy(true);
      setError(undefined);
      try {
        const result = await context.bus.invoke(chatSkillsSetSources, {
          sources: [...next],
        });
        setSources(result.sources);
      } catch (failure) {
        setError(describeError(failure));
      } finally {
        setBusy(false);
      }
    };

    const scan = async (): Promise<void> => {
      setBusy(true);
      setError(undefined);
      try {
        const result = await context.bus.invoke(chatSkillsDiscover, {});
        setDiscovered(result.skills);
        setWarnings(result.warnings);
      } catch (failure) {
        setError(describeError(failure));
      } finally {
        setBusy(false);
      }
    };

    const openInstall = (skill: DiscoveredSkill): void => {
      setCandidate(skill);
      setPreview(undefined);
      setDialogError(undefined);
      setDialogBusy(true);
      void (async () => {
        try {
          const result = await context.bus.invoke(chatSkillsPreview, {
            sourceId: skill.sourceId,
            sourcePath: skill.sourcePath,
          });
          if (candidate()?.id !== skill.id) {
            return;
          }
          setPreview({
            name: result.name,
            description: result.description,
            instructions: result.instructions,
          });
        } catch (failure) {
          if (candidate()?.id === skill.id) {
            setDialogError(describeError(failure));
          }
        } finally {
          setDialogBusy(false);
        }
      })();
    };

    const closeInstall = (): void => {
      setCandidate(undefined);
      setPreview(undefined);
      setDialogError(undefined);
      setDialogBusy(false);
    };

    const confirmInstall = async (): Promise<void> => {
      const skill = candidate();
      if (!skill || dialogBusy()) {
        return;
      }
      setDialogBusy(true);
      setDialogError(undefined);
      try {
        await context.bus.invoke(chatSkillsInstall, {
          sourceId: skill.sourceId,
          sourcePath: skill.sourcePath,
        });
        await refreshInstalled();
        setDiscovered((current) =>
          current.map((item) =>
            item.id === skill.id ? { ...item, installed: true } : item,
          ),
        );
        closeInstall();
      } catch (failure) {
        setDialogError(describeError(failure));
        setDialogBusy(false);
      }
    };

    const archiveSkill = async (skill: Skill): Promise<void> => {
      if (skill.bundled) {
        return;
      }
      setBusy(true);
      setError(undefined);
      try {
        await context.skills.archive(skill.id);
        await refreshInstalled();
        setDiscovered((current) =>
          current.map((item) =>
            item.id === skill.id ? { ...item, installed: false } : item,
          ),
        );
      } catch (failure) {
        setError(describeError(failure));
      } finally {
        setBusy(false);
      }
    };

    const addSource = (): void => {
      const nextOwner = owner().trim();
      const nextRepo = repo().trim();
      if (!GITHUB_NAME.test(nextOwner) || !GITHUB_NAME.test(nextRepo)) {
        setError("Owner and repo must be GitHub names.");
        return;
      }
      if (
        sources().some(
          (source) => source.owner === nextOwner && source.repo === nextRepo,
        )
      ) {
        setError("That repository is already added.");
        return;
      }
      setOwner("");
      setRepo("");
      void persistSources([
        ...sources(),
        { type: "github", owner: nextOwner, repo: nextRepo, enabled: true },
      ]);
    };

    const viewButton = (id: SkillsView, label: string) => (
      <button
        type="button"
        class="rounded-xl border px-3 py-2 text-left text-sm"
        classList={{
          "border-[var(--accent)] bg-[var(--accent)]/12 text-[var(--accent)]":
            view() === id,
          "border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]":
            view() !== id,
        }}
        aria-current={view() === id ? "true" : undefined}
        data-testid={`skills-view-${id}`}
        onClick={() => setView(id)}
      >
        {label}
      </button>
    );

    return (
      <Panel data-testid="skills-settings-page">
        <p class="text-sm text-[var(--text-muted)]">
          Discover Agent Skills from public GitHub registries and install their
          instructions into the catalog.
        </p>
        <div class="mt-5 flex flex-wrap gap-2">
          {viewButton("installed", "Installed")}
          {viewButton("discover", "Discover")}
          {viewButton("sources", "Sources")}
        </div>

        <Show when={view() === "installed"}>
          <div class="mt-5 grid gap-3">
            <For
              each={installed()}
              fallback={
                <p class="text-sm text-[var(--text-muted)]">
                  No skills installed. Discover them from GitHub registries.
                </p>
              }
            >
              {(skill) => (
                <div
                  class="rounded-xl border border-[var(--border)] px-3 py-3"
                  data-testid={`skills-installed-${skill.id}`}
                >
                  <p class="text-sm font-medium">{skill.name}</p>
                  <Show when={skill.description}>
                    <p class="mt-1 text-xs text-[var(--text-muted)]">
                      {skill.description}
                    </p>
                  </Show>
                  <p class="mt-2 font-mono text-[11px] text-[var(--text-subtle)]">
                    {skill.id}
                  </p>
                  <Show when={!skill.bundled}>
                    <Button
                      class="mt-3"
                      type="button"
                      variant="danger"
                      size="sm"
                      disabled={busy()}
                      data-testid={`skills-archive-${skill.id}`}
                      onClick={() => void archiveSkill(skill)}
                    >
                      <Trash2 aria-hidden="true" size={14} />
                      Archive
                    </Button>
                  </Show>
                </div>
              )}
            </For>
          </div>
        </Show>

        <Show when={view() === "discover"}>
          <div class="mt-5 flex flex-wrap items-end gap-3">
            <Button
              type="button"
              disabled={busy()}
              data-testid="skills-discover-scan"
              onClick={() => void scan()}
            >
              Scan
            </Button>
            <TextField
              class="min-w-56 flex-1"
              label="Search"
              value={search()}
              onChange={setSearch}
              data-testid="skills-discover-search"
            />
          </div>
          <Show when={warnings().length > 0}>
            <ul class="mt-3 grid gap-1 text-xs text-[var(--text-muted)]">
              <For each={warnings()}>{(warning) => <li>{warning}</li>}</For>
            </ul>
          </Show>
          <div class="mt-5 grid gap-3">
            <For
              each={filteredDiscovered()}
              fallback={
                <p class="text-sm text-[var(--text-muted)]">
                  {discovered().length === 0
                    ? "Scan enabled GitHub sources to list SKILL.md files."
                    : "No skills match that search."}
                </p>
              }
            >
              {(skill) => (
                <div
                  class="rounded-xl border border-[var(--border)] px-3 py-3"
                  data-testid={`skills-discovered-${skill.id}`}
                >
                  <p class="text-sm font-medium">{skill.name}</p>
                  <p class="mt-1 text-xs text-[var(--text-muted)]">
                    {skill.description}
                  </p>
                  <p class="mt-2 font-mono text-[11px] text-[var(--text-subtle)]">
                    {skill.sourceId}
                  </p>
                  <Show
                    when={!skill.installed}
                    fallback={
                      <p class="mt-3 text-xs text-[var(--text-muted)]">
                        Installed
                      </p>
                    }
                  >
                    <Button
                      class="mt-3"
                      type="button"
                      size="sm"
                      disabled={busy()}
                      data-testid={`skills-install-${skill.id}`}
                      onClick={() => openInstall(skill)}
                    >
                      Install
                    </Button>
                  </Show>
                </div>
              )}
            </For>
          </div>
        </Show>

        <Show when={view() === "sources"}>
          <p class="mt-5 text-xs text-[var(--text-muted)]">
            Public GitHub repos that contain SKILL.md folders. Defaults match
            HiveMind: anthropics/skills, openai/skills, huggingface/skills.
          </p>
          <div class="mt-4 grid gap-3">
            <For each={sources()}>
              {(source) => (
                <div class="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--border)] px-3 py-3">
                  <p class="font-mono text-sm">
                    {source.owner}/{source.repo}
                  </p>
                  <div class="flex items-center gap-3">
                    <Checkbox
                      checked={source.enabled}
                      disabled={busy()}
                      label="Enabled"
                      onChange={(checked) => {
                        void persistSources(
                          sources().map((item) =>
                            item.owner === source.owner &&
                            item.repo === source.repo
                              ? { ...item, enabled: checked }
                              : item,
                          ),
                        );
                      }}
                    />
                    <Button
                      type="button"
                      variant="danger"
                      size="sm"
                      disabled={busy()}
                      onClick={() =>
                        void persistSources(
                          sources().filter(
                            (item) =>
                              !(
                                item.owner === source.owner &&
                                item.repo === source.repo
                              ),
                          ),
                        )
                      }
                    >
                      <Trash2 aria-hidden="true" size={14} />
                      Remove
                    </Button>
                  </div>
                </div>
              )}
            </For>
          </div>
          <div class="mt-4 flex flex-wrap items-end gap-3">
            <TextField
              class="min-w-40 flex-1"
              label="Owner"
              value={owner()}
              onChange={setOwner}
              data-testid="skills-source-owner"
            />
            <TextField
              class="min-w-40 flex-1"
              label="Repo"
              value={repo()}
              onChange={setRepo}
              data-testid="skills-source-repo"
            />
            <Button
              type="button"
              variant="secondary"
              disabled={busy()}
              data-testid="skills-source-add"
              onClick={addSource}
            >
              <Plus aria-hidden="true" size={14} />
              Add
            </Button>
          </div>
        </Show>

        <Show when={error()}>
          <p
            class="mt-4 text-sm text-[var(--danger)]"
            data-testid="skills-error"
          >
            {error()}
          </p>
        </Show>

        <Dialog
          open={candidate() !== undefined}
          onOpenChange={(open) => {
            if (!open) {
              closeInstall();
            }
          }}
          title={preview()?.name ?? candidate()?.name ?? "Install skill"}
          description={
            preview()?.description ?? candidate()?.description ?? ""
          }
          class="max-w-2xl"
          data-testid="skills-preview"
        >
          <Show when={dialogBusy() && !preview()}>
            <p class="mt-3 text-xs text-[var(--text-muted)]">Loading preview…</p>
          </Show>
          <Show when={preview()}>
            {(current) => (
              <pre class="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-[var(--border)] bg-[var(--background)] p-3 text-[11px] leading-5">
                {current().instructions}
              </pre>
            )}
          </Show>
          <Show when={dialogError()}>
            <p
              class="mt-3 text-sm text-[var(--danger)]"
              data-testid="skills-preview-error"
            >
              {dialogError()}
            </p>
          </Show>
          <div class="mt-4 flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              disabled={dialogBusy()}
              onClick={closeInstall}
            >
              Cancel
            </Button>
            <Button
              type="button"
              disabled={dialogBusy() || !preview()}
              data-testid="skills-install-confirm"
              onClick={() => void confirmInstall()}
            >
              Confirm
            </Button>
          </div>
        </Dialog>
      </Panel>
    );
  };
}
