import { defineUiPlugin } from "@borg-agent/plugin-sdk";
import { Button, Panel } from "@borg/ui-kit";
import { For, Show, createSignal, type Component } from "solid-js";
import { fieldObserve, fieldVoucher } from "./contract";

const species = "cicindela sexguttata";
const places = [
  { id: "thunder-bay", place: "thunder bay", label: "Thunder Bay" },
  { id: "point-pelee", place: "point pelee", label: "Point Pelee" },
] as const;

export const fieldCatalogUiMetadata = {
  id: "example.field.ui",
  permissions: ["ui.workspace"],
  contributes: { kinds: ["workspaceView"] },
} as const;

export default defineUiPlugin<Component>({
  id: fieldCatalogUiMetadata.id,
  activate(context) {
    const FieldCatalog: Component = () => {
      const [place, setPlace] = createSignal<string | undefined>();
      const [inRange, setInRange] = createSignal<boolean | undefined>();
      const [voucher, setVoucher] = createSignal<string | undefined>();
      const [reason, setReason] = createSignal<string | undefined>();
      const [failure, setFailure] = createSignal<string | undefined>();
      const [busy, setBusy] = createSignal(false);

      const observe = async (nextPlace: string): Promise<void> => {
        setBusy(true);
        setFailure(undefined);
        setVoucher(undefined);
        setReason(undefined);
        try {
          const sighting = await context.bus.invoke(fieldObserve, {
            species,
            place: nextPlace,
          });
          setPlace(sighting.place);
          setInRange(sighting.inRange);
        } catch (error) {
          setFailure(error instanceof Error ? error.message : "Observe failed");
        } finally {
          setBusy(false);
        }
      };

      const file = async (): Promise<void> => {
        const current = place();
        if (!current) {
          return;
        }
        setBusy(true);
        setFailure(undefined);
        try {
          const result = await context.bus.invoke(fieldVoucher, {
            species,
            place: current,
          });
          if (result.filed) {
            setVoucher(result.voucher);
            setReason(undefined);
          } else {
            setVoucher(undefined);
            setReason(result.reason);
          }
        } catch (error) {
          setFailure(error instanceof Error ? error.message : "Voucher failed");
        } finally {
          setBusy(false);
        }
      };

      return (
        <main
          class="min-h-screen bg-[var(--background)] px-8 py-10 text-[var(--text)]"
          data-testid="field-catalog"
        >
          <p class="text-xs font-semibold uppercase tracking-[0.24em] text-[var(--accent)]">
            Specimen
          </p>
          <h1 class="mt-2 text-3xl font-semibold">Field catalog</h1>
          <p class="mt-2 font-mono text-sm text-[var(--text-muted)]">{species}</p>
          <Panel class="mt-8 max-w-xl">
            <p class="text-sm text-[var(--text-muted)]">Record the place.</p>
            <div class="mt-4 flex gap-3">
              <For each={places}>
                {(entry) => (
                  <Button
                    variant={place() === entry.place ? "primary" : "secondary"}
                    data-testid={`field-place-${entry.id}`}
                    disabled={busy()}
                    onClick={() => {
                      void observe(entry.place);
                    }}
                  >
                    {entry.label}
                  </Button>
                )}
              </For>
            </div>
            <Show when={place()}>
              {(current) => (
                <p class="mt-6 text-lg" data-testid="field-sighting">
                  {current()} is {inRange() ? "in range" : "out of range"}
                </p>
              )}
            </Show>
            <Button
              class="mt-6"
              data-testid="field-voucher"
              disabled={busy() || place() === undefined}
              onClick={() => {
                void file();
              }}
            >
              File voucher
            </Button>
            <Show when={voucher()}>
              {(id) => (
                <p class="mt-4 text-sm text-[var(--success)]" data-testid="field-voucher-result">
                  Voucher {id()}
                </p>
              )}
            </Show>
            <Show when={reason()}>
              {(message) => (
                <p class="mt-4 text-sm text-[var(--danger)]" data-testid="field-voucher-result">
                  {message()}
                </p>
              )}
            </Show>
            <Show when={failure()}>
              {(message) => (
                <p class="mt-4 text-sm text-[var(--danger)]">{message()}</p>
              )}
            </Show>
          </Panel>
        </main>
      );
    };

    context.ui.registerWorkspaceView({
      id: "field.catalog",
      label: "Field catalog",
      component: FieldCatalog,
    });
  },
});
