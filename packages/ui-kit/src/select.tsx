import { Select as KobalteSelect } from "@kobalte/core/select";
import { Show, type Component } from "solid-js";
import {
  cn,
  controlClass,
  controlClassSm,
  labelClass,
  labelClassSm,
  omitUndefined,
} from "./cn";

export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

export interface SelectGroup {
  readonly label: string;
  readonly options: readonly SelectOption[];
}

export interface SelectProps {
  readonly value?: string | undefined;
  readonly onChange?: ((value: string) => void) | undefined;
  readonly options?: readonly SelectOption[] | undefined;
  readonly groups?: readonly SelectGroup[] | undefined;
  readonly label?: string | undefined;
  readonly placeholder?: string | undefined;
  readonly disabled?: boolean | undefined;
  readonly required?: boolean | undefined;
  readonly class?: string | undefined;
  readonly triggerClass?: string | undefined;
  readonly labelClass?: string | undefined;
  readonly size?: "sm" | "md" | undefined;
  readonly "data-testid"?: string | undefined;
  readonly onOpenChange?: ((open: boolean) => void) | undefined;
}

export const Select: Component<SelectProps> = (props) => {
  const flatOptions = (): SelectOption[] =>
    props.groups
      ? props.groups.flatMap((group) => [...group.options])
      : [...(props.options ?? [])];
  const selected = (): SelectOption | null =>
    flatOptions().find((option) => option.value === (props.value ?? "")) ??
    null;
  const grouped = (): boolean => (props.groups?.length ?? 0) > 0;

  return (
    <KobalteSelect<SelectOption, SelectGroup>
      options={
        grouped()
          ? props.groups!.map((group) => ({
              label: group.label,
              options: [...group.options],
            }))
          : flatOptions()
      }
      optionValue="value"
      optionTextValue="label"
      value={selected()}
      onChange={(option) => {
        if (!option) {
          return;
        }
        props.onChange?.(option.value);
      }}
      disallowEmptySelection={false}
      itemComponent={(itemProps) => (
        <KobalteSelect.Item
          item={itemProps.item}
          class="flex cursor-pointer items-center rounded-lg px-2 py-1.5 text-sm text-[var(--text)] outline-none data-[highlighted]:bg-[var(--accent)]/12 data-[highlighted]:text-[var(--accent)]"
        >
          <KobalteSelect.ItemLabel>
            {itemProps.item.rawValue.label}
          </KobalteSelect.ItemLabel>
        </KobalteSelect.Item>
      )}
      class={cn("grid gap-1.5", props.class)}
      {...omitUndefined({
        placeholder: props.placeholder,
        disabled: props.disabled,
        required: props.required,
        onOpenChange: props.onOpenChange,
        optionGroupChildren: grouped() ? ("options" as const) : undefined,
        sectionComponent: grouped()
          ? (sectionProps: { section: { rawValue: SelectGroup } }) => (
              <KobalteSelect.Section class="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-subtle)]">
                {sectionProps.section.rawValue.label}
              </KobalteSelect.Section>
            )
          : undefined,
      })}
    >
      <Show when={props.label}>
        <KobalteSelect.Label
          class={cn(
            props.size === "sm" ? labelClassSm : labelClass,
            props.labelClass,
          )}
        >
          {props.label}
        </KobalteSelect.Label>
      </Show>
      <KobalteSelect.HiddenSelect data-testid={props["data-testid"]} />
      <KobalteSelect.Trigger
        class={cn(
          props.size === "sm" ? controlClassSm : controlClass,
          "flex items-center justify-between gap-2 text-left",
          props.triggerClass,
        )}
      >
        <KobalteSelect.Value<SelectOption>>
          {(state) =>
            state.selectedOption()?.label ?? props.placeholder ?? ""
          }
        </KobalteSelect.Value>
        <KobalteSelect.Icon class="text-[var(--text-subtle)]">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            class="size-4"
            aria-hidden="true"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </KobalteSelect.Icon>
      </KobalteSelect.Trigger>
      <KobalteSelect.Portal>
        <KobalteSelect.Content class="z-50 min-w-[var(--kb-popper-anchor-width)] overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--panel)] shadow-[0_24px_70px_rgba(0,0,0,0.24)]">
          <KobalteSelect.Listbox class="m-0 max-h-60 overflow-auto p-1" />
        </KobalteSelect.Content>
      </KobalteSelect.Portal>
    </KobalteSelect>
  );
};
