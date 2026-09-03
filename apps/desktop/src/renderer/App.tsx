import type {
  FlightDeckWidgetContribution,
  SettingsPageContribution,
  WizardStepContribution,
  WorkspaceViewContribution,
} from "@borg/plugin-sdk";
import { Panel } from "@borg/ui-kit";
import {
  Blocks,
  ChevronDown,
  LayoutDashboard,
  Minus,
  Settings,
  Sparkles,
  WandSparkles,
  X,
} from "lucide-solid";
import { Dynamic } from "solid-js/web";
import {
  ErrorBoundary,
  For,
  Match,
  Switch,
  createSignal,
  type Component,
} from "solid-js";

type Surface = "workspace" | "settings" | "wizard" | "flightDeck";

interface AppProps {
  readonly kernelVersion: string;
  readonly startedAt: string;
  readonly activePluginCount: number;
  readonly workspaceViews: readonly WorkspaceViewContribution<Component>[];
  readonly settingsPages: readonly SettingsPageContribution<Component>[];
  readonly wizardSteps: readonly WizardStepContribution<Component>[];
  readonly widgets: readonly FlightDeckWidgetContribution<Component>[];
  readonly pluginErrors: readonly string[];
  readonly setupCompleted: boolean;
  readonly toasts: readonly RendererNotification[];
  completeSetup(): Promise<void>;
  dismissToast(id: string): void;
  hideWindow(): Promise<void>;
}

const navigation = [
  { id: "workspace", label: "Workspace", icon: LayoutDashboard },
  { id: "settings", label: "Settings", icon: Settings },
  { id: "wizard", label: "Setup", icon: WandSparkles },
  { id: "flightDeck", label: "Flight Deck", icon: Blocks },
] as const;

