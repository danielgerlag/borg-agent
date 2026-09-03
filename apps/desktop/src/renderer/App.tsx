import type {
  FlightDeckWidgetContribution,
  InteractionRendererContribution,
  InteractionRendererProps,
  SettingsPageContribution,
  WizardStepContribution,
  WorkspaceViewContribution,
} from "@borg/plugin-sdk";
import type {
  InteractionResponse,
  PendingInteraction,
} from "@borg/contracts";
import { Button, Panel } from "@borg/ui-kit";
import {
  Activity,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Code2,
  MessageCircle,
  Minus,
  Settings,
  Sparkles,
  WandSparkles,
  X,
} from "lucide-solid";
import {
  ErrorBoundary,
  For,
  Show,
  createMemo,
  createSignal,
  type Component,
  type JSX,
} from "solid-js";
import { Dynamic } from "solid-js/web";

type Surface = "chat" | "settings" | "activity" | "developer" | "setup";

interface AppProps {
  readonly kernelVersion: string;
  readonly startedAt: string;
  readonly activePluginCount: number;
  readonly workspaceViews: readonly WorkspaceViewContribution<Component>[];
  readonly settingsPages: readonly SettingsPageContribution<Component>[];
  readonly wizardSteps: readonly WizardStepContribution<Component>[];
  readonly widgets: readonly FlightDeckWidgetContribution<Component>[];
  readonly interactionRenderers: readonly InteractionRendererContribution<
    (props: InteractionRendererProps) => unknown
  >[];
  readonly pendingInteractions: readonly PendingInteraction[];
  readonly pluginErrors: readonly string[];
  readonly setupCompleted: boolean;
  readonly toasts: readonly RendererNotification[];
  completeSetup(): Promise<void>;
  dismissToast(id: string): void;
  hideWindow(): Promise<void>;
  respondToInteraction(
    interactionId: string,
    response: InteractionResponse,
  ): Promise<void>;
}

