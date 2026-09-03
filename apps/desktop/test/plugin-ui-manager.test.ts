import type { Component } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import {
  bundledUiPlugins,
  type UiPluginLoader,
} from "../src/renderer/bundled-ui-plugins";
import {
  activatePluginUi,
  createUiTransaction,
  type UiPluginMetadata,
} from "../src/renderer/plugin-ui-manager";
import { UiContributionRegistry } from "../src/renderer/ui-registry";

const EmptyComponent: Component = () => null;

const allowedPlugin: UiPluginMetadata = {
  id: "test.ui",
  uiCapability: "test-capability",
  permissions: ["ui.flightDeck"],
  contributes: {
    kinds: ["flightDeckWidget"],
  },
};

describe("plugin UI transactions", () => {
  it("rejects contributions outside the manifest permission scope", () => {
    const transaction = createUiTransaction(
      {
        id: "test.untrusted-ui",
        uiCapability: "untrusted-capability",
        permissions: [],
        contributes: { kinds: [] },
      },
      new UiContributionRegistry(),
    );

    expect(() =>
      transaction.host.registerFlightDeckWidget({
        id: "test.denied",
        label: "Denied",
        component: EmptyComponent,
      }),
    ).toThrow(/did not declare/);
  });

  it("rolls back earlier registrations when commit fails", async () => {
    const registry = new UiContributionRegistry();
    registry.registerFlightDeckWidget({
      id: "test.duplicate",
      label: "Existing",
      component: EmptyComponent,
    });
    const transaction = createUiTransaction(allowedPlugin, registry);
    transaction.host.registerFlightDeckWidget({
      id: "test.first",
      label: "First",
      component: EmptyComponent,
    });
    transaction.host.registerFlightDeckWidget({
      id: "test.duplicate",
      label: "Duplicate",
      component: EmptyComponent,
    });

    await expect(transaction.commit()).rejects.toThrow(/Duplicate/);
    expect(registry.getFlightDeckWidgets().map(({ id }) => id)).toEqual([
      "test.duplicate",
    ]);
  });

  it("rejects required wizard steps without a readiness contract", async () => {
    const registry = new UiContributionRegistry();
    const transaction = createUiTransaction(
      {
        id: "test.wizard",
        uiCapability: "wizard-capability",
        permissions: ["ui.wizard"],
        contributes: { kinds: ["wizardStep"] },
      },
      registry,
    );
    transaction.host.registerWizardStep({
      id: "test.wizard.required",
      label: "Required step",
      required: true,
      component: EmptyComponent,
    });

    await expect(transaction.commit()).rejects.toThrow(/Invalid wizard step/);
    expect(registry.getWizardSteps()).toHaveLength(0);
  });

  it("removes committed contributions during UI deactivation", async () => {
    const registry = new UiContributionRegistry();
    const transaction = createUiTransaction(allowedPlugin, registry);
    transaction.host.registerFlightDeckWidget({
      id: "test.widget",
      label: "Widget",
      component: EmptyComponent,
    });

    await transaction.commit();
    expect(registry.getFlightDeckWidgets()).toHaveLength(1);
    await transaction.dispose();
    expect(registry.getFlightDeckWidgets()).toHaveLength(0);
  });

  it("removes contributions when a plugin UI disposer throws", async () => {
    const pluginId = "test.throwing-disposer";
    const loaders = bundledUiPlugins as Record<string, UiPluginLoader>;
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    loaders[pluginId] = async () => ({
      default: {
        id: pluginId,
        activate(context) {
          context.ui.registerFlightDeckWidget({
            id: "test.throwing-widget",
            label: "Throwing widget",
            component: EmptyComponent,
          });
          return {
            dispose() {
              throw new Error("cleanup failed");
            },
          };
        },
      },
    });

    try {
      const result = await activatePluginUi([
        {
          ...allowedPlugin,
          id: pluginId,
        },
      ]);
      expect(result.registry.getFlightDeckWidgets()).toHaveLength(1);
      await result.dispose();
      expect(result.registry.getFlightDeckWidgets()).toHaveLength(0);
    } finally {
      delete loaders[pluginId];
      errorLog.mockRestore();
    }
  });
});
