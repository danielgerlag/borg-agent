import { Button } from "@borg/ui-kit";
import { Show, createMemo, type Component } from "solid-js";
import { missingRequiredFields } from "./schema";
import SchemaForm from "./schema-form";

export interface LaunchDialogProps {
  readonly schema: unknown;
  readonly value: Record<string, unknown>;
  readonly onChange: (value: Record<string, unknown>) => void;
  readonly onCancel: () => void;
  readonly onLaunch: () => void;
  readonly launching: boolean;
}

const LaunchDialog: Component<LaunchDialogProps> = (props) => {
  const blocked = createMemo(
    () => missingRequiredFields(props.schema, props.value).length > 0,
  );
  return (
    <div
      class="fixed inset-0 z-50 grid place-items-center bg-black/65 p-5 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="graph-launch-title"
      data-testid="graph-launch-dialog"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !props.launching) {
          event.preventDefault();
          props.onCancel();
        }
      }}
    >
      <div class="w-full max-w-lg rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-5 shadow-[0_24px_70px_rgba(0,0,0,0.24)]">
        <h3 id="graph-launch-title" class="text-sm font-semibold">
          Graph inputs
        </h3>
        <p class="mt-1 text-xs text-[var(--text-muted)]">
          Fill the fields this graph expects, then launch.
        </p>
        <div class="mt-4 max-h-[50vh] overflow-y-auto">
          <SchemaForm
            schema={props.schema}
            value={props.value}
            onChange={props.onChange}
            disabled={props.launching}
            testId="graph-launch-input"
          />
        </div>
        <Show when={blocked()}>
          <p class="mt-3 text-xs text-[var(--danger)]">
            Fill every required field before launching.
          </p>
        </Show>
        <div class="mt-4 flex justify-end gap-2">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={props.launching}
            onClick={props.onCancel}
          >
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={props.launching || blocked()}
            onClick={props.onLaunch}
          >
            {props.launching ? "Launching…" : "Launch"}
          </Button>
        </div>
      </div>
    </div>
  );
};

export default LaunchDialog;
