import type { JSX, ParentComponent } from "solid-js";
import { twMerge } from "tailwind-merge";

export function cn(...values: ReadonlyArray<string | false | null | undefined>): string {
  return twMerge(values.filter((value): value is string => typeof value === "string"));
}

export interface PanelProps {
  readonly class?: string;
  readonly "data-testid"?: string;
}

export const Panel: ParentComponent<PanelProps> = (props) => (
  <section
    class={cn(
      "rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-5 shadow-[0_24px_70px_rgba(0,0,0,0.24)]",
      props.class,
    )}
    data-testid={props["data-testid"]}
  >
    {props.children}
  </section>
);

export interface IconButtonProps extends JSX.ButtonHTMLAttributes<HTMLButtonElement> {
  readonly label: string;
}

export const IconButton: ParentComponent<IconButtonProps> = (props) => (
  <button
    {...props}
    aria-label={props.label}
    class={cn(
      "inline-flex size-9 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--panel-muted)] text-[var(--text-muted)] transition hover:border-[var(--accent)] hover:text-[var(--text)]",
      props.class,
    )}
  >
    {props.children}
  </button>
);
