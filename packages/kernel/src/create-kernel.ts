import { mkdirSync } from "node:fs";
import path from "node:path";
import { pluginManifestSchema, type Disposable } from "@borg-agent/plugin-sdk";
import { A2AService, A2A_OWNER_PLUGIN_ID } from "./a2a-service";
import { ClassificationService } from "./classification-service";
import { CommandEventBus } from "./command-event-bus";
import { CommunicationService } from "./communication-service";
import { CostLedger } from "./cost-ledger";
import {
  distributionLabel,
  readDistribution,
  type Distribution,
} from "./distribution";
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
  pluginEnablementSchemaFor,
} from "./plugin-enablement";
import { PluginManager, type PluginSource } from "./plugin-manager";
import { ProcessSupervisor } from "./process-supervisor";
import { PromptAssembler } from "./prompt-assembler";
import { SandboxFactory } from "./sandbox-factory";
import { ScannerRegistry } from "./scanner-registry";
import { SchedulerCore } from "./scheduler-core";
import { SkillService } from "./skill-service";
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
  /** When set, only these plugins activate. Order follows `plugins`. */
  readonly distribution?: Distribution;
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
  readonly skills: SkillService;
  readonly models: ModelGateway;
  readonly costs: CostLedger;
  readonly workspaces: WorkspaceService;
  /**
   * Activates the config store, secret store, then every other plugin. Throws on bootstrap failure; services stay usable.
   * A kernel starts at most once: calling start() again, or after stop(), throws.
   */
  start(): Promise<void>;
  /**
   * Deactivates plugins and shuts every service down. Allowed in any state, including while starting.
   * Every teardown step runs even if an earlier one fails; failures are reported together as an AggregateError.
   * Idempotent: later calls resolve without running teardown again.
   */
  stop(): Promise<void>;
}

type KernelState =
  | "idle"
  | "starting"
  | "started"
  | "failed"
  | "stopping"
  | "stopped";

function startRejection(state: Exclude<KernelState, "idle">): string {
  switch (state) {
    case "starting":
      return "Kernel is already starting";
    case "started":
      return "Kernel is already started";
    case "failed":
      return "Kernel start already failed; create a new kernel to retry";
    case "stopping":
    case "stopped":
      return "Kernel has been stopped; create a new kernel to start again";
  }
}

function manifestOf(source: PluginSource) {
  return pluginManifestSchema.parse(source.manifest);
}

function contributes(source: PluginSource, kind: string): boolean {
  return manifestOf(source).contributes.kinds?.includes(kind) ?? false;
}

function sourceManifestId(source: PluginSource): string | undefined {
  const manifest = source.manifest;
  if (typeof manifest !== "object" || manifest === null || !("id" in manifest)) {
    return undefined;
  }
  const { id } = manifest;
  return typeof id === "string" ? id : undefined;
}

