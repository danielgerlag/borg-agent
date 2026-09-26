import { mkdirSync } from "node:fs";
import path from "node:path";
import { pluginManifestSchema, type Disposable } from "@borg/plugin-sdk";
import { A2AService, A2A_OWNER_PLUGIN_ID } from "./a2a-service";
import { ClassificationService } from "./classification-service";
import { CommandEventBus } from "./command-event-bus";
import { CommunicationService } from "./communication-service";
import { CostLedger } from "./cost-ledger";
import { satisfiesBorgEngine } from "./engine-range";
import { ExecutionSecurityService } from "./execution-security";
import { GraphContributionRegistry } from "./graph-contribution-registry";
import { InteractionService } from "./interaction-service";
import { LoopManager } from "./loop-manager";
import { MemoryFacade } from "./memory-facade";
import { DurableModelCallJournal, ModelGateway } from "./model-gateway";
import { NetworkService } from "./network-service";
import {
  NotificationService,
  type OsNotificationHandler,
} from "./notification-service";
import { OAuthService, type OAuthOpenExternal } from "./oauth-service";
import { PersonaService } from "./persona-service";
import {
  ConfigFacade,
  PersistenceRegistry,
  SecretFacade,
  StoreFacade,
} from "./persistence";
import {
  PLUGIN_ENABLEMENT_NAMESPACE,
  pluginEnablementSchema,
} from "./plugin-enablement";
import { PluginManager, type PluginSource } from "./plugin-manager";
import { ProcessSupervisor } from "./process-supervisor";
import { PromptAssembler } from "./prompt-assembler";
import { SandboxFactory } from "./sandbox-factory";
import { ScannerRegistry } from "./scanner-registry";
import { SchedulerCore } from "./scheduler-core";
import { TlsService } from "./tls-service";
import { ToolService } from "./tool-service";
import { TrustAuthorizer } from "./trust-authorizer";
import { WebSocketService } from "./websocket-service";
import { WorkspaceService } from "./workspace-service";

/** The kernel release; kept equal to packages/kernel/package.json by test/kernel-version.test.ts. */
export const KERNEL_VERSION = "0.1.0";
/** The version plugin `engines.borg` ranges are checked against. */
export const KERNEL_API_VERSION = "0.1.0";

export interface KernelHost {
  /** Root for kernel-owned files: `<dataDirectory>/workspaces/sessions` and `<dataDirectory>/plugins/<pluginId>`. */
  readonly dataDirectory: string;
  /** OS-level notification sink. Omit to keep notifications in-process only. */
  readonly showOsNotification?: OsNotificationHandler;
  /** Opens a URL in the system browser (OAuth). */
  readonly openExternal?: OAuthOpenExternal;
  /** Brings the host UI forward for plugins holding `window.show`. */
  readonly showWindow?: () => void;
  /** Receives non-fatal kernel errors. Defaults to console.error. */
  readonly logError?: (message: string, error: unknown) => void;
}

export interface CreateKernelOptions {
  readonly plugins: readonly PluginSource[];
  readonly host: KernelHost;
  /** Returns the plugin id of the secret store to activate. Runs after the config store is active. */
  readonly resolveSecretStore: (config: ConfigFacade) => Promise<string>;
}

export interface Kernel {
  readonly version: string;
  readonly bus: CommandEventBus;
  readonly plugins: PluginManager;
  readonly config: ConfigFacade;
  readonly secrets: SecretFacade;
  readonly notifications: NotificationService;
  readonly interactions: InteractionService;
  readonly loops: LoopManager;
  readonly personas: PersonaService;
  readonly models: ModelGateway;
  readonly costs: CostLedger;
  readonly workspaces: WorkspaceService;
  /** Activates the config store, secret store, then every other plugin. Throws on bootstrap failure; services stay usable. */
  start(): Promise<void>;
  /** Deactivates plugins and shuts every service down. Idempotent. */
  stop(): Promise<void>;
}

function manifestOf(source: PluginSource) {
  return pluginManifestSchema.parse(source.manifest);
}

function contributes(source: PluginSource, kind: string): boolean {
  return manifestOf(source).contributes.kinds?.includes(kind) ?? false;
}

