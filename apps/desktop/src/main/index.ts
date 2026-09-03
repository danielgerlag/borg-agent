import {
  CommandEventBus,
  ConfigFacade,
  CostLedger,
  InteractionService,
  LoopManager,
  ModelRouter,
  NotificationService,
  PersistenceRegistry,
  PluginManager,
  SecretFacade,
  StoreFacade,
  ToolService,
  satisfiesBorgEngine,
  type PluginSource,
} from "@borg/kernel";
import { pluginManifestSchema, z, type Disposable } from "@borg/plugin-sdk";
import {
  app,
  BrowserWindow,
  Menu,
  nativeImage,
  Notification,
  Tray,
  type MenuItemConstructorOptions,
  type NativeImage,
} from "electron";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { bundledMainPlugins } from "./bundled-plugins";
import { registerIpcBridge } from "./ipc";

const KERNEL_VERSION = "0.1.0";
const startedAt = new Date().toISOString();
const shellCapability = randomUUID();
const rendererFile = path.join(__dirname, "../renderer/index.html");
const rendererUrl = pathToFileURL(rendererFile).href;
const rendererRecoveryUrl = `data:text/html;charset=utf-8,${encodeURIComponent(`
  <main style="font-family:system-ui;background:#090b10;color:#f2f5f7;min-height:100vh;display:grid;place-items:center">
    <section><h1>Borg renderer unavailable</h1><p>Restart Borg to retry.</p></section>
  </main>
`)}`;
const setupSchema = z.object({
  secretBackend: z
    .string()
    .regex(/^[a-z0-9]+(?:[.-][a-z0-9-]+)+$/)
    .default(
      process.env.BORG_SECRET_BACKEND ??
        (process.env.BORG_E2E === "1"
          ? "borg.secrets.dev"
          : "borg.secrets.os"),
    ),
  wizardCompleted: z.boolean().default(false),
});

let mainWindow: BrowserWindow | undefined;
let tray: Tray | undefined;
let pluginManager: PluginManager | undefined;
let configFacade: ConfigFacade | undefined;
let secretFacade: SecretFacade | undefined;
let notificationService: NotificationService | undefined;
let interactionService: InteractionService | undefined;
let loopManager: LoopManager | undefined;
let removeIpcBridge: (() => Promise<void>) | undefined;
let notificationSubscription: Disposable | undefined;
let interactionSubscription: Disposable | undefined;
let loopSubscription: Disposable | undefined;
let pluginLifecycleSubscription: Disposable | undefined;
let setupSchemaRegistration: Disposable | undefined;
let startupRecovery: { readonly message: string } | undefined;
let windowServicesReady = false;
let quitting = false;
let shutdownComplete = false;
let currentTrayMenuLabels: readonly string[] = [];
let currentTrayIconIsEmpty = true;
let currentPendingInteractions = 0;
let currentRunningLoops = 0;

type SetupState = z.infer<typeof setupSchema>;

function getManifest(source: PluginSource) {
  return pluginManifestSchema.parse(source.manifest);
}

function contributes(source: PluginSource, kind: string): boolean {
  return getManifest(source).contributes.kinds?.includes(kind) ?? false;
}

async function getSetupState(): Promise<SetupState> {
  if (!configFacade) {
    throw new Error("Config facade is unavailable");
  }
  return setupSchema.parse(await configFacade.get("system.setup"));
}

async function completeSetup(): Promise<SetupState> {
  if (!configFacade) {
    throw new Error("Config facade is unavailable");
  }
  return setupSchema.parse(
    await configFacade.update("system.setup", { wizardCompleted: true }),
  );
}

function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    if (windowServicesReady) {
      mainWindow = createMainWindow();
      loadMainWindow(mainWindow);
    }
    return;
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
  rebuildTrayMenu();
}

function hideMainWindow(): void {
  mainWindow?.hide();
  rebuildTrayMenu();
}