function distributionRunProblems(
  distribution: Distribution,
  sources: readonly PluginSource[],
): readonly string[] {
  const problems: string[] = [];
  if (!satisfiesBorgEngine(distribution.kernel, KERNEL_API_VERSION)) {
    problems.push(
      `kernel range ${distribution.kernel} is not satisfied by kernel API version ${KERNEL_API_VERSION}`,
    );
  }

  const declared = new Set(distribution.plugins.map((plugin) => plugin.id));
  const counts = new Map<string, number>();
  for (const source of sources) {
    const id = sourceManifestId(source);
    if (id === undefined || !declared.has(id)) {
      continue;
    }
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  for (const id of declared) {
    const count = counts.get(id) ?? 0;
    if (count === 0) {
      problems.push(`missing plugin source ${id}`);
    } else if (count > 1) {
      problems.push(`duplicate plugin source ${id}`);
    }
  }
  return problems;
}

/**
 * Re-validates the distribution with the same checks as `defineDistribution`,
 * because `Distribution` is structural and can be built by hand.
 */
function resolveDistribution(
  options: CreateKernelOptions,
): Distribution | undefined {
  const candidate: unknown = options.distribution;
  if (candidate === undefined) {
    return undefined;
  }
  const problems: string[] = [];
  const distribution = readDistribution(candidate, problems);
  if (distribution) {
    problems.push(...distributionRunProblems(distribution, options.plugins));
  }
  if (problems.length > 0) {
    const version =
      typeof candidate === "object" &&
      candidate !== null &&
      "version" in candidate &&
      typeof candidate.version === "string"
        ? candidate.version
        : "(unknown)";
    throw new Error(
      `Distribution ${distributionLabel(candidate)}@${version} cannot run on this kernel:\n${problems
        .map((problem) => `- ${problem}`)
        .join("\n")}`,
    );
  }
  return distribution;
}

function pluginsForDistribution(
  distribution: Distribution | undefined,
  plugins: readonly PluginSource[],
): readonly PluginSource[] {
  if (distribution === undefined) {
    return plugins;
  }
  const declared = new Set(distribution.plugins.map((plugin) => plugin.id));
  return plugins.filter((source) => {
    const id = sourceManifestId(source);
    return id !== undefined && declared.has(id);
  });
}

export function createKernel(options: CreateKernelOptions): Kernel {
  const distribution = resolveDistribution(options);
  const availablePlugins = pluginsForDistribution(distribution, options.plugins);
  // #39 removes these built-in fallbacks.
  const fallbackPreferences =
    distribution?.defaults.models ?? ["borg.mock-llm:mock:scripted"];
  const detachedResults = distribution?.policy.detachedResults;
  const defaultDisabled =
    distribution?.plugins
      .filter((plugin) => !plugin.enabled)
      .map((plugin) => plugin.id) ?? [];

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
      fallbackPreferences,
    },
  });
  const personas = new PersonaService(store);
  const skills = new SkillService(store);
  const memory = new MemoryFacade();
  const prompts = new PromptAssembler(personas, memory, skills);
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
    skills,
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
    skills,
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
    executionResultFlow: (pluginId, subject) => {
      if (detachedResults) {
        return detachedResults.some(
          (entry) =>
            entry.pluginId === pluginId &&
            entry.subjectKinds.includes(subject.kind),
        )
          ? "detached"
          : "merge_to_parent";
      }
      return (pluginId === "borg.chat" &&
        (subject.kind === "chat-session" || subject.kind === "chat-turn")) ||
        (pluginId === "borg.bots" &&
          (subject.kind === "bot" || subject.kind === "bot-attempt")) ||
        (pluginId === "borg.graphs" && subject.kind === "graph-instance") ||
        (pluginId === A2A_OWNER_PLUGIN_ID && subject.kind === "a2a-task")
        ? "detached"
        : "merge_to_parent";
    },
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
  let state: KernelState = "idle";

  // stop() may run while start() is awaiting; bail out before activating more plugins.
  function assertStarting(): void {
    if (state !== "starting") {
      throw new Error("Kernel was stopped while starting");
    }
  }

  async function start(): Promise<void> {
    if (state !== "idle") {
      throw new Error(startRejection(state));
    }
    state = "starting";
    try {
      await bootstrap();
      assertStarting();
      state = "started";
    } catch (error) {
      if (state === "starting") {
        state = "failed";
      }
      throw error;
    }
  }

  async function bootstrap(): Promise<void> {
    const configStoreSources = availablePlugins.filter(
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
    assertStarting();
    if (!persistence.hasConfigStore()) {
      throw new Error("The selected config store did not install its provider");
    }
    await executions.initialize();
    await personas.initialize();
    await skills.initialize();
    assertStarting();

    pluginEnablementRegistration = config.registerSchema(
      PLUGIN_ENABLEMENT_NAMESPACE,
      defaultDisabled.length === 0
        ? pluginEnablementSchema
        : pluginEnablementSchemaFor(defaultDisabled),
    );
    const secretStoreId = await options.resolveSecretStore(config);
    assertStarting();
    const secretStoreSources = availablePlugins.filter((source) =>
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
    assertStarting();
    if (!persistence.hasSecretStore()) {
      throw new Error("The selected secret store did not install its provider");
    }

    plugins.lock(manifestOf(configStoreSource).id, "Required for Borg to start");
    plugins.lock(
      manifestOf(selectedSecretSource).id,
      "Required for Borg to start",
    );

    const ordinarySources = availablePlugins.filter(
      (source) =>
        source !== configStoreSource &&
        source !== selectedSecretSource &&
        !contributes(source, "secretStore"),
    );
    await plugins.activateAll(ordinarySources);
    assertStarting();
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

  let teardown: Promise<void> | undefined;

  async function stop(): Promise<void> {
    if (teardown) {
      // Teardown runs once; later calls wait for it and resolve even if it reported failures.
      await teardown.catch(() => undefined);
      return;
    }
    state = "stopping";
    teardown = runTeardown();
    try {
      await teardown;
    } finally {
      state = "stopped";
    }
  }

  // Each step runs even if an earlier one threw, in the same order as before.
  async function runTeardown(): Promise<void> {
    const errors: unknown[] = [];
    const step = async (action: () => unknown): Promise<void> => {
      try {
        await action();
      } catch (error) {
        errors.push(error);
      }
    };

    await step(() => plugins.deactivateAll());
    await step(async () => {
      const watch = a2aConfigWatch;
      a2aConfigWatch = undefined;
      await watch?.dispose();
    });
    await step(() => a2a.close());
    await step(() => scheduler.shutdown());
    await step(() => loops.shutdown());
    await step(() => interactions.cancelAll());
    await step(() => processes.shutdown());
    await step(() => channels.shutdown());
    await step(() => tls.shutdown());
    await step(() => oauth.shutdown());
    await step(() => webSockets.shutdown());
    await step(() => network.shutdown());
    await step(async () => {
      const registration = pluginEnablementRegistration;
      pluginEnablementRegistration = undefined;
      await registration?.dispose();
    });

    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        `Kernel stop completed with ${errors.length} teardown failure(s)`,
      );
    }
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
    skills,
    models,
    costs,
    workspaces,
    start,
    stop,
  };
}
