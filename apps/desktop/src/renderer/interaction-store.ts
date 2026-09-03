import type {
  InteractionResponse,
  PendingInteraction,
} from "@borg/contracts";
import { createSignal, type Accessor, type Setter } from "solid-js";

export class InteractionStore {
  readonly pending: Accessor<readonly PendingInteraction[]>;
  readonly #setPending: Setter<readonly PendingInteraction[]>;
  readonly #unsubscribe: () => void;

  constructor(
    readonly shellCapability: string,
    initial: readonly PendingInteraction[],
  ) {
    let revision = 0;
    const [pending, setPending] =
      createSignal<readonly PendingInteraction[]>(initial);
    this.pending = pending;
    this.#setPending = setPending;
    this.#unsubscribe = window.borg.interactions.subscribe(
      shellCapability,
      (snapshot) => {
        revision += 1;
        setPending(snapshot);
      },
    );
    const refreshRevision = revision;
    void window.borg.interactions
      .list(shellCapability)
      .then((snapshot) => {
        if (revision === refreshRevision) {
          setPending(snapshot);
        }
      })
      .catch((error: unknown) =>
        console.error("[renderer] failed to refresh interactions", error),
      );
  }

  async respond(
    interactionId: string,
    response: InteractionResponse,
  ): Promise<void> {
    const accepted = await window.borg.interactions.respond(
      this.shellCapability,
      interactionId,
      response,
    );
    if (!accepted) {
      this.#setPending((current) =>
        current.filter(({ id }) => id !== interactionId),
      );
      throw new Error("Interaction was already resolved");
    }
  }

  dispose(): void {
    this.#unsubscribe();
  }
}
