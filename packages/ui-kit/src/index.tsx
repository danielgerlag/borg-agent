import { splitProps, type JSX, type ParentComponent } from "solid-js";
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

export interface ButtonProps
  extends JSX.ButtonHTMLAttributes<HTMLButtonElement> {
  readonly variant?: "primary" | "secondary" | "ghost" | "danger";
  readonly size?: "sm" | "md" | "lg";
}

export const Button: ParentComponent<ButtonProps> = (props) => {
  const [local, buttonProps] = splitProps(props, [
    "children",
    "class",
    "variant",
    "size",
  ]);
  return (
    <button
      {...buttonProps}
      class={cn(
        "inline-flex items-center justify-center gap-2 rounded-xl font-semibold transition disabled:cursor-not-allowed disabled:opacity-45",
        (local.variant ?? "primary") === "primary" &&
          "bg-[var(--accent)] text-[var(--accent-contrast)] hover:brightness-110",
        local.variant === "secondary" &&
          "border border-[var(--border)] bg-[var(--panel-muted)] text-[var(--text)] hover:border-[var(--border-strong)]",
        local.variant === "ghost" &&
          "text-[var(--text-muted)] hover:bg-[var(--panel-muted)] hover:text-[var(--text)]",
        local.variant === "danger" &&
          "border border-[var(--danger)]/45 bg-[var(--danger)]/10 text-[var(--danger)] hover:bg-[var(--danger)]/15",
        (local.size ?? "md") === "sm" && "px-3 py-2 text-xs",
        (local.size ?? "md") === "md" && "px-4 py-2.5 text-sm",
        local.size === "lg" && "px-5 py-3 text-base",
        local.class,
      )}
    >
      {local.children}
    </button>
  );
};

export interface EmptyStateProps {
  readonly eyebrow?: string;
  readonly title: string;
  readonly description: string;
  readonly class?: string;
}

export const EmptyState: ParentComponent<EmptyStateProps> = (props) => (
  <section
    class={cn(
      "mx-auto flex max-w-xl flex-col items-center px-6 py-12 text-center",
      props.class,
    )}
  >
    {props.eyebrow ? (
      <p class="text-xs font-semibold uppercase tracking-[0.2em] text-[var(--accent)]">
        {props.eyebrow}
      </p>
    ) : null}
    <h2 class="mt-2 text-3xl font-semibold tracking-tight text-[var(--text)]">
      {props.title}
    </h2>
    <p class="mt-3 max-w-md text-sm leading-6 text-[var(--text-muted)]">
      {props.description}
    </p>
    {props.children}
  </section>
);
