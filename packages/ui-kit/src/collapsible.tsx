import { Collapsible as KobalteCollapsible } from "@kobalte/core/collapsible";
import { type ParentComponent } from "solid-js";
import { cn, omitUndefined } from "./cn";

export interface CollapsibleProps {
  readonly defaultOpen?: boolean;
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  readonly trigger: string;
  readonly class?: string;
  readonly triggerClass?: string;
  readonly "data-testid"?: string;
}

export const Collapsible: ParentComponent<CollapsibleProps> = (props) => (
  <KobalteCollapsible
    forceMount
    class={cn(
      "rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2",
      props.class,
    )}
    {...omitUndefined({
      defaultOpen: props.defaultOpen,
      open: props.open,
      onOpenChange: props.onOpenChange,
    })}
  >
    <KobalteCollapsible.Trigger
      class={cn(
        "flex w-full cursor-pointer items-center justify-between text-left text-sm font-semibold outline-none",
        props.triggerClass,
      )}
      {...omitUndefined({ "data-testid": props["data-testid"] })}
    >
      {props.trigger}
    </KobalteCollapsible.Trigger>
    <KobalteCollapsible.Content class="mt-2">
      {props.children}
    </KobalteCollapsible.Content>
  </KobalteCollapsible>
);
