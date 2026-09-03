import {
  feedbackAnswerSchema,
  interactionResponseSchema,
  pendingInteractionSchema,
  type FeedbackAnswer,
  type InteractionResponse,
  type PendingInteraction,
} from "@borg/contracts";
import type {
  Disposable,
  HumanInputRequest,
} from "@borg/plugin-sdk";
import { randomUUID } from "node:crypto";

export class InteractionCancelledError extends Error {
  constructor(message = "Interaction was cancelled") {
    super(message);
    this.name = "InteractionCancelledError";
  }
}

export class InteractionTimedOutError extends Error {
  constructor(message = "Interaction timed out") {
    super(message);
    this.name = "InteractionTimedOutError";
  }
}

interface PendingWaiter {
  readonly interaction: PendingInteraction;
  readonly resolve: (response: InteractionResponse) => void;
  readonly reject: (error: Error) => void;
  readonly timer?: ReturnType<typeof setTimeout> | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly onAbort?: (() => void) | undefined;
}

export interface InteractionWait {
  readonly interaction: PendingInteraction;
  readonly response: Promise<InteractionResponse>;
}

export interface SafetyInteractionRequest {
  readonly kind: "tool_approval" | "classification";
  readonly title: string;
  readonly prompt: string;
  readonly source: PendingInteraction["source"];
  readonly timeoutMs?: number | undefined;
}

export class InteractionService {
  readonly #pending = new Map<string, PendingWaiter>();
  readonly #subscribers = new Map<
    symbol,
    (pending: readonly PendingInteraction[]) => void | Promise<void>
  >();

  requestSafety(
    request: SafetyInteractionRequest,
    signal?: AbortSignal,
  ): InteractionWait {
    return this.#create(
      {
        kind: request.kind,
        title: request.title,
        prompt: request.prompt,
        form: "approval",
        source: request.source,
        timeoutMs: request.timeoutMs,
      },
      signal,
    );
  }

  requestHumanInput(
    pluginId: string,
    request: HumanInputRequest,
    signal?: AbortSignal,
  ): {
    readonly interaction: PendingInteraction;
    readonly response: Promise<FeedbackAnswer>;
  } {
    const wait = this.#create(
      {
        kind: "human_input",
        title: request.title ?? "Input requested",
        prompt: request.prompt,
        form: request.form,
        choices: request.choices,
        source: {
          pluginId,
          feature: "feedback",
          ...request.source,
        },
        timeoutMs: request.timeoutMs,
      },
      signal,
    );
    return {
      interaction: wait.interaction,
      response: wait.response.then((response) =>
        feedbackAnswerSchema.parse(response),
      ),
    };
  }

  listPending(): readonly PendingInteraction[] {
    return [...this.#pending.values()]
      .map(({ interaction }) => interaction)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  respond(interactionId: string, candidate: unknown): boolean {
    const waiter = this.#pending.get(interactionId);
    if (!waiter) {
      return false;
    }
    const response = interactionResponseSchema.parse(candidate);
    this.#validateResponse(waiter.interaction, response);
    this.#finish(waiter);
    waiter.resolve(response);
    return true;
  }

  cancelAll(reason = "Borg is shutting down"): void {
    for (const waiter of [...this.#pending.values()]) {
      this.#finish(waiter);
      waiter.reject(new InteractionCancelledError(reason));
    }
  }

  subscribe(
    subscriber: (pending: readonly PendingInteraction[]) => void | Promise<void>,
  ): Disposable {
    const token = Symbol("interaction-subscriber");
    this.#subscribers.set(token, subscriber);
    return {
      dispose: () => {
        this.#subscribers.delete(token);
      },
    };
  }

  #create(
    request: {
      readonly kind: PendingInteraction["kind"];
      readonly title: string;
      readonly prompt: string;
      readonly form: PendingInteraction["form"];
      readonly choices?:
        | readonly { readonly id: string; readonly label: string }[]
        | undefined;
      readonly source: PendingInteraction["source"];
      readonly timeoutMs?: number | undefined;
    },
    signal?: AbortSignal,
  ): InteractionWait {
    if (signal?.aborted) {
      throw new InteractionCancelledError();
    }
    if (
      request.timeoutMs !== undefined &&
      (!Number.isInteger(request.timeoutMs) ||
        request.timeoutMs <= 0 ||
        request.timeoutMs > 86_400_000)
    ) {
      throw new Error("Interaction timeout must be between 1ms and 24 hours");
    }
    if (
      (request.form === "choice" &&
        (!request.choices ||
          request.choices.length === 0 ||
          new Set(request.choices.map(({ id }) => id)).size !==
            request.choices.length)) ||
      (request.form !== "choice" && request.choices !== undefined)
    ) {
      throw new Error("Interaction choices do not match its form");
    }
    if (
      (request.kind === "human_input" && request.form === "approval") ||
      (request.kind !== "human_input" && request.form !== "approval")
    ) {
      throw new Error("Interaction kind does not match its form");
    }
    const now = Date.now();
    const interaction = pendingInteractionSchema.parse({
      id: randomUUID(),
      kind: request.kind,
      title: request.title,
      prompt: request.prompt,
      form: request.form,
      choices: request.choices,
      source: request.source,
      createdAt: new Date(now).toISOString(),
      expiresAt:
        request.timeoutMs === undefined
          ? undefined
          : new Date(now + request.timeoutMs).toISOString(),
    });

    let waiter: PendingWaiter | undefined;
    const response = new Promise<InteractionResponse>((resolve, reject) => {
      const onAbort = (): void => {
        if (!waiter || !this.#pending.has(interaction.id)) {
          return;
        }
        this.#finish(waiter);
        reject(new InteractionCancelledError());
      };
      const timer =
        request.timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              if (!waiter || !this.#pending.has(interaction.id)) {
                return;
              }
              this.#finish(waiter);
              reject(new InteractionTimedOutError());
            }, request.timeoutMs);
      waiter = {
        interaction,
        resolve,
        reject,
        timer,
        signal,
        onAbort,
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#pending.set(interaction.id, waiter);
    });
    this.#publish();
    return { interaction, response };
  }

  #validateResponse(
    interaction: PendingInteraction,
    response: InteractionResponse,
  ): void {
    if (interaction.form === "approval" && response.kind !== "approval") {
      throw new Error("Approval interaction requires an approval response");
    }
    if (interaction.form === "text" && response.kind !== "text") {
      throw new Error("Text interaction requires a text response");
    }
    if (interaction.form === "confirm" && response.kind !== "confirm") {
      throw new Error("Confirmation interaction requires a confirmation response");
    }
    if (interaction.form === "choice") {
      if (
        response.kind !== "choice" ||
        !interaction.choices?.some(({ id }) => id === response.choiceId)
      ) {
        throw new Error("Choice interaction requires a declared choice response");
      }
    }
  }

  #finish(waiter: PendingWaiter): void {
    this.#pending.delete(waiter.interaction.id);
    if (waiter.timer) {
      clearTimeout(waiter.timer);
    }
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
    this.#publish();
  }

  #publish(): void {
    const snapshot = this.listPending();
    for (const subscriber of this.#subscribers.values()) {
      Promise.resolve()
        .then(async () => subscriber(snapshot))
        .catch((error: unknown) =>
          console.error("[kernel] interaction subscriber failed", error),
        );
    }
  }
}
