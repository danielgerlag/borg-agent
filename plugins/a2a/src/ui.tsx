import {
  a2aConfigSchema,
  a2aGetStatus,
  type A2AStatus,
  type Persona,
} from "@borg/contracts";
import { defineUiPlugin } from "@borg/plugin-sdk";
import { Button, Panel } from "@borg/ui-kit";
import { Radio } from "lucide-solid";
import { For, createSignal, onMount, type Component } from "solid-js";

const IDLE_STATUS: A2AStatus = {
  enabled: false,
  listening: false,
  port: 8_733,
};

export default defineUiPlugin<Component>({
  id: "borg.a2a",
  activate(context) {
    const A2ASettings: Component = () => {
      const [status, setStatus] = createSignal<A2AStatus>(IDLE_STATUS);
      const [enabled, setEnabled] = createSignal(false);
      const [port, setPort] = createSignal("8733");
      const [personaId, setPersonaId] = createSignal("");
      const [personas, setPersonas] = createSignal<readonly Persona[]>([]);
      const [busy, setBusy] = createSignal(false);
      const [message, setMessage] = createSignal(
        "Disabled. Loopback JSON-RPC is off until you enable it.",
      );
      const [error, setError] = createSignal<string>();

      const refresh = async (): Promise<void> => {
        const [config, current, listed] = await Promise.all([
          context.config.get(),
          context.bus.invoke(a2aGetStatus, {}),
          context.personas.list(),
        ]);
        const parsed = a2aConfigSchema.parse(config);
        setEnabled(parsed.enabled);
        setPort(String(parsed.port));
        setPersonaId(parsed.personaId ?? "");
        setPersonas(listed);
        setStatus(current);
      };

      onMount(() => {
        void refresh().catch((failure: unknown) =>
          setError(failure instanceof Error ? failure.message : String(failure)),
        );
      });

      const save = async (): Promise<void> => {
        setBusy(true);
        setError(undefined);
        try {
          const parsedPort = Number.parseInt(port(), 10);
          await context.config.update({
            enabled: enabled(),
            port: parsedPort,
            personaId: personaId().trim(),
          });
          await refresh();
          const current = status();
          setMessage(
            current.listening
              ? `Listening on 127.0.0.1:${current.port}.`
              : enabled()
                ? "Enabled, but the loopback listener is not bound."
                : "A2A listener is disabled.",
          );
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure));
        } finally {
          setBusy(false);
        }
      };

      return (
        <Panel data-testid="a2a-settings-page">
          <div class="flex items-start gap-4">
            <div class="rounded-xl bg-[var(--accent)]/10 p-2.5 text-[var(--accent)]">
              <Radio aria-hidden="true" size={20} />
            </div>
            <div class="min-w-0 flex-1">
              <h3 class="text-xl font-semibold">Agent2Agent</h3>
              <p class="mt-2 text-sm text-[var(--text-muted)]">
                Expose the selected persona over A2A JSON-RPC on loopback only.
                The listener stays off until you enable it.
              </p>

              <label class="mt-5 flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={enabled()}
                  onChange={(event) => setEnabled(event.currentTarget.checked)}
                  data-testid="a2a-enabled"
                />
                Enable loopback A2A
              </label>

              <label class="mt-4 block text-sm text-[var(--text-muted)]" for="a2a-port">
                Port
              </label>
              <input
                id="a2a-port"
                type="number"
                min="1"
                max="65535"
                value={port()}
                onInput={(event) => setPort(event.currentTarget.value)}
                class="mt-2 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm"
                data-testid="a2a-port"
              />

              <label
                class="mt-4 block text-sm text-[var(--text-muted)]"
                for="a2a-persona"
              >
                Persona
              </label>
              <select
                id="a2a-persona"
                value={personaId()}
                onChange={(event) => setPersonaId(event.currentTarget.value)}
                class="mt-2 w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm"
                data-testid="a2a-persona"
              >
                <option value="">Default persona</option>
                <For each={personas()}>
                  {(persona) => <option value={persona.id}>{persona.name}</option>}
                </For>
              </select>

              <div class="mt-4">
                <Button
                  type="button"
                  disabled={busy()}
                  onClick={() => void save()}
                  data-testid="a2a-save"
                >
                  {busy() ? "Saving…" : "Save"}
                </Button>
              </div>

              <p
                class="mt-3 text-xs"
                classList={{
                  "text-[var(--success)]": status().listening && !error(),
                  "text-[var(--text-muted)]": !status().listening && !error(),
                  "text-[var(--danger)]": Boolean(error()),
                }}
                data-testid="a2a-status"
              >
                {error() ??
                  (status().listening
                    ? `Listening on 127.0.0.1:${status().port}.`
                    : message())}
              </p>
            </div>
          </div>
        </Panel>
      );
    };

    const A2AWidget: Component = () => {
      const [status, setStatus] = createSignal<A2AStatus>(IDLE_STATUS);

      onMount(() => {
        void context.bus
          .invoke(a2aGetStatus, {})
          .then(setStatus)
          .catch(() => undefined);
      });

      return (
        <Panel data-testid="a2a-widget">
          <p class="text-sm font-semibold">A2A listener</p>
          <p class="mt-1 text-xs text-[var(--text-muted)]" data-testid="a2a-widget-status">
            {status().listening
              ? `127.0.0.1:${status().port}`
              : "Disabled"}
          </p>
        </Panel>
      );
    };

    const settings = context.ui.registerSettingsPage({
      id: "borg.a2a.settings",
      label: "A2A",
      order: 50,
      component: A2ASettings,
    });
    const widget = context.ui.registerFlightDeckWidget({
      id: "borg.a2a.listener",
      label: "A2A listener",
      order: 40,
      component: A2AWidget,
    });
    return {
      dispose: async () => {
        await widget.dispose();
        await settings.dispose();
      },
    };
  },
});
