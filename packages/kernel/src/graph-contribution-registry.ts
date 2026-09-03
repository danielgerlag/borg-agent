import type {
  Disposable,
  GraphStepContribution,
  GraphTriggerContribution,
} from "@borg/plugin-sdk";

interface OwnedContribution<T> {
  readonly ownerPluginId: string;
  readonly contribution: T;
}

const RESERVED_GRAPH_KINDS = new Set([
  "manual",
  "schedule",
  "incoming_message",
  "call_tool",
  "invoke_agent",
  "delay",
  "set_variable",
  "invoke_prompt",
  "feedback_gate",
  "branch",
  "for_each",
  "end",
]);

export class GraphContributionRegistry {
  readonly #steps = new Map<string, OwnedContribution<GraphStepContribution>>();
  readonly #triggers = new Map<
    string,
    OwnedContribution<GraphTriggerContribution>
  >();

  registerStep(
    ownerPluginId: string,
    contribution: GraphStepContribution,
  ): Disposable {
    return this.#register(this.#steps, ownerPluginId, contribution);
  }

  registerTrigger(
    ownerPluginId: string,
    contribution: GraphTriggerContribution,
  ): Disposable {
    return this.#register(this.#triggers, ownerPluginId, contribution);
  }

  listSteps(): readonly GraphStepContribution[] {
    return [...this.#steps.values()]
      .map(({ contribution }) => contribution)
      .sort((left, right) => left.kind.localeCompare(right.kind));
  }

  listTriggers(): readonly GraphTriggerContribution[] {
    return [...this.#triggers.values()]
      .map(({ contribution }) => contribution)
      .sort((left, right) => left.kind.localeCompare(right.kind));
  }

  removePlugin(ownerPluginId: string): void {
    this.#removeOwned(this.#steps, ownerPluginId);
    this.#removeOwned(this.#triggers, ownerPluginId);
  }

  #register<T extends { readonly kind: string }>(
    target: Map<string, OwnedContribution<T>>,
    ownerPluginId: string,
    contribution: T,
  ): Disposable {
    if (!/^[a-z][a-z0-9_]*$/.test(contribution.kind)) {
      throw new Error(`Graph contribution kind ${contribution.kind} is invalid`);
    }
    if (RESERVED_GRAPH_KINDS.has(contribution.kind)) {
      throw new Error(
        `Graph contribution kind ${contribution.kind} is reserved by Borg`,
      );
    }
    if (target.has(contribution.kind)) {
      throw new Error(
        `Graph contribution kind ${contribution.kind} is already registered`,
      );
    }
    const owned = { ownerPluginId, contribution };
    target.set(contribution.kind, owned);
    return {
      dispose: () => {
        if (target.get(contribution.kind) === owned) {
          target.delete(contribution.kind);
        }
      },
    };
  }

  #removeOwned<T>(
    target: Map<string, OwnedContribution<T>>,
    ownerPluginId: string,
  ): void {
    for (const [kind, owned] of target) {
      if (owned.ownerPluginId === ownerPluginId) {
        target.delete(kind);
      }
    }
  }
}