function rebuildTrayMenu(): void {
  if (!tray) {
    return;
  }

  const windowVisible = mainWindow?.isVisible() ?? false;
  const template: MenuItemConstructorOptions[] = [
    {
      label: "Show Borg",
      enabled: !windowVisible,
      click: showMainWindow,
    },
    {
      label: "Hide Borg",
      enabled: windowVisible,
      click: hideMainWindow,
    },
    { type: "separator" },
    {
      label: `Pending interactions: ${currentPendingInteractions}`,
      enabled: false,
    },
    {
      label: `Running — loops ${currentRunningLoops} · bots 0 · graphs 0`,
      enabled: false,
    },
    { type: "separator" },
    {
      label: "Quit Borg",
      click: () => {
        void requestQuit();
      },
    },
  ];

  currentTrayMenuLabels = template.flatMap((item) =>
    typeof item.label === "string" ? [item.label] : [],
  );
  tray.setTitle(
    currentPendingInteractions > 0 ? String(currentPendingInteractions) : "",
  );
  tray.setToolTip(
    currentPendingInteractions > 0
      ? `Borg · ${currentPendingInteractions} pending`
      : "Borg",
  );
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function createTrayIcon(): NativeImage {
  const size = 18;
  const bitmap = Buffer.alloc(size * size * 4);
  const setPixel = (x: number, y: number): void => {
    if (x < 0 || x >= size || y < 0 || y >= size) {
      return;
    }
    const offset = (y * size + x) * 4;
    bitmap[offset] = 0;
    bitmap[offset + 1] = 0;
    bitmap[offset + 2] = 0;
    bitmap[offset + 3] = 255;
  };
  const drawLine = (fromX: number, fromY: number, toX: number, toY: number): void => {
    let x = fromX;
    let y = fromY;
    const deltaX = Math.abs(toX - fromX);
    const deltaY = -Math.abs(toY - fromY);
    const stepX = fromX < toX ? 1 : -1;
    const stepY = fromY < toY ? 1 : -1;
    let error = deltaX + deltaY;

    while (true) {
      setPixel(x, y);
      if (x === toX && y === toY) {
        break;
      }
      const doubledError = 2 * error;
      if (doubledError >= deltaY) {
        error += deltaY;
        x += stepX;
      }
      if (doubledError <= deltaX) {
        error += deltaX;
        y += stepY;
      }
    }
  };

  const points = [
    [9, 1],
    [15, 5],
    [15, 13],
    [9, 17],
    [3, 13],
    [3, 5],
  ] as const;
  for (let index = 0; index < points.length; index += 1) {
    const from = points[index];
    const to = points[(index + 1) % points.length];
    if (from && to) {
      drawLine(from[0], from[1], to[0], to[1]);
    }
  }
  for (let y = 7; y <= 11; y += 1) {
    for (let x = 7; x <= 11; x += 1) {
      if ((x - 9) ** 2 + (y - 9) ** 2 <= 5) {
        setPixel(x, y);
      }
    }
  }

  const icon = nativeImage.createFromBitmap(bitmap, {
    width: size,
    height: size,
    scaleFactor: 1,
  });
  icon.setTemplateImage(true);
  return icon;
}

function createTray(): void {
  const icon = createTrayIcon();
  currentTrayIconIsEmpty = icon.isEmpty();
  if (currentTrayIconIsEmpty) {
    throw new Error("Borg tray icon could not be created");
  }
  tray = new Tray(icon);
  tray.setToolTip("Borg");
  tray.on("click", () => {
    if (mainWindow?.isVisible()) {
      hideMainWindow();
    } else {
      showMainWindow();
    }
  });
  rebuildTrayMenu();
}

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 860,
    minHeight: 600,
    show: false,
    title: "Borg",
    backgroundColor: "#090b10",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => {
    event.preventDefault();
  });
  window.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      window.hide();
      rebuildTrayMenu();
    }
  });
  window.on("show", rebuildTrayMenu);
  window.on("hide", rebuildTrayMenu);
  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = undefined;
    }
  });
  let rendererRestartCount = 0;
  window.webContents.on("render-process-gone", () => {
    if (quitting || window.isDestroyed()) {
      return;
    }
    rendererRestartCount += 1;
    if (rendererRestartCount <= 2) {
      window.webContents.reload();
    } else {
      void window.loadURL(rendererRecoveryUrl);
    }
  });
  window.once("ready-to-show", () => {
    window.show();
  });

  return window;
}

