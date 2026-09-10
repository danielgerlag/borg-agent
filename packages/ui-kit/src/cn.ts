import { twMerge } from "tailwind-merge";

export function cn(
  ...values: ReadonlyArray<string | false | null | undefined>
): string {
  return twMerge(
    values.filter((value): value is string => typeof value === "string"),
  );
}

export function omitUndefined<T extends Record<string, unknown>>(
  value: T,
): {
  [K in keyof T as undefined extends T[K] ? never : K]: T[K];
} & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
} {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as never;
}

export const controlClass =
  "w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-45";

export const controlClassSm =
  "w-full rounded-xl border border-[var(--border)] bg-[var(--background)] px-3 py-2 text-xs text-[var(--text)] outline-none focus:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-45";

export const labelClass = "block text-sm text-[var(--text-muted)]";

export const labelClassSm =
  "block text-[10px] font-medium uppercase tracking-wider text-[var(--text-subtle)]";

export const overlayInputStyle = {
  appearance: "none",
  background: "transparent",
  border: "0",
  clip: "auto",
  "clip-path": "none",
  cursor: "pointer",
  height: "100%",
  margin: "0",
  overflow: "visible",
  padding: "0",
  position: "absolute",
  width: "100%",
  opacity: 0.01,
} as const;
