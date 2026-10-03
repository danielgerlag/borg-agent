import { createSignal, For, onMount, Show } from "solid-js";
import { benchApi, type BenchInteraction } from "./bridge.js";
import {
  printBenchAct,
  printBenchSnapshot,
  snapshotSchema,
  type ActInput,
  type BenchSnapshot,
} from "../contract.js";
import { DesignView } from "./design.js";
import { FlightDeck } from "./flight-deck.js";
import { SettingsView } from "./settings.js";

type Surface = "design" | "flight-deck" | "settings";
type SettingsSection = "machine" | "model";

const workspaceTabs: readonly { id: Surface; label: string; testId: string }[] = [
  { id: "design", label: "Design", testId: "workspace-view-tab-print-bench.design" },
];

export function Bench() {
  const [snapshot, setSnapshot] = createSignal<BenchSnapshot | undefined>();
  const [pending, setPending] = createSignal<BenchInteraction | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [surface, setSurface] = createSignal<Surface>("design");
  const [settingsSection, setSettingsSection] = createSignal<SettingsSection>("machine");
  const [startedAt] = createSignal(new Date().toISOString());

  onMount(() => {
    void refresh().catch((caught: unknown) => setError(messageOf(caught)));
  });

  let snapshotToken = 0;

  async function refresh(): Promise<void> {
    const token = ++snapshotToken;
    const next = snapshotSchema.parse(await benchApi().command.invoke(printBenchSnapshot.id, {}));
    if (token === snapshotToken) {
      setSnapshot(next);
    }
  }

  async function run(input: ActInput): Promise<void> {
    if (busy()) {
      return;
    }
    setBusy(true);
    setError(null);
    const stop = watchApprovals();
    const timer = setInterval(() => {
      void refresh().catch(() => undefined);
    }, 200);
    try {
      const result = printBenchAct.output.parse(
        await benchApi().command.invoke(printBenchAct.id, input),
      );
      const token = ++snapshotToken;
      if (token === snapshotToken) {
        setSnapshot(result.snapshot);
      }
    } catch (caught) {
      setError(messageOf(caught));
      await refresh().catch(() => undefined);
    } finally {
      clearInterval(timer);
      stop();
      setPending(null);
      setBusy(false);
    }
  }

  function watchApprovals(): () => void {
    let stopped = false;
    const pull = (): void => {
      void benchApi()
        .interactions.list()
        .then((items) => {
          if (!stopped) {
            setPending(items[0] ?? null);
          }
        })
        .catch((caught: unknown) => {
          if (!stopped) {
            setError(messageOf(caught));
          }
        });
    };
    pull();
    const timer = setInterval(pull, 40);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }

  return (
    <Show
      when={snapshot()}
      fallback={<p class="p-6 text-[var(--text-muted)]">Opening the bench</p>}
    >
      {(current) => (
        <div class="grid h-full grid-cols-1 bg-[var(--background)] text-[var(--text)] lg:grid-cols-[11rem_minmax(0,1fr)]">
          <aside class="flex flex-col border-b border-[var(--border)] bg-[var(--sidebar)] p-3 lg:border-r lg:border-b-0">
            <div class="flex h-11 items-center px-2">
              <div>
                <p class="text-sm font-semibold tracking-wide">Borg</p>
                <p class="text-xs text-[var(--text-subtle)]">Print</p>
              </div>
            </div>
            <nav class="mt-7 flex flex-1 flex-col gap-1" aria-label="Main navigation">
              <For each={workspaceTabs}>
                {(tab) => (
                  <RailButton
                    label={tab.label}
                    testId={tab.testId}
                    active={surface() === tab.id}
                    onClick={() => setSurface(tab.id)}
                  />
                )}
              </For>
              <RailButton
                label="Flight deck"
                testId="nav-flight-deck"
                active={surface() === "flight-deck"}
                badge={pending() ? 1 : 0}
                onClick={() => setSurface("flight-deck")}
              />
            </nav>
            <RailButton
              label="Settings"
              testId="nav-settings"
              active={surface() === "settings"}
              onClick={() => setSurface("settings")}
            />
          </aside>
          <main class="min-h-0 min-w-0 overflow-hidden">
            <Show when={pending()?.kind === "human_input" && surface() !== "design"}>
              <button
                type="button"
                class="w-full border-b border-[var(--border)] px-5 py-2 text-left text-sm text-[var(--accent)]"
                onClick={() => setSurface("design")}
              >
                The designer asked a question.
              </button>
            </Show>
            <Show when={error()}>
              <p class="border-b border-[var(--border)] px-5 py-2 text-sm text-[var(--danger)]">{error()}</p>
            </Show>
            <Show when={surface() === "design"}>
              <div class="h-full min-h-0" data-testid="surface-workspace">
                <DesignView
                  snapshot={current()}
                  busy={busy()}
                  pending={pending()}
                  run={(input) => void run(input)}
                  onAnswer={async (response) => {
                    const item = pending();
                    if (!item) {
                      return false;
                    }
                    return benchApi().interactions.respond(item.id, response);
                  }}
                />
              </div>
            </Show>
            <Show when={surface() === "flight-deck"}>
              <FlightDeck
                snapshot={current()}
                busy={busy()}
                pending={pending()}
                startedAt={startedAt()}
                run={(input) => void run(input)}
              />
            </Show>
            <Show when={surface() === "settings"}>
              <SettingsView
                snapshot={current()}
                busy={busy()}
                section={settingsSection()}
                onSection={setSettingsSection}
                run={(input) => void run(input)}
              />
            </Show>
          </main>
        </div>
      )}
    </Show>
  );
}

function RailButton(props: {
  label: string;
  testId: string;
  active: boolean;
  badge?: number;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      class="flex h-10 w-full items-center gap-3 rounded-xl px-3 text-sm font-medium transition"
      classList={{
        "bg-[var(--accent)]/14 text-[var(--accent)]": props.active,
        "text-[var(--text-subtle)] hover:bg-[var(--panel-muted)] hover:text-[var(--text)]": !props.active,
      }}
      aria-label={props.label}
      aria-current={props.active ? "page" : undefined}
      data-testid={props.testId}
      onClick={props.onClick}
    >
      <span>{props.label}</span>
      <Show when={(props.badge ?? 0) > 0}>
        <span class="ml-auto grid min-w-5 place-items-center rounded-full bg-[var(--danger)] px-1 text-[10px] font-bold text-white">
          {props.badge}
        </span>
      </Show>
    </button>
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "The bench could not apply that";
}
