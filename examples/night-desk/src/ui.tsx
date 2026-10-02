import { defineUiPlugin } from "@borg-agent/plugin-sdk";
import { Button, Panel } from "@borg/ui-kit";
import {
  Match,
  Show,
  Switch,
  createResource,
  createSignal,
  type Component,
} from "solid-js";
import { nightDeskGetPage, nightDeskMitigate } from "./contract";

export const nightDeskUiMetadata = {
  id: "example.night-desk.ui",
  permissions: ["ui.workspace"],
  contributes: { kinds: ["workspaceView"] },
} as const;

export default defineUiPlugin<Component>({
  id: nightDeskUiMetadata.id,
  activate(context) {
    const NightDesk: Component = () => {
      const [page] = createResource(() =>
        context.bus.invoke(nightDeskGetPage, { pageId: "p-19" }),
      );
      const [action, setAction] = createSignal<string | undefined>();
      const [failure, setFailure] = createSignal<string | undefined>();
      const [busy, setBusy] = createSignal(false);

      const mitigate = async (): Promise<void> => {
        const current = page();
        if (!current) {
          return;
        }
        setBusy(true);
        setFailure(undefined);
        try {
          const result = await context.bus.invoke(nightDeskMitigate, {
            host: current.host,
            symptom: current.symptom,
          });
          setAction(result.action);
        } catch (error) {
          setFailure(error instanceof Error ? error.message : "Mitigation failed");
        } finally {
          setBusy(false);
        }
      };

      return (
        <main
          class="min-h-screen bg-[var(--background)] px-8 py-10 text-[var(--text)]"
          data-testid="night-desk"
        >
          <p class="text-xs font-semibold uppercase tracking-[0.24em] text-[var(--accent)]">
            On call
          </p>
          <h1 class="mt-2 text-3xl font-semibold">Night desk</h1>
          <p class="mt-2 max-w-xl text-sm text-[var(--text-muted)]">
            Page p-19 is open. The runbook owns the mitigation.
          </p>
          <Panel class="mt-8 max-w-xl" data-testid="night-desk-page">
            <Switch>
              <Match when={page.loading}>
                <p class="text-sm text-[var(--text-muted)]">Reading the page.</p>
              </Match>
              <Match when={page.error}>
                {(error) => (
                  <p class="text-sm text-[var(--danger)]" data-testid="night-desk-page-error">
                    {error() instanceof Error ? error().message : "The page could not be read."}
                  </p>
                )}
              </Match>
              <Match when={page()}>
                {(resolved) => (
                  <div>
                    <p class="font-mono text-sm text-[var(--accent)]">p-19</p>
                    <h2 class="mt-3 text-2xl font-semibold">{resolved().host}</h2>
                    <p class="mt-2 text-lg text-[var(--text)]" data-testid="night-desk-symptom">
                      {resolved().symptom}
                    </p>
                    <Button
                      class="mt-6"
                      data-testid="night-desk-mitigate"
                      disabled={busy() || action() !== undefined}
                      onClick={() => {
                        void mitigate();
                      }}
                    >
                      Run the mitigation
                    </Button>
                    <Show when={failure()}>
                      {(message) => (
                        <p
                          class="mt-4 text-sm text-[var(--danger)]"
                          data-testid="night-desk-failure"
                        >
                          {message()}
                        </p>
                      )}
                    </Show>
                    <Show when={action()}>
                      {(taken) => (
                        <p
                          class="mt-4 text-sm text-[var(--success)]"
                          data-testid="night-desk-action"
                        >
                          {taken()}
                        </p>
                      )}
                    </Show>
                  </div>
                )}
              </Match>
            </Switch>
          </Panel>
        </main>
      );
    };

    context.ui.registerWorkspaceView({
      id: "night-desk.board",
      label: "Night desk",
      component: NightDesk,
    });
  },
});