export function createKernel(options: CreateKernelOptions): Kernel {
  const {
    dataDirectory,
    showOsNotification,
    openExternal,
    showWindow,
    logError = console.error,
  } = options.host;

  const bus = new CommandEventBus();
  const persistence = new PersistenceRegistry();
  const config = new ConfigFacade(persistence);
  const store = new StoreFacade(persistence);
  const secrets = new SecretFacade(persistence);
  const notifications = showOsNotification
    ? new NotificationService(showOsNotification)
    : new NotificationService();
  const interactions = new InteractionService();
  const classification = new ClassificationService();
  const scanners = new ScannerRegistry();
  const authorizer = new TrustAuthorizer(interactions, {
    classification,
    store,
  });
  const costs = new CostLedger();
  const executions = new ExecutionSecurityService(store);
  const tools = new ToolService(interactions, {
    classification,
    executions,
    scanners,
    authorizer,
  });
  const models = new ModelGateway({
    journal: new DurableModelCallJournal(store),
    executions,
    scanners,
    authorizer,
    costs,
    options: {
      fallbackPreferences: ["borg.mock-llm:mock:scripted"],
    },
  });
  const personas = new PersonaService(store);
  const memory = new MemoryFacade();
  const prompts = new PromptAssembler(personas, memory);
  const workspaces = new WorkspaceService(
    path.join(dataDirectory, "workspaces", "sessions"),
  );
  const graphContributions = new GraphContributionRegistry();
  const scheduler = new SchedulerCore();
  const processes = new ProcessSupervisor();
  const sandbox = new SandboxFactory();
  const network = new NetworkService();
  const channels = new CommunicationService(
    bus,
    store,
    classification,
    scanners,
    authorizer,
  );
  const webSockets = new WebSocketService();
  const tls = new TlsService();
  const oauth = new OAuthService({
    secrets,
    ...(openExternal ? { openExternal } : {}),
  });
  let installedPlugins: PluginManager | undefined;
  const loops = new LoopManager(
    models,
    executions,
    tools,
    costs,
    (pluginId) =>
      pluginId === "kernel.loop" ||
      pluginId === A2A_OWNER_PLUGIN_ID ||
      installedPlugins?.hasPermission(pluginId, "tools.invoke") === true,
    personas,
    prompts,
    workspaces,
    sandbox,
  );
  const a2a = new A2AService({
    loops,
    personas,
    workspaces,
    hostVersion: KERNEL_VERSION,
  });
  const plugins = new PluginManager(bus, KERNEL_API_VERSION, {
    config,
    store,
    secrets,
    persistence,
    notifications,
    tools,
    models,
    executions,
    loops,
    interactions,
    costs,
    personas,
    prompts,
    memory,
    workspaces,
    graphContributions,
    scheduler,
    processes,
    sandbox,
    http: network,
    scanners,
    channels,
    webSockets,
    tls,
    oauth,
    a2a,
    executionResultFlow: (pluginId, subject) =>
      (pluginId === "borg.chat" &&
        (subject.kind === "chat-session" || subject.kind === "chat-turn")) ||
      (pluginId === "borg.bots" &&
        (subject.kind === "bot" || subject.kind === "bot-attempt")) ||
      (pluginId === "borg.graphs" && subject.kind === "graph-instance") ||
      (pluginId === A2A_OWNER_PLUGIN_ID && subject.kind === "a2a-task")
        ? "detached"
        : "merge_to_parent",
    ...(showWindow ? { showWindow } : {}),
    getPluginDataDirectory: (pluginId) => {
      const directory = path.join(dataDirectory, "plugins", pluginId);
      mkdirSync(directory, { recursive: true });
      return directory;
    },
  });
  installedPlugins = plugins;

  let a2aConfigWatch: Disposable | undefined;
  let pluginEnablementRegistration: Disposable | undefined;
  let stopped = false;

  async function start(): Promise<void> {
    const configStoreSources = options.plugins.filter(
      (source) =>
        contributes(source, "configStore") &&
        satisfiesBorgEngine(
          manifestOf(source).engines.borg,
          KERNEL_API_VERSION,
        ),
    );
    if (configStoreSources.length !== 1 || !configStoreSources[0]) {
      throw new Error(
        `Expected one compatible config store, found ${configStoreSources.length}`,
      );
    }
    const configStoreSource = configStoreSources[0];
    await plugins.activateConfigStore(configStoreSource);
    if (!persistence.hasConfigStore()) {
      throw new Error("The selected config store did not install its provider");
    }
    await executions.initialize();
    await personas.initialize();

    pluginEnablementRegistration = config.registerSchema(
      PLUGIN_ENABLEMENT_NAMESPACE,
      pluginEnablementSchema,
    );
    const secretStoreId = await options.resolveSecretStore(config);
    const secretStoreSources = options.plugins.filter((source) =>
      contributes(source, "secretStore"),
    );
    const selectedSecretSource = secretStoreSources.find(
      (source) => manifestOf(source).id === secretStoreId,
    );
    if (!selectedSecretSource) {
      throw new Error(
        `Configured secret store ${secretStoreId} is unavailable`,
      );
    }
    await plugins.activate(selectedSecretSource);
    if (!persistence.hasSecretStore()) {
      throw new Error("The selected secret store did not install its provider");
    }

    plugins.lock(manifestOf(configStoreSource).id, "Required for Borg to start");
    plugins.lock(
      manifestOf(selectedSecretSource).id,
      "Required for Borg to start",
    );

    const ordinarySources = options.plugins.filter(
      (source) =>
        source !== configStoreSource &&
        source !== selectedSecretSource &&
        !contributes(source, "secretStore"),
    );
    await plugins.activateAll(ordinarySources);
    if (plugins.isActive(A2A_OWNER_PLUGIN_ID)) {
      const syncListener = async (value: unknown): Promise<void> => {
        try {
          await a2a.applyConfig(value);
        } catch (failure) {
          logError("[kernel] A2A listener failed", failure);
        }
      };
      a2aConfigWatch = config.watch(A2A_OWNER_PLUGIN_ID, (next) => {
        void syncListener(next);
      });
      await syncListener(await config.get(A2A_OWNER_PLUGIN_ID));
    }
  }

  async function stop(): Promise<void> {
    if (stopped) {
      return;
    }
    stopped = true;
    try {
      await plugins.deactivateAll();
    } finally {
      await a2aConfigWatch?.dispose();
      a2aConfigWatch = undefined;
      await a2a.close();
      scheduler.shutdown();
      loops.shutdown();
      interactions.cancelAll();
      await processes.shutdown();
      channels.shutdown();
      tls.shutdown();
      oauth.shutdown();
      webSockets.shutdown();
      network.shutdown();
    }
    await pluginEnablementRegistration?.dispose();
    pluginEnablementRegistration = undefined;
  }

  return {
    version: KERNEL_VERSION,
    bus,
    plugins,
    config,
    secrets,
    notifications,
    interactions,
    loops,
    personas,
    models,
    costs,
    workspaces,
    start,
    stop,
  };
}
