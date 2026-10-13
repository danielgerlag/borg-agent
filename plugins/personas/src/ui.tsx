import { defineUiPlugin } from "@borg-agent/plugin-sdk";
import { createSignal, type Component } from "solid-js";
import { createPersonaWizardStep } from "./persona-setup";
import { createPersonasSettings } from "./personas-settings";

export default defineUiPlugin<Component>({
  id: "borg.personas",
  activate(context) {
    const [personaReady, setPersonaReady] = createSignal(false);
    const wizard = context.ui.registerWizardStep({
      id: "borg.personas.choose",
      label: "Choose persona",
      order: 30,
      required: true,
      isComplete: personaReady,
      component: createPersonaWizardStep(context, setPersonaReady),
    });
    const settings = context.ui.registerSettingsPage({
      id: "borg.personas.manage",
      label: "Personas",
      group: "agents",
      order: 10,
      component: createPersonasSettings(context),
    });
    return {
      dispose: async () => {
        await settings.dispose();
        await wizard.dispose();
      },
    };
  },
});