function loadMainWindow(window: BrowserWindow): void {
  void window
    .loadFile(rendererFile)
    .catch(async (error: unknown) => {
      console.error("[renderer] failed to load application shell", error);
      await window.loadURL(rendererRecoveryUrl);
    });
}

async function requestQuit(): Promise<void> {
  if (quitting) {
    return;
  }

  quitting = true;
  try {
    await removeIpcBridge?.();
    loopManager?.shutdown();
    interactionService?.cancelAll();
    await notificationSubscription?.dispose();
    await interactionSubscription?.dispose();
    await loopSubscription?.dispose();
    await pluginLifecycleSubscription?.dispose();
    await pluginManager?.deactivateAll();
    await setupSchemaRegistration?.dispose();
  } finally {
    shutdownComplete = true;
    tray?.destroy();
    app.quit();
  }
}

function installTestApi(): void {
  if (process.env.BORG_E2E !== "1") {
    return;
  }

  const testGlobal = globalThis as typeof globalThis & {
    __borgTest?: {
      showWindow(): void;
      hideWindow(): void;
      isWindowVisible(): boolean;
      activePluginIds(): readonly string[];
      disablePlugin(pluginId: string): Promise<void>;
      userDataPath(): string;
      trayMenuLabels(): readonly string[];
      trayTitle(): string;
      trayIconIsEmpty(): boolean;
    };
  };

  testGlobal.__borgTest = {
    showWindow: showMainWindow,
    hideWindow: hideMainWindow,
    isWindowVisible: () => mainWindow?.isVisible() ?? false,
    activePluginIds: () => pluginManager?.getActivePluginIds() ?? [],
    disablePlugin: async (pluginId) => pluginManager?.deactivate(pluginId),
    userDataPath: () => app.getPath("userData"),
    trayMenuLabels: () => currentTrayMenuLabels,
    trayTitle: () => tray?.getTitle() ?? "",
    trayIconIsEmpty: () => currentTrayIconIsEmpty,
  };
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", showMainWindow);
  app.on("activate", showMainWindow);
  app.on("window-all-closed", () => {
    // The tray-resident kernel intentionally outlives its BrowserWindow visibility.
  });
  app.on("before-quit", (event) => {
    if (!shutdownComplete) {
      event.preventDefault();
      void requestQuit();
    }
  });

  void app.whenReady().then(async () => {
    createTray();

    const bus = new CommandEventBus();
    const persistence = new PersistenceRegistry();
    configFacade = new ConfigFacade(persistence);
    const storeFacade = new StoreFacade(persistence);
    secretFacade = new SecretFacade(persistence);
    notificationService = new NotificationService((notification) => {
      if (Notification.isSupported()) {
        new Notification({
          title: notification.title,
          body: notification.body,
        }).show();
      }
    });
    interactionService = new InteractionService();
    const costs = new CostLedger();
    const tools = new ToolService(interactionService);
    const models = new ModelRouter(costs);
    loopManager = new LoopManager(
      models,
      tools,
      costs,
      (pluginId) =>
        pluginId === "kernel.loop" ||
        pluginManager?.hasPermission(pluginId, "tools.invoke") === true,
    );
    pluginManager = new PluginManager(bus, KERNEL_VERSION, {
      config: configFacade,
      store: storeFacade,
      secrets: secretFacade,
      persistence,
      notifications: notificationService,
      tools,
      models,
      loops: loopManager,
      interactions: interactionService,
      costs,
      showWindow: showMainWindow,
      getPluginDataDirectory: (pluginId) => {
        const directory = path.join(
          app.getPath("userData"),
          "plugins",
          pluginId,
        );
        mkdirSync(directory, { recursive: true });
        return directory;
      },
    });
    pluginLifecycleSubscription = pluginManager.subscribe(() => {
      if (
        windowServicesReady &&
        !quitting &&
        mainWindow &&
        !mainWindow.isDestroyed()
      ) {
        mainWindow.webContents.reload();
      }
    });

    try {
      const configStoreSources = bundledMainPlugins.filter(
        (source) =>
          contributes(source, "configStore") &&
          satisfiesBorgEngine(
            getManifest(source).engines.borg,
            KERNEL_VERSION,
          ),
      );
      if (configStoreSources.length !== 1 || !configStoreSources[0]) {
        throw new Error(
          `Expected one compatible config store, found ${configStoreSources.length}`,
        );
      }
      await pluginManager.activateConfigStore(configStoreSources[0]);
      if (!persistence.hasConfigStore()) {
        throw new Error("The selected config store did not install its provider");
      }

      setupSchemaRegistration = configFacade.registerSchema(
        "system.setup",
        setupSchema,
      );
      const setup = await getSetupState();
      await configFacade.update("system.setup", {
        secretBackend: setup.secretBackend,
        wizardCompleted: setup.wizardCompleted,
      });

      const secretStoreSources = bundledMainPlugins.filter((source) =>
        contributes(source, "secretStore"),
      );
      const selectedSecretSource = secretStoreSources.find(
        (source) => getManifest(source).id === setup.secretBackend,
      );
      if (!selectedSecretSource) {
        throw new Error(
          `Configured secret store ${setup.secretBackend} is unavailable`,
        );
      }
      await pluginManager.activate(selectedSecretSource);
      if (!persistence.hasSecretStore()) {
        throw new Error("The selected secret store did not install its provider");
      }

      const ordinarySources = bundledMainPlugins.filter(
        (source) =>
          source !== configStoreSources[0] &&
          source !== selectedSecretSource &&
          !contributes(source, "secretStore"),
      );
      await pluginManager.activateAll(ordinarySources);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      startupRecovery = { message };
      console.error("[kernel] persistence bootstrap failed", error);
    }

    mainWindow = createMainWindow();
    currentPendingInteractions = interactionService.listPending().length;
    currentRunningLoops = loopManager.list().filter(({ status }) =>
      ["running", "waiting", "paused"].includes(status),
    ).length;
    rebuildTrayMenu();
    notificationSubscription = notificationService.subscribe((notification) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("borg:notification", notification);
      }
    });
    interactionSubscription = interactionService.subscribe((pending) => {
      currentPendingInteractions = pending.length;
      rebuildTrayMenu();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("borg:interactions", pending);
      }
    });
    loopSubscription = loopManager.subscribe(() => {
      currentRunningLoops = loopManager?.list().filter(({ status }) =>
        ["running", "waiting", "paused"].includes(status),
      ).length ?? 0;
      rebuildTrayMenu();
    });
    removeIpcBridge = registerIpcBridge({
      bus,
      plugins: pluginManager,
      config: configFacade,
      secrets: secretFacade,
      notifications: notificationService,
      interactions: interactionService,
      loops: loopManager,
      kernelVersion: KERNEL_VERSION,
      startedAt,
      shellCapability,
      rendererUrl,
      getRecovery: () => startupRecovery,
      getSetupState,
      completeSetup,
      getMainWindow: () => mainWindow,
      requestQuit: () => {
        void requestQuit();
      },
    });
    installTestApi();
    windowServicesReady = true;
    loadMainWindow(mainWindow);
  });
}
