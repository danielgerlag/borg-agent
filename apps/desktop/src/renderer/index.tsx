import { render } from "solid-js/web";
import { App } from "./App";
import { activatePluginUi } from "./plugin-ui-manager";
import "./styles.css";
import { ToastStore } from "./toast-store";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Borg renderer root is missing");
}

async function start(root: HTMLElement): Promise<void> {
  try {
    const snapshot = await window.borg.kernel.bootstrap();
    if (snapshot.recovery) {
      throw new Error(snapshot.recovery.message);
    }
    const toastStore = new ToastStore(snapshot.shellCapability);
    const pluginUi = await activatePluginUi(snapshot.activePlugins);

    render(
      () => (
        <App
          kernelVersion={snapshot.kernelVersion}
          startedAt={snapshot.startedAt}
          activePluginCount={snapshot.activePluginIds.length}
          workspaceViews={pluginUi.registry.getWorkspaceViews()}
          settingsPages={pluginUi.registry.getSettingsPages()}
          wizardSteps={pluginUi.registry.getWizardSteps()}
          widgets={pluginUi.registry.getFlightDeckWidgets()}
          pluginErrors={pluginUi.errors}
          setupCompleted={snapshot.setup.wizardCompleted}
          toasts={toastStore.toasts()}
          completeSetup={async () => {
            await window.borg.setup.complete(snapshot.shellCapability);
          }}
          dismissToast={(id) => toastStore.dismiss(id)}
          hideWindow={async () => {
            await window.borg.window.hide(snapshot.shellCapability);
          }}
        />
      ),
      root,
    );

    window.addEventListener(
      "beforeunload",
      () => {
        void pluginUi.dispose();
        toastStore.dispose();
      },
      { once: true },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown renderer startup error";
    render(
      () => (
        <main class="grid min-h-screen place-items-center bg-[#090b10] p-8 text-[#f2f5f7]">
          <section
            class="max-w-lg rounded-2xl border border-[#ff657a]/40 bg-[#161922] p-6"
            data-testid="kernel-startup-error"
          >
            <p class="text-xs font-semibold uppercase tracking-widest text-[#ff657a]">
              Kernel unavailable
            </p>
            <h1 class="mt-2 text-2xl font-semibold">Borg could not initialize</h1>
            <p class="mt-3 text-sm text-[#a8afbd]">{message}</p>
          </section>
        </main>
      ),
      root,
    );
  }
}

void start(rootElement);
