import { Dialog as KobalteDialog } from "@kobalte/core/dialog";
import { type ParentComponent } from "solid-js";
import { cn } from "./cn";

export interface DialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly description?: string;
  readonly class?: string;
  readonly "data-testid"?: string;
}

export const Dialog: ParentComponent<DialogProps> = (props) => (
  <KobalteDialog open={props.open} onOpenChange={props.onOpenChange} modal>
    <KobalteDialog.Portal>
      <KobalteDialog.Overlay class="fixed inset-0 z-50 bg-black/65 backdrop-blur-sm" />
      <div class="fixed inset-0 z-50 grid place-items-center p-5">
        <KobalteDialog.Content
          class={cn(
            "relative w-full max-w-lg rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-5 shadow-[0_24px_70px_rgba(0,0,0,0.24)] outline-none",
            props.class,
          )}
          data-testid={props["data-testid"]}
        >
          <KobalteDialog.CloseButton
            class="absolute right-3 top-3 inline-flex size-8 items-center justify-center rounded-lg text-[var(--text-subtle)] hover:bg-[var(--panel-muted)] hover:text-[var(--text)]"
            aria-label="Close"
          >
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
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </KobalteDialog.CloseButton>
          <KobalteDialog.Title class="pr-8 text-sm font-semibold">
            {props.title}
          </KobalteDialog.Title>
          {props.description ? (
            <KobalteDialog.Description class="mt-1 text-xs text-[var(--text-muted)]">
              {props.description}
            </KobalteDialog.Description>
          ) : null}
          {props.children}
        </KobalteDialog.Content>
      </div>
    </KobalteDialog.Portal>
  </KobalteDialog>
);
