import { Button, Dialog } from "@borg/ui-kit";
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
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !props.launching) props.onCancel();
      }}
      title="Graph inputs"
      description="Fill the fields this graph expects, then launch."
      data-testid="graph-launch-dialog"
    >
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
    </Dialog>
  );
};

export default LaunchDialog;
