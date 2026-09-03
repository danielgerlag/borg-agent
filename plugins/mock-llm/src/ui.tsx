import type { LoopRunSnapshot } from "@borg/contracts";
import { defineUiPlugin, type Disposable } from "@borg/plugin-sdk";
import { Panel } from "@borg/ui-kit";
import { Bot, CircleDollarSign, MessageCircleQuestion, Play } from "lucide-solid";
import {
  Show,
  createSignal,
  onCleanup,
  onMount,
  type Component,
} from "solid-js";

export default defineUiPlugin<Component>({
  id: "borg.mock-llm",
  activate(context) {
    const DebugLoop: Component = () => {
      const [run, setRun] = createSignal<LoopRunSnapshot>();
      const [runtimeError, setRuntimeError] = createSignal<string>();
      let runSubscription: Disposable | undefined;
      let generation = 0;
      let active = true;

      const refresh = async (
        runId: string,
        currentGeneration: number,
      ): Promise<void> => {
        let snapshot: LoopRunSnapshot | undefined;
        try {
          snapshot = await context.loops.get(runId);
        } catch (error) {
          if (active && currentGeneration === generation) {
            setRuntimeError(
              error instanceof Error ? error.message : String(error),
            );
          }
          return;
        }
        if (
          !active ||
          currentGeneration !== generation ||
          !snapshot
        ) {
          return;
        }
        setRun(snapshot);
      };

      const start = async (prompt: string): Promise<void> => {
        const currentGeneration = ++generation;
        setRuntimeError(undefined);
        runSubscription?.dispose();
        runSubscription = undefined;
        let snapshot: LoopRunSnapshot;
        try {
          snapshot = await context.loops.start({
            prompt,
            providerId: "borg.mock-llm",
            modelId: "mock:scripted",
            allowedTools: ["tools.echo", "feedback.ask"],
          });
        } catch (error) {
          if (active && currentGeneration === generation) {
            setRuntimeError(
              error instanceof Error ? error.message : String(error),
            );
          }
          return;
        }
        if (!active || currentGeneration !== generation) {
          return;
        }
        setRun(snapshot);
        try {
          const subscription = await context.loops.subscribe(snapshot.id, () =>
            refresh(snapshot.id, currentGeneration),
          );
          if (!active || currentGeneration !== generation) {
            subscription.dispose();
            return;
          }
          runSubscription = subscription;
          await refresh(snapshot.id, currentGeneration);
        } catch (error) {
          if (active && currentGeneration === generation) {
            setRuntimeError(
              error instanceof Error ? error.message : String(error),
            );
          }
        }
      };

      onMount(() => {
        const currentGeneration = ++generation;
        void context.loops
          .list()
          .then(async (runs) => {
            if (!active || currentGeneration !== generation) {
              return;
            }
            const snapshot =
              runs.find(({ status }) =>
                ["running", "waiting", "paused"].includes(status),
              ) ?? runs[0];
            if (!snapshot) {
              return;
            }
            setRun(snapshot);
            const subscription = await context.loops.subscribe(
              snapshot.id,
              () => refresh(snapshot.id, currentGeneration),
            );
            if (!active || currentGeneration !== generation) {
              subscription.dispose();
              return;
            }
            runSubscription = subscription;
            await refresh(snapshot.id, currentGeneration);
          })
          .catch((error: unknown) => {
            if (active && currentGeneration === generation) {
              setRuntimeError(
                error instanceof Error ? error.message : String(error),
              );
            }
          });
      });

      onCleanup(() => {
        active = false;
        generation += 1;
        runSubscription?.dispose();
      });

      return (
        <section data-testid="loop-debug-workspace">
          <div class="flex items-start justify-between gap-6">
            <div>
              <p class="text-xs font-semibold uppercase tracking-[0.24em] text-[var(--accent)]">
                Slice 3 runtime
              </p>
              <h2 class="mt-2 text-3xl font-semibold tracking-tight">
                ReAct loop debugger
              </h2>
              <p class="mt-2 max-w-2xl text-sm text-[var(--text-muted)]">
                Scripted model journeys exercise the same tool, approval, feedback,
                interaction, and cost services future product plugins will use.
              </p>
            </div>
            <div class="rounded-xl bg-[var(--accent)]/10 p-3 text-[var(--accent)]">
              <Bot aria-hidden="true" size={24} />
            </div>
          </div>

          <div class="mt-8 grid gap-4 md:grid-cols-2">
            <button
              type="button"
              class="rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-5 text-left transition hover:border-[var(--accent)]/60"
              onClick={() => void start("scenario:approval")}
              data-testid="run-approval-scenario"
            >
              <Play aria-hidden="true" size={18} class="text-[var(--accent)]" />
              <span class="mt-4 block font-semibold">Tool approval</span>
              <span class="mt-1 block text-sm text-[var(--text-muted)]">
                Ask before executing tools.echo.
              </span>
            </button>
            <button
              type="button"
              class="rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-5 text-left transition hover:border-[var(--accent)]/60"
              onClick={() => void start("scenario:feedback")}
              data-testid="run-feedback-scenario"
            >
              <MessageCircleQuestion
                aria-hidden="true"
                size={18}
                class="text-[var(--accent)]"
              />
              <span class="mt-4 block font-semibold">Ask user</span>
              <span class="mt-1 block text-sm text-[var(--text-muted)]">
                Wait for feedback.ask and continue.
              </span>
            </button>
          </div>

          <Show when={runtimeError()}>
            {(message) => (
              <Panel class="mt-6 border-[var(--danger)]/40 text-[var(--danger)]">
                {message()}
              </Panel>
            )}
          </Show>

          <Show when={run()}>
            {(current) => (
              <Panel class="mt-6" data-testid="loop-run-result">
                <div class="flex items-center justify-between gap-4">
                  <div>
                    <p class="text-xs uppercase tracking-widest text-[var(--text-subtle)]">
                      Run {current().id.slice(0, 8)}
                    </p>
                    <p class="mt-2 text-lg font-semibold" data-testid="loop-run-status">
                      {current().status}
                    </p>
                  </div>
                  <div class="flex items-center gap-2 text-xs text-[var(--text-muted)]">
                    <CircleDollarSign aria-hidden="true" size={16} />
                    {current().inputTokens + current().outputTokens} tokens ·{" "}
                    {Object.entries(current().costsByCurrency)
                      .map(
                        ([currency, amount]) =>
                          `${currency} ${amount.toFixed(3)}`,
                      )
                      .join(" + ") || "no cost"}
                  </div>
                </div>
                <Show when={current().output}>
                  <p class="mt-4 text-sm text-[var(--success)]" data-testid="loop-output">
                    {current().output}
                  </p>
                </Show>
                <Show when={current().error}>
                  <p class="mt-4 text-sm text-[var(--danger)]" data-testid="loop-error">
                    {current().error}
                  </p>
                </Show>
              </Panel>
            )}
          </Show>
        </section>
      );
    };

    return context.ui.registerWorkspaceView({
      id: "borg.mock-llm.debug",
      label: "Loop debugger",
      order: 10,
      placement: "developer",
      component: DebugLoop,
    });
  },
});