export const App: Component<AppProps> = (props) => {
  const [surface, setSurface] = createSignal<Surface>(
    props.setupCompleted ? "chat" : "setup",
  );
  const [wizardStep, setWizardStep] = createSignal(0);
  const [completingSetup, setCompletingSetup] = createSignal(false);
  const [setupError, setSetupError] = createSignal<string>();
  const [selectedInteractionId, setSelectedInteractionId] =
    createSignal<string>();
  const [wizardReadinessErrors, setWizardReadinessErrors] = createSignal<
    readonly string[]
  >([]);

  const primaryViews = createMemo(() =>
    props.workspaceViews.filter(({ placement }) => placement !== "developer"),
  );
  const developerViews = createMemo(() =>
    props.workspaceViews.filter(({ placement }) => placement === "developer"),
  );
  const primarySettings = createMemo(() =>
    props.settingsPages.filter(({ placement }) => placement !== "developer"),
  );
  const developerSettings = createMemo(() =>
    props.settingsPages.filter(({ placement }) => placement === "developer"),
  );
  const primaryWidgets = createMemo(() =>
    props.widgets.filter(({ placement }) => placement !== "developer"),
  );
  const developerWidgets = createMemo(() =>
    props.widgets.filter(({ placement }) => placement === "developer"),
  );

  const isWizardStepComplete = (
    step: WizardStepContribution<Component>,
  ): boolean => {
    if (step.required !== true) {
      return true;
    }
    try {
      return step.isComplete?.() === true;
    } catch (error) {
      const message = `${step.label}: ${
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
  const firstIncompleteWizardIndex = (): number | undefined => {
    const index = props.wizardSteps.findIndex(
      (step) => !isWizardStepComplete(step),
    );
    return index >= 0 ? index + 1 : undefined;
  };
  const finalWizardIndex = () => props.wizardSteps.length + 1;
  const activeContribution = () => props.wizardSteps[wizardStep() - 1];
  const canContinue = () => {
    if (wizardStep() === finalWizardIndex()) {
      return wizardReady();
    }
    const contribution = activeContribution();
    return contribution ? isWizardStepComplete(contribution) : true;
  };
  const wizardLabels = createMemo(() => [
    "Welcome",
    ...props.wizardSteps.map((step) => {
      if (step.label.toLowerCase().includes("secret")) {
        return "Secure storage";
      }
      if (
        step.label.toLowerCase().includes("persona") ||
        step.label.toLowerCase().includes("model")
      ) {
        return "Choose assistant";
      }
      return step.label;
    }),
    "Ready",
  ]);

  const completeSetup = async (): Promise<void> => {
    if (!wizardReady()) {
      return;
    }
    setCompletingSetup(true);
    setSetupError(undefined);
    try {
      await props.completeSetup();
      setSurface("chat");
    } catch (error) {
      setSetupError(error instanceof Error ? error.message : String(error));
    } finally {
      setCompletingSetup(false);
    }
  };

  const continueWizard = (): void => {
    if (!canContinue()) {
      return;
    }
    if (wizardStep() === finalWizardIndex()) {
      void completeSetup();
      return;
    }
    setWizardStep((current) => Math.min(current + 1, finalWizardIndex()));
  };

  const activeInteraction = (): PendingInteraction | undefined =>
    props.pendingInteractions.find(
      ({ id }) => id === selectedInteractionId(),
    ) ?? props.pendingInteractions[0];
  const interactionRenderer = () => {
    const interaction = activeInteraction();
    return interaction?.kind === "human_input"
      ? props.interactionRenderers.find(
          ({ kind }) => kind === interaction.kind,
        )
      : undefined;
  };

  return (
    <div
      class="h-screen overflow-hidden bg-[var(--background)] text-[var(--text)]"
      data-testid="app-shell"
    >
      <Show
        when={surface() !== "setup"}
        fallback={
          <SetupWizard
            currentIndex={wizardStep()}
            labels={wizardLabels()}
            contribution={activeContribution()}
            finalIndex={finalWizardIndex()}
            ready={wizardReady()}
            blockedStepIndex={firstIncompleteWizardIndex()}
            canContinue={canContinue()}
            completing={completingSetup()}
            pluginErrors={[
              ...props.pluginErrors,
              ...wizardReadinessErrors(),
              ...(setupError() ? [setupError()!] : []),
            ]}
            onBack={() =>
              setWizardStep((current) => Math.max(0, current - 1))
            }
            onContinue={continueWizard}
            onSelectStep={setWizardStep}
          />
        }
      >
        <div class="grid h-full grid-cols-[11rem_minmax(0,1fr)]">
          <aside class="flex flex-col border-r border-[var(--border)] bg-[var(--sidebar)] p-3">
            <div class="flex h-11 items-center gap-3 px-2" aria-label="Borg">
              <div class="grid size-9 place-items-center rounded-xl bg-[var(--accent)] text-[var(--accent-contrast)] shadow-[0_10px_30px_var(--accent-glow)]">
                <Sparkles aria-hidden="true" size={18} />
              </div>
              <span class="text-sm font-semibold tracking-wide">Borg</span>
            </div>

            <nav class="mt-7 flex flex-1 flex-col gap-1" aria-label="Main navigation">
              <RailButton
                label="Chat"
                active={surface() === "chat"}
                testId="nav-chat"
                onClick={() => setSurface("chat")}
                icon={MessageCircle}
              />
              <RailButton
                label="Activity"
                active={surface() === "activity"}
                testId="nav-activity"
                onClick={() => setSurface("activity")}
                icon={Activity}
                badge={props.pendingInteractions.length}
              />
            </nav>

            <div class="flex flex-col gap-1">
              <RailButton
                label="Settings"
                active={surface() === "settings" || surface() === "developer"}
                testId="nav-settings"
                onClick={() => setSurface("settings")}
                icon={Settings}
              />
              <RailButton
                label="Hide Borg"
                active={false}
                testId="window-hide"
                onClick={() => void props.hideWindow()}
                icon={Minus}
              />
            </div>
          </aside>

          <main class="min-h-0 min-w-0 overflow-hidden">
            <Show when={surface() === "chat"}>
              <PrimarySurface contributions={primaryViews()} />
            </Show>
            <Show when={surface() === "settings"}>
              <SettingsSurface
                contributions={primarySettings()}
                onOpenSetup={() => {
                  setWizardStep(0);
                  setSurface("setup");
                }}
                onOpenDeveloper={() => setSurface("developer")}
                hasDeveloperTools={
                  developerViews().length +
                    developerSettings().length +
                    developerWidgets().length >
                  0
                }
              />
            </Show>
            <Show when={surface() === "activity"}>
              <ActivitySurface
                contributions={primaryWidgets()}
                startedAt={props.startedAt}
              />
            </Show>
            <Show when={surface() === "developer"}>
              <DeveloperSurface
                views={developerViews()}
                settings={developerSettings()}
                widgets={developerWidgets()}
                onBack={() => setSurface("settings")}
              />
            </Show>
          </main>
        </div>
      </Show>

      <Show keyed when={activeInteraction()}>
        {(interaction) => (
          <div
            class="fixed inset-0 z-40 grid place-items-center bg-black/70 p-5 backdrop-blur-sm"
            data-testid="interaction-overlay"
          >
            <section class="w-full max-w-lg rounded-3xl border border-[var(--border-strong)] bg-[var(--panel)] p-6 shadow-2xl">
              <Show when={props.pendingInteractions.length > 1}>
                <div
                  class="mb-5 flex gap-2 overflow-x-auto border-b border-[var(--border)] pb-4"
                  data-testid="pending-interaction-list"
                >
                  <For each={props.pendingInteractions}>
                    {(pending, index) => (
                      <button
                        type="button"
                        class="shrink-0 rounded-xl border border-[var(--border)] px-3 py-2 text-left text-xs hover:border-[var(--accent)]"
                        onClick={() => setSelectedInteractionId(pending.id)}
                      >
                        {index() + 1}. {pending.title}
                      </button>
                    )}
                  </For>
                </div>
              </Show>
              <p class="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--accent)]">
                {interaction.kind === "human_input"
                  ? "Your input is needed"
                  : "Review requested"}
              </p>
              <h2 class="mt-2 text-xl font-semibold">{interaction.title}</h2>
              <p class="mt-3 text-sm leading-6 text-[var(--text-muted)]">
                {interaction.prompt}
              </p>

              <Show
                when={interactionRenderer()}
                fallback={
                  <Show
                    when={interaction.kind !== "human_input"}
                    fallback={
                      <p class="mt-4 text-sm text-[var(--danger)]">
                        This question cannot be displayed right now.
                      </p>
                    }
                  >
                    <div class="mt-6 grid grid-cols-2 gap-3">
                      <Button
                        type="button"
                        variant="danger"
                        onClick={() =>
                          void props.respondToInteraction(interaction.id, {
                            kind: "approval",
                            decision: "deny",
                          })
                        }
                        data-testid="interaction-deny"
                      >
                        Not now
                      </Button>
                      <Button
                        type="button"
                        onClick={() =>
                          void props.respondToInteraction(interaction.id, {
                            kind: "approval",
                            decision: "allow",
                          })
                        }
                        data-testid="interaction-allow"
                      >
                        Approve once
                      </Button>
                    </div>
                  </Show>
                }
              >
                {(renderer) => (
                  <ContributionBoundary label={renderer().id}>
                    <Dynamic
                      component={
                        renderer().component as Component<InteractionRendererProps>
                      }
                      interaction={interaction}
                      respond={(response: InteractionResponse) =>
                        props.respondToInteraction(interaction.id, response)
                      }
                    />
                  </ContributionBoundary>
                )}
              </Show>
            </section>
          </div>
        )}
      </Show>

      <div
        class="fixed bottom-5 right-5 z-50 grid w-[min(22rem,calc(100vw-2rem))] gap-3"
        aria-live="polite"
      >
        <For each={props.toasts}>
          {(toast) => (
            <div
              class="rounded-2xl border border-[var(--border-strong)] bg-[var(--panel)] p-4 shadow-2xl"
              data-testid="toast"
              data-level={toast.level}
            >
              <div class="flex items-start justify-between gap-3">
                <div>
                  <p class="text-sm font-semibold">{toast.title}</p>
                  <p class="mt-1 text-xs leading-5 text-[var(--text-muted)]">
                    {toast.body}
                  </p>
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

const RailButton: Component<{
  readonly label: string;
  readonly active: boolean;
  readonly testId: string;
  readonly icon: typeof MessageCircle;
  readonly badge?: number;
  onClick(): void;
}> = (props) => (
  <button
    type="button"
    class="group relative flex h-10 w-full items-center gap-3 rounded-xl px-3 text-sm font-medium transition"
    classList={{
      "bg-[var(--accent)]/14 text-[var(--accent)]": props.active,
      "text-[var(--text-subtle)] hover:bg-[var(--panel-muted)] hover:text-[var(--text)]":
        !props.active,
    }}
    aria-label={props.label}
    title={props.label}
    data-testid={props.testId}
    onClick={props.onClick}
  >
    <Dynamic component={props.icon} aria-hidden={true} size={18} />
    <span>{props.label}</span>
    <Show when={(props.badge ?? 0) > 0}>
      <span class="ml-auto grid min-w-5 place-items-center rounded-full bg-[var(--danger)] px-1 text-[10px] font-bold text-white">
        {props.badge}
      </span>
    </Show>
  </button>
);

const SetupWizard: Component<{
  readonly currentIndex: number;
  readonly labels: readonly string[];
  readonly contribution: WizardStepContribution<Component> | undefined;
  readonly finalIndex: number;
  readonly ready: boolean;
  readonly blockedStepIndex: number | undefined;
  readonly canContinue: boolean;
  readonly completing: boolean;
  readonly pluginErrors: readonly string[];
  onBack(): void;
  onContinue(): void;
  onSelectStep(index: number): void;
}> = (props) => (
  <section
    class="flex h-screen flex-col bg-[var(--background)]"
    data-testid="surface-wizard"
  >
    <header class="border-b border-[var(--border)] bg-[var(--background)]/90 px-6 py-4 backdrop-blur">
      <nav
        class="mx-auto flex max-w-4xl items-center justify-center gap-2"
        aria-label="Setup progress"
      >
        <For each={props.labels}>
          {(label, index) => {
            const completed = () => index() < props.currentIndex;
            const current = () => index() === props.currentIndex;
            return (
              <>
                <Show when={index() > 0}>
                  <span
                    class="h-px min-w-3 flex-1 transition-colors"
                    classList={{
                      "bg-[var(--accent)]": completed(),
                      "bg-[var(--border)]": !completed(),
                    }}
                  />
                </Show>
                <button
                  type="button"
                  class="flex items-center gap-2 rounded-full px-3 py-2 text-xs font-semibold transition"
                  classList={{
                    "bg-[var(--accent)] text-[var(--accent-contrast)]": current(),
                    "bg-[var(--accent)]/12 text-[var(--accent)]": completed(),
                    "text-[var(--text-subtle)]": !completed() && !current(),
                  }}
                  disabled={!completed()}
                  onClick={() => completed() && props.onSelectStep(index())}
                  aria-current={current() ? "step" : undefined}
                  data-testid={`setup-step-${index()}`}
                >
                  <span class="grid size-5 place-items-center rounded-full bg-current/10">
                    <Show when={completed()} fallback={index() + 1}>
                      <Check aria-hidden="true" size={13} />
                    </Show>
                  </span>
                  <span class="hidden md:inline">{label}</span>
                </button>
              </>
            );
          }}
        </For>
      </nav>
    </header>

    <div class="min-h-0 flex-1 overflow-y-auto">
      <div class="mx-auto flex min-h-full w-full max-w-3xl items-center justify-center px-6 py-10">
        <Show when={props.currentIndex === 0}>
          <div class="max-w-xl text-center" data-testid="setup-welcome">
            <div class="mx-auto grid size-20 place-items-center rounded-3xl bg-[var(--accent)]/12 text-[var(--accent)]">
              <Sparkles aria-hidden="true" size={38} />
            </div>
            <p class="mt-8 text-xs font-semibold uppercase tracking-[0.22em] text-[var(--accent)]">
              Welcome to Borg
            </p>
            <h1 class="mt-3 text-4xl font-semibold tracking-tight">
              Your local AI workspace
            </h1>
            <p class="mx-auto mt-4 max-w-lg text-base leading-7 text-[var(--text-muted)]">
              Set up secure storage and choose your assistant. You will be ready
              to start a conversation in about two minutes.
            </p>
          </div>
        </Show>

        <Show keyed when={props.contribution}>
          {(contribution) => (
            <div class="w-full">
              <ContributionBoundary label={contribution.label}>
                <Dynamic component={contribution.component} />
              </ContributionBoundary>
            </div>
          )}
        </Show>

        <Show when={props.currentIndex === props.finalIndex}>
          <div class="max-w-xl text-center" data-testid="setup-ready">
            <div
              class="mx-auto grid size-20 place-items-center rounded-3xl"
              classList={{
                "bg-[var(--success)]/12 text-[var(--success)]": props.ready,
                "bg-[var(--danger)]/10 text-[var(--danger)]": !props.ready,
              }}
            >
              <Show
                when={props.ready}
                fallback={<CircleAlert aria-hidden="true" size={38} />}
              >
                <Check aria-hidden="true" size={38} />
              </Show>
            </div>
            <p
              class="mt-8 text-xs font-semibold uppercase tracking-[0.22em]"
              classList={{
                "text-[var(--success)]": props.ready,
                "text-[var(--danger)]": !props.ready,
              }}
            >
              {props.ready ? "Setup complete" : "One step needs attention"}
            </p>
            <h1 class="mt-3 text-4xl font-semibold tracking-tight">
              {props.ready ? "You are ready to chat" : "Review your setup"}
            </h1>
            <p class="mx-auto mt-4 max-w-lg text-base leading-7 text-[var(--text-muted)]">
              {props.ready
                ? "Borg will use your selected assistant and keep credentials protected on this device. You can change either later in Settings."
                : "A required setting is no longer ready. Use the review link below to fix it before starting a chat."}
            </p>
          </div>
        </Show>
      </div>
    </div>

    <footer class="border-t border-[var(--border)] bg-[var(--background)]/90 px-6 py-4 backdrop-blur">
      <div class="mx-auto flex max-w-3xl items-center justify-between gap-4">
        <Button
          type="button"
          variant="ghost"
          disabled={props.currentIndex === 0 || props.completing}
          onClick={props.onBack}
          data-testid="setup-back"
        >
          <ChevronLeft aria-hidden="true" size={16} />
          Back
        </Button>
        <div class="min-w-0 flex-1 text-center">
          <For each={props.pluginErrors}>
            {(error) => (
              <p class="truncate text-xs text-[var(--danger)]" data-testid="plugin-ui-error">
                {error}
              </p>
            )}
          </For>
          <Show
            when={
              props.currentIndex === props.finalIndex &&
              props.blockedStepIndex !== undefined
            }
          >
            <button
              type="button"
              class="text-xs font-medium text-[var(--accent)] hover:underline"
              onClick={() => props.onSelectStep(props.blockedStepIndex!)}
              data-testid="setup-review-blocked"
            >
              Review {props.labels[props.blockedStepIndex!]}
            </button>
          </Show>
          <Show
            when={
              !props.canContinue &&
              props.pluginErrors.length === 0 &&
              props.currentIndex !== props.finalIndex
            }
          >
            <p class="text-xs text-[var(--text-muted)]">
              Complete this step to continue.
            </p>
          </Show>
        </div>
        <Button
          type="button"
          size="lg"
          disabled={
            !props.canContinue ||
            (props.currentIndex === props.finalIndex && !props.ready) ||
            props.completing
          }
          onClick={props.onContinue}
          data-testid={
            props.currentIndex === props.finalIndex
              ? "setup-complete"
              : "setup-continue"
          }
        >
          {props.completing
            ? "Opening Borg…"
            : props.currentIndex === props.finalIndex
              ? "Start chatting"
              : props.currentIndex === 0
                ? "Get started"
                : "Continue"}
          <ChevronRight aria-hidden="true" size={16} />
        </Button>
      </div>
    </footer>
  </section>
);

const PrimarySurface: Component<{
  readonly contributions: readonly WorkspaceViewContribution<Component>[];
}> = (props) => {
  const [selectedId, setSelectedId] = createSignal(
    props.contributions[0]?.id ?? "",
  );
  const selected = createMemo(
    () =>
      props.contributions.find(({ id }) => id === selectedId()) ??
      props.contributions[0],
  );
  return (
    <section
      class="flex h-full min-h-0 flex-col"
      data-testid="surface-workspace"
    >
      <Show when={props.contributions.length > 1}>
        <nav
          class="flex shrink-0 gap-1 border-b border-[var(--border)] bg-[var(--sidebar)] px-4 py-2"
          aria-label="Workspace views"
        >
          <For each={props.contributions}>
            {(contribution) => (
              <button
                type="button"
                class="rounded-lg px-3 py-2 text-xs font-medium transition"
                classList={{
                  "bg-[var(--accent)]/12 text-[var(--accent)]":
                    selected()?.id === contribution.id,
                  "text-[var(--text-muted)] hover:bg-[var(--panel-muted)]":
                    selected()?.id !== contribution.id,
                }}
                onClick={() => setSelectedId(contribution.id)}
                aria-current={
                  selected()?.id === contribution.id ? "page" : undefined
                }
                data-testid={`workspace-view-tab-${contribution.id}`}
              >
                {contribution.label}
              </button>
            )}
          </For>
        </nav>
      </Show>
      <div class="min-h-0 flex-1">
        <Show
          keyed
          when={selected()}
          fallback={
            <div class="grid h-full place-items-center p-8">
              <Panel class="max-w-md border-dashed text-center">
                <p class="text-sm text-[var(--text-muted)]">
                  Chat is not available right now.
                </p>
              </Panel>
            </div>
          }
        >
          {(contribution) => (
            <ContributionBoundary label={contribution.label}>
              <Dynamic component={contribution.component} />
            </ContributionBoundary>
          )}
        </Show>
      </div>
    </section>
  );
};

const SettingsSurface: Component<{
  readonly contributions: readonly SettingsPageContribution<Component>[];
  readonly hasDeveloperTools: boolean;
  onOpenSetup(): void;
  onOpenDeveloper(): void;
}> = (props) => {
  const [selectedId, setSelectedId] = createSignal(
    props.contributions[0]?.id ?? "",
  );
  const selected = createMemo(
    () =>
      props.contributions.find(({ id }) => id === selectedId()) ??
      props.contributions[0],
  );
  return (
    <section
      class="grid h-full min-h-0 grid-cols-[15rem_minmax(0,1fr)]"
      data-testid="surface-settings"
    >
      <aside class="border-r border-[var(--border)] bg-[var(--panel)] p-5">
        <p class="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--text-subtle)]">
          Settings
        </p>
        <h1 class="mt-2 text-2xl font-semibold">Make Borg yours</h1>
        <nav class="mt-7 grid gap-1" aria-label="Settings sections">
          <For each={props.contributions}>
            {(contribution) => (
              <button
                type="button"
                class="rounded-xl px-3 py-2.5 text-left text-sm transition"
                classList={{
                  "bg-[var(--accent)]/12 text-[var(--accent)]":
                    selected()?.id === contribution.id,
                  "text-[var(--text-muted)] hover:bg-[var(--panel-muted)] hover:text-[var(--text)]":
                    selected()?.id !== contribution.id,
                }}
                onClick={() => setSelectedId(contribution.id)}
                data-testid={`settings-section-${contribution.id}`}
              >
                {contribution.label}
              </button>
            )}
          </For>
        </nav>
        <div class="mt-7 border-t border-[var(--border)] pt-4">
          <button
            type="button"
            class="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm text-[var(--text-muted)] hover:bg-[var(--panel-muted)] hover:text-[var(--text)]"
            onClick={props.onOpenSetup}
            data-testid="settings-run-setup"
          >
            <WandSparkles aria-hidden="true" size={16} />
            Review setup
          </button>
          <Show when={props.hasDeveloperTools}>
            <button
              type="button"
              class="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm text-[var(--text-subtle)] hover:bg-[var(--panel-muted)] hover:text-[var(--text)]"
              onClick={props.onOpenDeveloper}
              data-testid="settings-developer-tools"
            >
              <Code2 aria-hidden="true" size={16} />
              Developer tools
            </button>
          </Show>
        </div>
      </aside>
      <div class="min-h-0 overflow-y-auto p-8">
        <Show keyed when={selected()}>
          {(contribution) => (
            <div class="mx-auto max-w-3xl">
              <h2 class="mb-5 text-2xl font-semibold">{contribution.label}</h2>
              <ContributionBoundary label={contribution.label}>
                <Dynamic component={contribution.component} />
              </ContributionBoundary>
            </div>
          )}
        </Show>
      </div>
    </section>
  );
};

const ActivitySurface: Component<{
  readonly contributions: readonly FlightDeckWidgetContribution<Component>[];
  readonly startedAt: string;
}> = (props) => (
  <section class="h-full overflow-y-auto p-8" data-testid="surface-flightDeck">
    <div class="mx-auto max-w-5xl">
      <p class="text-xs font-semibold uppercase tracking-[0.22em] text-[var(--accent)]">
        Activity
      </p>
      <h1 class="mt-2 text-3xl font-semibold">What Borg is doing</h1>
      <p class="mt-2 text-sm text-[var(--text-muted)]">
        Running chats and requests that need your attention.
      </p>
      <div class="mt-8 grid gap-5 lg:grid-cols-2">
        <For
          each={props.contributions}
          fallback={
            <Panel class="border-dashed">
              <p class="text-sm text-[var(--text-muted)]">
                Nothing needs your attention.
              </p>
            </Panel>
          }
        >
          {(contribution) => (
            <ContributionBoundary label={contribution.label}>
              <Dynamic component={contribution.component} />
            </ContributionBoundary>
          )}
        </For>
      </div>
      <p class="mt-8 text-xs text-[var(--text-subtle)]">
        Active since {new Date(props.startedAt).toLocaleTimeString()}
      </p>
    </div>
  </section>
);

const DeveloperSurface: Component<{
  readonly views: readonly WorkspaceViewContribution<Component>[];
  readonly settings: readonly SettingsPageContribution<Component>[];
  readonly widgets: readonly FlightDeckWidgetContribution<Component>[];
  onBack(): void;
}> = (props) => {
  const contributions = createMemo(() => [
    ...props.views.map((contribution) => ({
      ...contribution,
      key: `workspace:${contribution.id}`,
      kind: "workspace" as const,
    })),
    ...props.settings.map((contribution) => ({
      ...contribution,
      key: `settings:${contribution.id}`,
      kind: "settings" as const,
    })),
    ...props.widgets.map((contribution) => ({
      ...contribution,
      key: `widget:${contribution.id}`,
      kind: "widget" as const,
    })),
  ]);
  const [selectedId, setSelectedId] = createSignal(
    contributions()[0]?.key ?? "",
  );
  const selected = createMemo(
    () =>
      contributions().find(({ key }) => key === selectedId()) ??
      contributions()[0],
  );
  return (
    <section class="h-full overflow-y-auto p-8" data-testid="surface-developer">
      <div class="mx-auto max-w-5xl">
        <Button type="button" variant="ghost" onClick={props.onBack}>
          <ChevronLeft aria-hidden="true" size={16} />
          Settings
        </Button>
        <div class="mt-5 flex items-end justify-between gap-4">
          <div>
            <p class="text-xs font-semibold uppercase tracking-[0.22em] text-[var(--text-subtle)]">
              Advanced
            </p>
            <h1 class="mt-2 text-3xl font-semibold">Developer tools</h1>
          </div>
          <div class="flex flex-wrap gap-2">
            <For each={contributions()}>
              {(contribution) => (
                <Button
                  type="button"
                  variant={
                    selected()?.key === contribution.key ? "primary" : "secondary"
                  }
                  size="sm"
                  onClick={() => setSelectedId(contribution.key)}
                  data-testid={`developer-tool-${contribution.kind}-${contribution.id}`}
                >
                  {contribution.label}
                </Button>
              )}
            </For>
          </div>
        </div>
        <Show keyed when={selected()}>
          {(contribution) => (
            <div class="mt-7">
              <ContributionBoundary label={contribution.label}>
                <Dynamic component={contribution.component} />
              </ContributionBoundary>
            </div>
          )}
        </Show>
      </div>
    </section>
  );
};

const ContributionBoundary: Component<{
  readonly label: string;
  readonly children: JSX.Element;
}> = (props) => (
  <ErrorBoundary
    fallback={(error) => (
      <Panel class="border-[var(--danger)]/40 text-[var(--danger)]">
        <p class="text-sm" data-testid="plugin-ui-error">
          {props.label} could not be displayed: {String(error)}
        </p>
      </Panel>
    )}
  >
    {props.children}
  </ErrorBoundary>
);