export const App: Component<AppProps> = (props) => {
  const [surface, setSurface] = createSignal<Surface>(
    props.setupCompleted ? "flightDeck" : "wizard",
  );
  const [completingSetup, setCompletingSetup] = createSignal(false);
  const [wizardReadinessErrors, setWizardReadinessErrors] = createSignal<
    readonly string[]
  >([]);
  const isWizardStepComplete = (
    step: WizardStepContribution<Component>,
  ): boolean => {
    if (step.required !== true) {
      return true;
    }
    try {
      return step.isComplete?.() === true;
    } catch (error) {
      const message = `${step.id}: ${
        error instanceof Error ? error.message : String(error)
      }`;
      queueMicrotask(() =>
        setWizardReadinessErrors((current) =>
          current.includes(message) ? current : [...current, message],
        ),
      );
      return false;
    }
  };
  const wizardReady = (): boolean =>
    props.pluginErrors.length === 0 &&
    props.wizardSteps.every(isWizardStepComplete);

  const completeSetup = async (): Promise<void> => {
    setCompletingSetup(true);
    try {
      await props.completeSetup();
      setSurface("flightDeck");
    } finally {
      setCompletingSetup(false);
    }
  };

  return (
    <div class="min-h-screen bg-[var(--background)] text-[var(--text)]" data-testid="app-shell">
      <header class="flex h-16 items-center justify-between border-b border-[var(--border)] px-5">
        <div class="flex items-center gap-3">
          <div class="grid size-9 place-items-center rounded-xl border border-[var(--accent)]/40 bg-[var(--accent)]/10 text-[var(--accent)]">
            <Sparkles aria-hidden="true" size={18} />
          </div>
          <div>
            <h1 class="text-sm font-semibold tracking-wide">Borg</h1>
            <p class="text-xs text-[var(--text-subtle)]">Local agent platform</p>
          </div>
        </div>

        <div class="flex items-center gap-3">
          <div
            class="flex items-center gap-2 rounded-full border border-[var(--border)] bg-[var(--panel)] px-3 py-1.5 text-xs text-[var(--text-muted)]"
            data-testid="kernel-indicator"
          >
            <span class="size-2 rounded-full bg-[var(--success)]" />
            Kernel {props.kernelVersion}
          </div>
          <button
            type="button"
            class="grid size-9 place-items-center rounded-lg text-[var(--text-muted)] transition hover:bg-[var(--panel)] hover:text-[var(--text)]"
            aria-label="Hide Borg"
            data-testid="window-hide"
            onClick={() => void props.hideWindow()}
          >
            <Minus aria-hidden="true" size={18} />
          </button>
        </div>
      </header>

      <div class="grid min-h-[calc(100vh-4rem)] grid-cols-[220px_1fr]">
        <aside class="border-r border-[var(--border)] p-3">
          <nav class="space-y-1" aria-label="Main navigation">
            <For each={navigation}>
              {(item) => (
                <button
                  type="button"
                  class="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-sm transition"
                  classList={{
                    "bg-[var(--accent)]/12 text-[var(--accent)]": surface() === item.id,
                    "text-[var(--text-muted)] hover:bg-[var(--panel)] hover:text-[var(--text)]":
                      surface() !== item.id,
                  }}
                  data-testid={`nav-${item.id}`}
                  onClick={() => setSurface(item.id)}
                >
                  <Dynamic component={item.icon} aria-hidden="true" size={17} />
                  {item.label}
                </button>
              )}
            </For>
          </nav>

          <div class="mt-8 border-t border-[var(--border)] px-3 pt-4">
            <p class="text-[0.68rem] font-semibold uppercase tracking-[0.2em] text-[var(--text-subtle)]">
              Runtime
            </p>
            <p class="mt-2 text-xs text-[var(--text-muted)]">
              {props.activePluginCount} active plugin
              {props.activePluginCount === 1 ? "" : "s"}
            </p>
          </div>
        </aside>

        <main class="min-w-0 p-8">
          <Switch>
            <Match when={surface() === "workspace"}>
              <EmptySurface
                testId="surface-workspace"
                eyebrow="Main workspace"
                title="No workspace view yet"
                description="Chat arrives in Slice 4 as a plugin contribution."
                contributions={props.workspaceViews}
              />
            </Match>
            <Match when={surface() === "settings"}>
              <EmptySurface
                testId="surface-settings"
                eyebrow="Settings"
                title="Settings"
                description="No plugin settings pages are active."
                contributions={props.settingsPages}
              />
            </Match>
            <Match when={surface() === "wizard"}>
              <section data-testid="surface-wizard">
                <p class="text-xs font-semibold uppercase tracking-[0.24em] text-[var(--accent)]">
                  Setup wizard
                </p>
                <h2 class="mt-2 text-3xl font-semibold tracking-tight">
                  Prepare Borg
                </h2>
                <p class="mt-2 text-sm text-[var(--text-muted)]">
                  Complete the active plugin setup steps, then continue to the Flight
                  Deck.
                </p>
                <div class="mt-8 grid gap-5">
                  <For each={props.pluginErrors}>
                    {(error) => (
                      <Panel class="border-[var(--danger)]/40 text-[var(--danger)]">
                        <p data-testid="plugin-ui-error">{error}</p>
                      </Panel>
                    )}
                  </For>
                  <For each={wizardReadinessErrors()}>
                    {(error) => (
                      <Panel class="border-[var(--danger)]/40 text-[var(--danger)]">
                        <p data-testid="plugin-ui-error">{error}</p>
                      </Panel>
                    )}
                  </For>
                  <For
                    each={props.wizardSteps}
                    fallback={
                      <Panel class="border-dashed">
                        <p class="text-sm text-[var(--text-muted)]">
                          No setup steps are active.
                        </p>
                      </Panel>
                    }
                  >
                    {(step) => (
                      <article data-contribution-id={step.id}>
                        <h3 class="sr-only">{step.label}</h3>
                        <ErrorBoundary
                          fallback={(error) => (
                            <Panel class="border-[var(--danger)]/40 text-[var(--danger)]">
                              <p data-testid="plugin-ui-error">
                                {step.id}: {String(error)}
                              </p>
                            </Panel>
                          )}
                        >
                          <Dynamic component={step.component} />
                        </ErrorBoundary>
                      </article>
                    )}
                  </For>
                </div>
                <div class="mt-6 flex justify-end">
                  <button
                    type="button"
                    class="rounded-xl bg-[var(--accent)] px-5 py-2.5 text-sm font-semibold text-[var(--background)] disabled:opacity-50"
                    disabled={completingSetup() || !wizardReady()}
                    onClick={() => void completeSetup()}
                    data-testid="setup-complete"
                  >
                    {completingSetup()
                      ? "Completing…"
                      : wizardReady()
                        ? "Complete setup"
                        : "Complete required steps"}
                  </button>
                </div>
              </section>
            </Match>
            <Match when={surface() === "flightDeck"}>
              <section data-testid="surface-flightDeck">
                <div class="mb-7 flex items-end justify-between gap-4">
                  <div>
                    <p class="text-xs font-semibold uppercase tracking-[0.24em] text-[var(--accent)]">
                      Mission control
                    </p>
                    <h2 class="mt-2 text-3xl font-semibold tracking-tight">Flight Deck</h2>
                    <p class="mt-2 text-sm text-[var(--text-muted)]">
                      Live projections contributed by active plugins.
                    </p>
                  </div>
                  <button
                    type="button"
                    class="flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-xs text-[var(--text-muted)]"
                  >
                    Started {new Date(props.startedAt).toLocaleTimeString()}
                    <ChevronDown aria-hidden="true" size={14} />
                  </button>
                </div>

                <For each={props.pluginErrors}>
                  {(error) => (
                    <div
                      class="mb-4 rounded-xl border border-[var(--danger)]/40 bg-[var(--danger)]/10 p-3 text-sm text-[var(--danger)]"
                      data-testid="plugin-ui-error"
                    >
                      {error}
                    </div>
                  )}
                </For>

                <div class="grid gap-5 lg:grid-cols-2">
                  <For
                    each={props.widgets}
                    fallback={
                      <Panel>
                        <p class="text-sm text-[var(--text-muted)]">
                          No Flight Deck widgets are active.
                        </p>
                      </Panel>
                    }
                  >
                    {(widget) => (
                      <ErrorBoundary
                        fallback={(error) => (
                          <Panel class="border-[var(--danger)]/40 text-[var(--danger)]">
                            <p data-testid="plugin-ui-error">
                              {widget.id}: {String(error)}
                            </p>
                          </Panel>
                        )}
                      >
                        <Dynamic component={widget.component} />
                      </ErrorBoundary>
                    )}
                  </For>
                </div>
              </section>
            </Match>
          </Switch>
        </main>
      </div>

      <div class="fixed bottom-5 right-5 z-50 grid w-80 gap-3" aria-live="polite">
        <For each={props.toasts}>
          {(toast) => (
            <div
              class="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 shadow-2xl"
              data-testid="toast"
              data-level={toast.level}
            >
              <div class="flex items-start justify-between gap-3">
                <div>
                  <p class="text-sm font-semibold">{toast.title}</p>
                  <p class="mt-1 text-xs text-[var(--text-muted)]">{toast.body}</p>
                </div>
                <button
                  type="button"
                  class="text-[var(--text-subtle)] hover:text-[var(--text)]"
                  aria-label="Dismiss notification"
                  onClick={() => props.dismissToast(toast.id)}
                >
                  <X aria-hidden="true" size={15} />
                </button>
              </div>
            </div>
          )}
        </For>
      </div>
    </div>
  );
};

