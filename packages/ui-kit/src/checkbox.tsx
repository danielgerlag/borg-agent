import { Checkbox as KobalteCheckbox } from "@kobalte/core/checkbox";
import { Show, type Component } from "solid-js";
import { cn, labelClass, omitUndefined, overlayInputStyle } from "./cn";

export interface CheckboxProps {
  readonly checked?: boolean | undefined;
  readonly onChange?: ((checked: boolean) => void) | undefined;
  readonly label?: string | undefined;
  readonly disabled?: boolean | undefined;
  readonly required?: boolean | undefined;
  readonly class?: string | undefined;
  readonly "data-testid"?: string | undefined;
  readonly "aria-label"?: string | undefined;
}

export const Checkbox: Component<CheckboxProps> = (props) => (
  <KobalteCheckbox
    checked={props.checked ?? false}
    class={cn("relative inline-flex items-center gap-2", props.class)}
    {...omitUndefined({
      onChange: props.onChange,
      disabled: props.disabled,
      required: props.required,
      "aria-label": props["aria-label"],
    })}
  >
    <KobalteCheckbox.Input
      class="absolute inset-0 z-10 cursor-pointer"
      style={overlayInputStyle}
      {...omitUndefined({ "data-testid": props["data-testid"] })}
    />
    <KobalteCheckbox.Control class="pointer-events-none flex size-4 shrink-0 items-center justify-center rounded border border-[var(--border)] bg-[var(--background)] outline-none data-[checked]:border-[var(--accent)] data-[checked]:bg-[var(--accent)]">
      <KobalteCheckbox.Indicator class="size-2.5 rounded-[1px] bg-[var(--accent-contrast)]" />
    </KobalteCheckbox.Control>
    <Show when={props.label}>
      <KobalteCheckbox.Label class={cn(labelClass, "text-[var(--text)]")}>
        {props.label}
      </KobalteCheckbox.Label>
    </Show>
  </KobalteCheckbox>
);
