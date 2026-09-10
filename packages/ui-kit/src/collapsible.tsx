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
        "group flex w-full cursor-pointer items-center justify-between gap-2 text-left text-sm font-semibold outline-none",
        props.triggerClass,
      )}
      {...omitUndefined({ "data-testid": props["data-testid"] })}
    >
      <span>{props.trigger}</span>
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="size-4 shrink-0 text-[var(--text-subtle)] transition-transform duration-150 group-data-[expanded]:rotate-180"
        aria-hidden="true"
      >
        <path d="m6 9 6 6 6-6" />
      </svg>
    </KobalteCollapsible.Trigger>
    <KobalteCollapsible.Content class="overflow-hidden data-[closed]:h-0 data-[closed]:m-0 data-[expanded]:mt-2">
      {props.children}
    </KobalteCollapsible.Content>
  </KobalteCollapsible>
);
