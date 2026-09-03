import type {
  Disposable,
  FlightDeckWidgetContribution,
  InteractionRendererContribution,
  InteractionRendererProps,
  PluginUiHost,
  SettingsPageContribution,
  WizardStepContribution,
  WorkspaceViewContribution,
} from "@borg/plugin-sdk";
import type { Component } from "solid-js";

export class UiContributionRegistry implements PluginUiHost<Component> {
  readonly #workspaceViews: WorkspaceViewContribution<Component>[] = [];
  readonly #settingsPages: SettingsPageContribution<Component>[] = [];
  readonly #wizardSteps: WizardStepContribution<Component>[] = [];
  readonly #flightDeckWidgets: FlightDeckWidgetContribution<Component>[] = [];
  readonly #interactionRenderers: InteractionRendererContribution<
    (props: InteractionRendererProps) => unknown
  >[] = [];

  registerWorkspaceView(
    contribution: WorkspaceViewContribution<Component>,
  ): Disposable {
    return this.#register(this.#workspaceViews, contribution, "workspace view");
  }

  registerSettingsPage(
    contribution: SettingsPageContribution<Component>,
  ): Disposable {
    return this.#register(this.#settingsPages, contribution, "settings page");
  }

  registerWizardStep(contribution: WizardStepContribution<Component>): Disposable {
    return this.#register(this.#wizardSteps, contribution, "wizard step");
  }

  registerFlightDeckWidget(
    contribution: FlightDeckWidgetContribution<Component>,
  ): Disposable {
    return this.#register(this.#flightDeckWidgets, contribution, "Flight Deck widget");
  }

  registerInteractionRenderer(
    contribution: InteractionRendererContribution<
      (props: InteractionRendererProps) => unknown
    >,
  ): Disposable {
    if (
      !/^[a-z0-9]+(?:[.-][a-z0-9-]+)+$/.test(contribution.id) ||
      !["tool_approval", "classification", "human_input"].includes(
        contribution.kind,
      ) ||
      typeof contribution.component !== "function" ||
      this.#interactionRenderers.some(
        (candidate) =>
          candidate.id === contribution.id ||
          candidate.kind === contribution.kind,
      )
    ) {
      throw new Error(`Invalid interaction renderer ${contribution.id}`);
    }
    this.#interactionRenderers.push(contribution);
    return {
      dispose: () => {
        const index = this.#interactionRenderers.indexOf(contribution);
        if (index >= 0) {
          this.#interactionRenderers.splice(index, 1);
        }
      },
    };
  }

  getWorkspaceViews(): readonly WorkspaceViewContribution<Component>[] {
    return this.#ordered(this.#workspaceViews);
  }

  getSettingsPages(): readonly SettingsPageContribution<Component>[] {
    return this.#ordered(this.#settingsPages);
  }

  getWizardSteps(): readonly WizardStepContribution<Component>[] {
    return this.#ordered(this.#wizardSteps);
  }

  getFlightDeckWidgets(): readonly FlightDeckWidgetContribution<Component>[] {
    return this.#ordered(this.#flightDeckWidgets);
  }

  getInteractionRenderers(): readonly InteractionRendererContribution<
    (props: InteractionRendererProps) => unknown
  >[] {
    return [...this.#interactionRenderers];
  }

  #ordered<TContribution extends { readonly order?: number }>(
    contributions: readonly TContribution[],
  ): readonly TContribution[] {
    return [...contributions].sort(
      (left, right) => (left.order ?? 0) - (right.order ?? 0),
    );
  }

  #register<
    TContribution extends {
      readonly id: string;
      readonly label: string;
      readonly order?: number;
      readonly component: Component;
    },
  >(
    collection: TContribution[],
    contribution: TContribution,
    kind: string,
  ): Disposable {
    if (
      !/^[a-z0-9]+(?:[.-][a-z0-9-]+)+$/.test(contribution.id) ||
      contribution.label.trim().length === 0 ||
      (contribution.order !== undefined &&
        !Number.isFinite(contribution.order)) ||
      ("required" in contribution &&
        contribution.required !== undefined &&
        typeof contribution.required !== "boolean") ||
      ("isComplete" in contribution &&
        contribution.isComplete !== undefined &&
        typeof contribution.isComplete !== "function") ||
      ("required" in contribution &&
        contribution.required === true &&
        (!("isComplete" in contribution) ||
          typeof contribution.isComplete !== "function")) ||
      ("placement" in contribution &&
        contribution.placement !== undefined &&
        !["primary", "developer"].includes(
          contribution.placement as string,
        )) ||
      typeof contribution.component !== "function"
    ) {
      throw new Error(`Invalid ${kind} contribution ${contribution.id}`);
    }
    if (collection.some((candidate) => candidate.id === contribution.id)) {
      throw new Error(`Duplicate ${kind} ${contribution.id}`);
    }

    collection.push(contribution);
    return {
      dispose: () => {
        const index = collection.indexOf(contribution);
        if (index >= 0) {
          collection.splice(index, 1);
        }
      },
    };
  }
}
