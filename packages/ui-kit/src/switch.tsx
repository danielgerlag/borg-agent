import { Switch as KobalteSwitch } from "@kobalte/core/switch";
import { Show, type Component } from "solid-js";
import { cn, labelClass, omitUndefined, overlayInputStyle } from "./cn";

export interface SwitchProps {
  readonly checked?: boolean | undefined;
  readonly onChange?: ((checked: boolean) => void) | undefined;
  readonly label?: string | undefined;
  readonly disabled?: boolean | undefined;
  readonly class?: string | undefined;
  readonly "data-testid"?: string | undefined;
  readonly "aria-label"?: string | undefined;
}

export const Switch: Component<SwitchProps> = (props) => (
  <KobalteSwitch
    checked={props.checked ?? false}
    class={cn("relative inline-flex items-center gap-2", props.class)}
    {...omitUndefined({
      onChange: props.onChange,
      disabled: props.disabled,
      "aria-label": props["aria-label"],
    })}
  >
    <KobalteSwitch.Input
      class="absolute inset-0 z-10 cursor-pointer"
      style={overlayInputStyle}
      {...omitUndefined({ "data-testid": props["data-testid"] })}
    />
    <KobalteSwitch.Control class="pointer-events-none inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-[var(--border)] bg-[var(--background)] transition data-[checked]:border-[var(--accent)] data-[checked]:bg-[var(--accent)]">
      <KobalteSwitch.Thumb class="size-3.5 translate-x-0.5 rounded-full bg-[var(--text-muted)] transition-transform data-[checked]:translate-x-4 data-[checked]:bg-[var(--accent-contrast)]" />
    </KobalteSwitch.Control>
    <Show when={props.label}>
      <KobalteSwitch.Label class={cn(labelClass, "text-[var(--text)]")}>
        {props.label}
      </KobalteSwitch.Label>
    </Show>
  </KobalteSwitch>
);
