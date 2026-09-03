import { createSignal, type Accessor, type Setter } from "solid-js";

export class ToastStore {
  readonly toasts: Accessor<readonly RendererNotification[]>;
  readonly #setToasts: Setter<readonly RendererNotification[]>;
  readonly #unsubscribe: () => void;
  readonly #timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(shellCapability: string) {
    const [toasts, setToasts] = createSignal<readonly RendererNotification[]>([]);
    this.toasts = toasts;
    this.#setToasts = setToasts;
    this.#unsubscribe = window.borg.notifications.subscribe(
      shellCapability,
      (notification) => {
        this.#setToasts((current) => [...current.slice(-3), notification]);
        const timer = setTimeout(() => {
          this.dismiss(notification.id);
          this.#timers.delete(timer);
        }, 4_000);
        this.#timers.add(timer);
      },
    );
  }

  dismiss(id: string): void {
    this.#setToasts((current) =>
      current.filter((notification) => notification.id !== id),
    );
  }

  dispose(): void {
    this.#unsubscribe();
    for (const timer of this.#timers) {
      clearTimeout(timer);
    }
    this.#timers.clear();
  }
}