interface EmptySurfaceProps {
  readonly testId: string;
  readonly eyebrow: string;
  readonly title: string;
  readonly description: string;
  readonly contributions: readonly {
    readonly id: string;
    readonly label: string;
    readonly component: Component;
  }[];
}

const EmptySurface: Component<EmptySurfaceProps> = (props) => (
  <section data-testid={props.testId}>
    <p class="text-xs font-semibold uppercase tracking-[0.24em] text-[var(--accent)]">
      {props.eyebrow}
    </p>
    <h2 class="mt-2 text-3xl font-semibold tracking-tight">{props.title}</h2>
    <div class="mt-8 grid gap-5">
      <For
        each={props.contributions}
        fallback={
          <Panel class="border-dashed">
            <p class="text-sm text-[var(--text-muted)]">{props.description}</p>
          </Panel>
        }
      >
        {(contribution) => (
          <article data-contribution-id={contribution.id}>
            <h3 class="sr-only">{contribution.label}</h3>
            <ErrorBoundary
              fallback={(error) => (
                <Panel class="border-[var(--danger)]/40 text-[var(--danger)]">
                  <p data-testid="plugin-ui-error">
                    {contribution.id}: {String(error)}
                  </p>
                </Panel>
              )}
            >
              <Dynamic component={contribution.component} />
            </ErrorBoundary>
          </article>
        )}
      </For>
    </div>
  </section>
);
