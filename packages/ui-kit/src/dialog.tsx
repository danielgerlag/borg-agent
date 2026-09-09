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
            "w-full max-w-lg rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-5 shadow-[0_24px_70px_rgba(0,0,0,0.24)] outline-none",
            props.class,
          )}
          data-testid={props["data-testid"]}
        >
          <KobalteDialog.Title class="text-sm font-semibold">
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
