import { TextField as KobalteTextField } from "@kobalte/core/text-field";
import { Show, type Component, type JSX } from "solid-js";
import {
  cn,
  controlClass,
  controlClassSm,
  labelClass,
  labelClassSm,
  omitUndefined,
} from "./cn";

export interface TextFieldProps {
  readonly value?: string | undefined;
  readonly onChange?: ((value: string) => void) | undefined;
  readonly label?: string | undefined;
  readonly description?: string | undefined;
  readonly error?: string | undefined;
  readonly placeholder?: string | undefined;
  readonly type?: string | undefined;
  readonly disabled?: boolean | undefined;
  readonly required?: boolean | undefined;
  readonly readOnly?: boolean | undefined;
  readonly class?: string | undefined;
  readonly inputClass?: string | undefined;
  readonly labelClass?: string | undefined;
  readonly size?: "sm" | "md" | undefined;
  readonly id?: string | undefined;
  readonly name?: string | undefined;
  readonly rows?: number | undefined;
  readonly spellcheck?: boolean | "true" | "false" | undefined;
  readonly autocomplete?: string | undefined;
  readonly min?: number | string | undefined;
  readonly max?: number | string | undefined;
  readonly step?: number | string | undefined;
  readonly maxLength?: number | undefined;
  readonly "data-testid"?: string | undefined;
  readonly "aria-label"?: string | undefined;
  readonly ref?:
    | ((element: HTMLInputElement | HTMLTextAreaElement) => void)
    | undefined;
  readonly onKeyDown?:
    | JSX.EventHandlerUnion<
        HTMLInputElement | HTMLTextAreaElement,
        KeyboardEvent
      >
    | undefined;
}

export const TextField: Component<TextFieldProps> = (props) => {
  const fieldClass = () =>
    cn(
      props.size === "sm" ? controlClassSm : controlClass,
      props.inputClass,
    );
  const labelCls = () =>
    cn(props.size === "sm" ? labelClassSm : labelClass, props.labelClass);
  return (
    <KobalteTextField
      value={props.value ?? ""}
      class={cn("grid gap-1.5", props.class)}
      {...omitUndefined({
        onChange: props.onChange,
        disabled: props.disabled,
        required: props.required,
        readOnly: props.readOnly,
        id: props.id,
        name: props.name,
        validationState: props.error ? ("invalid" as const) : undefined,
      })}
    >
      <Show when={props.label}>
        <KobalteTextField.Label class={labelCls()}>
          {props.label}
        </KobalteTextField.Label>
      </Show>
      <Show
        when={props.rows !== undefined}
        fallback={
          <KobalteTextField.Input
            type={props.type ?? "text"}
            class={fieldClass()}
            {...omitUndefined({
              placeholder: props.placeholder,
              spellcheck: props.spellcheck,
              autocomplete: props.autocomplete,
              min: props.min,
              max: props.max,
              step: props.step,
              maxLength: props.maxLength,
              "data-testid": props["data-testid"],
              "aria-label": props["aria-label"],
              ref: props.ref,
              onKeyDown: props.onKeyDown,
            })}
          />
        }
      >
        <KobalteTextField.TextArea
          class={cn(fieldClass(), "resize-y")}
          {...omitUndefined({
            placeholder: props.placeholder,
            spellcheck: props.spellcheck,
            rows: props.rows,
            maxLength: props.maxLength,
            "data-testid": props["data-testid"],
            "aria-label": props["aria-label"],
            ref: props.ref,
            onKeyDown: props.onKeyDown,
          })}
        />
      </Show>
      <Show when={props.description}>
        <KobalteTextField.Description class="text-xs text-[var(--text-subtle)]">
          {props.description}
        </KobalteTextField.Description>
      </Show>
      <Show when={props.error}>
        <KobalteTextField.ErrorMessage class="text-xs text-[var(--danger)]">
          {props.error}
        </KobalteTextField.ErrorMessage>
      </Show>
    </KobalteTextField>
  );
};
