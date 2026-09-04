import type { CommandDefinition } from "@borg/contracts";
import {
  pluginManifestSchema,
  type BorgPluginManifest,
  type Disposable,
  type PluginContributionDeclaration,
  type PluginContext,
  type PluginDefinition,
  type PluginLogger,
} from "@borg/plugin-sdk";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { CommandEventBus } from "./command-event-bus";
import type { CostLedger } from "./cost-ledger";
import { satisfiesBorgEngine } from "./engine-range";
import { PluginLoadError } from "./errors";
import type { GraphContributionRegistry } from "./graph-contribution-registry";
import type { InteractionService } from "./interaction-service";
import type { LoopManager } from "./loop-manager";
import type { ModelRouter } from "./model-router";
import type { NotificationService } from "./notification-service";
import type { PersonaService } from "./persona-service";
import type { PromptAssembler } from "./prompt-assembler";
import type { SchedulerCore } from "./scheduler-core";
import type {
  ConfigFacade,
  PersistenceRegistry,
  SecretFacade,
  StoreFacade,
} from "./persistence";
import type { ToolService } from "./tool-service";
import type { WorkspaceService } from "./workspace-service";

export type PluginStatus =
  | "discovered"
  | "incompatible"
  | "activating"
  | "active"
  | "deactivating"
  | "disabled"
  | "failed";

export interface PluginSource {
  readonly manifest: unknown;
  loadMain(): Promise<PluginDefinition | { readonly default: PluginDefinition }>;
}

export interface PluginRecord {
  readonly id: string;
  readonly version: string;
  readonly status: PluginStatus;
  readonly error?: string;
}

export interface ActivePluginMetadata {
  readonly id: string;
  readonly version: string;
  readonly uiCapability: string;
  readonly permissions: readonly string[];
  readonly contributes: PluginContributionDeclaration;
}

export interface PluginManagerOptions {
  readonly shutdownTimeoutMs?: number;
  readonly config?: ConfigFacade;
  readonly store?: StoreFacade;
  readonly secrets?: SecretFacade;
  readonly persistence?: PersistenceRegistry;
  readonly notifications?: NotificationService;
  readonly tools?: ToolService;
  readonly models?: ModelRouter;
  readonly loops?: LoopManager;
  readonly interactions?: InteractionService;
  readonly costs?: CostLedger;
  readonly personas?: PersonaService;
  readonly prompts?: PromptAssembler;
  readonly workspaces?: WorkspaceService;
  readonly graphContributions?: GraphContributionRegistry;
  readonly scheduler?: SchedulerCore;
  readonly showWindow?: () => void;
  getPluginDataDirectory?(pluginId: string): string;
}

interface ActivePlugin {
  readonly manifest: BorgPluginManifest;
  readonly definition: PluginDefinition;
  readonly controller: AbortController;
  readonly context: PluginContext;
  readonly disposables: Disposable[];
  readonly operations: Set<Promise<unknown>>;
  readonly uiCapability: string;
}

interface StagedRegistration {
  commit(): void;
}

interface PluginActivationOptions {
  readonly bootstrapConfigStore?: boolean;
}

const DEFAULT_PLUGIN_SHUTDOWN_TIMEOUT_MS = 5_000;

function asDefinition(
  module: PluginDefinition | { readonly default: PluginDefinition },
): PluginDefinition {
  return "default" in module ? module.default : module;
}

function sorted(values: readonly string[] | undefined): readonly string[] {
  return [...(values ?? [])].sort();
}

function sameValues(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
}

function isJsonConfigDocument(value: unknown): boolean {
  const isJson = (candidate: unknown): boolean => {
    if (
      candidate === null ||
      typeof candidate === "string" ||
      typeof candidate === "boolean"
    ) {
      return true;
    }
    if (typeof candidate === "number") {
      return Number.isFinite(candidate);
    }
    if (Array.isArray(candidate)) {
      return candidate.every(isJson);
    }
    if (typeof candidate !== "object") {
      return false;
    }
    const prototype = Object.getPrototypeOf(candidate);
    return (
      (prototype === Object.prototype || prototype === null) &&
      Object.getOwnPropertySymbols(candidate).length === 0 &&
      Object.values(candidate).every(isJson)
    );
  };

  return (
    value !== null &&
    !Array.isArray(value) &&
    typeof value === "object" &&
    isJson(value)
  );
}

function definitionsAgree(manifest: BorgPluginManifest, definition: PluginDefinition): boolean {
  return (
    manifest.id === definition.id &&
    manifest.version === definition.version &&
    manifest.engines.borg === definition.engines.borg &&
    sameValues(manifest.permissions, definition.permissions) &&
    sameValues(manifest.contributes.commands, definition.contributes.commands) &&
    sameValues(manifest.contributes.events, definition.contributes.events) &&
    sameValues(manifest.contributes.extensionPoints, definition.contributes.extensionPoints) &&
    sameValues(manifest.contributes.kinds, definition.contributes.kinds)
  );
}

function createConsoleLogger(pluginId: string): PluginLogger {
  const prefix = `[plugin:${pluginId}]`;
  return {
    debug: (message, metadata) => console.debug(prefix, message, metadata ?? {}),
    info: (message, metadata) => console.info(prefix, message, metadata ?? {}),
    warn: (message, metadata) => console.warn(prefix, message, metadata ?? {}),
    error: (message, metadata) => console.error(prefix, message, metadata ?? {}),
  };
}

async function withTimeout(
  operation: () => void | Promise<void>,
  timeoutMs: number,
  description: string,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${description} exceeded ${timeoutMs}ms`)),
      timeoutMs,
    );
  });

  try {
    await Promise.race([Promise.resolve().then(operation), timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

export class PluginManager {
  readonly #records = new Map<string, PluginRecord>();
  readonly #active = new Map<string, ActivePlugin>();
  readonly #activationOrder: string[] = [];
  readonly #subscribers = new Map<symbol, () => void | Promise<void>>();
  readonly #shutdownTimeoutMs: number;
  readonly #options: PluginManagerOptions;
  readonly #operationContext = new AsyncLocalStorage<{
    readonly pluginId: string;
    readonly commandId: string;
    readonly signal: AbortSignal;
    active: boolean;
  }>();

  constructor(
    readonly bus: CommandEventBus,
    readonly hostVersion: string,
    options: PluginManagerOptions = {},
  ) {
    this.#shutdownTimeoutMs =
      options.shutdownTimeoutMs ?? DEFAULT_PLUGIN_SHUTDOWN_TIMEOUT_MS;
    this.#options = options;
  }

  subscribe(subscriber: () => void | Promise<void>): Disposable {
    const token = Symbol("plugin-lifecycle-subscriber");
    this.#subscribers.set(token, subscriber);
    return {
      dispose: () => {
        this.#subscribers.delete(token);
      },
    };
  }

  async activateConfigStore(source: PluginSource): Promise<PluginRecord> {
    const parsed = pluginManifestSchema.safeParse(source.manifest);
    if (
      !parsed.success ||
      !parsed.data.contributes.kinds?.includes("configStore")
    ) {
      throw new PluginLoadError(
        parsed.success ? parsed.data.id : "unknown",
        "Bootstrap source does not declare configStore",
      );
    }
    return this.activate(source, { bootstrapConfigStore: true });
  }

  async activate(
    source: PluginSource,
    activationOptions: PluginActivationOptions = {},
  ): Promise<PluginRecord> {
    const parsedManifest = pluginManifestSchema.safeParse(source.manifest);
    if (!parsedManifest.success) {
      throw new PluginLoadError(
        "unknown",
        "Plugin manifest did not match the Borg manifest schema",
        { cause: parsedManifest.error },
      );
    }

    const manifest: BorgPluginManifest = parsedManifest.data;
    const existingRecord = this.#records.get(manifest.id);
    if (existingRecord?.status === "disabled") {
      this.#records.delete(manifest.id);
    } else if (existingRecord) {
      throw new PluginLoadError(manifest.id, `Plugin ${manifest.id} was discovered twice`);
    }

    if (!satisfiesBorgEngine(manifest.engines.borg, this.hostVersion)) {
      const record: PluginRecord = {
        id: manifest.id,
        version: manifest.version,
        status: "incompatible",
        error: `Requires Borg ${manifest.engines.borg}; host is ${this.hostVersion}`,
      };
      this.#records.set(manifest.id, record);
      this.#publishLifecycle();
      return record;
    }

    this.#records.set(manifest.id, {
      id: manifest.id,
      version: manifest.version,
      status: "activating",
    });

    const controller = new AbortController();
    const disposables: Disposable[] = [];
    const operations = new Set<Promise<unknown>>();
    const stagedRegistrations: StagedRegistration[] = [];
    let activationCommitted = false;
    let definition: PluginDefinition | undefined;
    let context: PluginContext | undefined;

    try {
      definition = asDefinition(await source.loadMain());
      if (!definitionsAgree(manifest, definition)) {
        throw new PluginLoadError(
          manifest.id,
          `Plugin ${manifest.id} main definition does not agree with its static manifest`,
        );
      }

      const commandIds = new Set(manifest.contributes.commands ?? []);
      const eventIds = new Set(manifest.contributes.events ?? []);
      const contributionKinds = new Set(manifest.contributes.kinds ?? []);
      const permissions = new Set(manifest.permissions);
      const track = <TDisposable extends Disposable>(disposable: TDisposable): TDisposable => {
        disposables.push(disposable);
        return disposable;
      };
      const trackOperation = <T>(operation: Promise<T>): Promise<T> => {
        operations.add(operation);
        return operation.finally(() => {
          operations.delete(operation);
        });
      };
      const stage = (factory: () => Disposable): Disposable => {
        if (controller.signal.aborted) {
          throw new Error(`Plugin ${manifest.id} context is no longer active`);
        }
        if (activationCommitted) {
          return track(factory());
        }

        let committed: Disposable | undefined;
        let disposed = false;
        const placeholder: Disposable = {
          dispose: async () => {
            disposed = true;
            await committed?.dispose();
          },
        };
        track(placeholder);
        stagedRegistrations.push({
          commit: () => {
            if (!disposed) {
              committed = factory();
            }
          },
        });
        return placeholder;
      };
      const assertContextActive = (): void => {
        if (controller.signal.aborted) {
          throw new Error(`Plugin ${manifest.id} context is no longer active`);
        }
      };
      const assertOrdinaryContext = (): void => {
        if (activationOptions.bootstrapConfigStore === true) {
          throw new Error(
            `Bootstrap config store ${manifest.id} cannot use ordinary host services`,
          );
        }
      };
      const assertPermission = (permission: string): void => {
        if (!permissions.has(permission)) {
          throw new Error(`Plugin ${manifest.id} did not declare permission ${permission}`);
        }
      };
      const assertContribution = (kind: string): void => {
        if (!contributionKinds.has(kind)) {
          throw new Error(`Plugin ${manifest.id} did not declare contribution ${kind}`);
        }
      };
      const requireConfig = (): ConfigFacade => {
        assertContextActive();
        assertOrdinaryContext();
        if (!this.#options.config) {
          throw new Error("Config facade is unavailable");
        }
        return this.#options.config;
      };
      const requireStore = (): StoreFacade => {
        assertContextActive();
        assertOrdinaryContext();
        if (!this.#options.store) {
          throw new Error("Store facade is unavailable");
        }
        return this.#options.store;
      };
      const requireSecrets = (): SecretFacade => {
        assertContextActive();
        assertOrdinaryContext();
        if (!this.#options.secrets) {
          throw new Error("Secrets facade is unavailable");
        }
        return this.#options.secrets;
      };
      const requirePersistence = (): PersistenceRegistry => {
        assertContextActive();
        if (!this.#options.persistence) {
          throw new Error("Persistence registry is unavailable");
        }
        return this.#options.persistence;
      };
      const requirePersonas = (): PersonaService => {
        assertContextActive();
        assertOrdinaryContext();
        if (!this.#options.personas) {
          throw new Error("Persona service is unavailable");
        }
        return this.#options.personas;
      };
      const requireWorkspaces = (): WorkspaceService => {
        assertContextActive();
        assertOrdinaryContext();
        if (!this.#options.workspaces) {
          throw new Error("Workspace service is unavailable");
        }
        return this.#options.workspaces;
      };
      const requirePrompts = (): PromptAssembler => {
        assertContextActive();
        assertOrdinaryContext();
        if (!this.#options.prompts) {
          throw new Error("Prompt assembler is unavailable");
        }
        return this.#options.prompts;
      };
      const requireTools = (): ToolService => {
        assertContextActive();
        assertOrdinaryContext();
        if (!this.#options.tools) {
          throw new Error("Tool service is unavailable");
        }
        return this.#options.tools;
      };
      const requireModels = (): ModelRouter => {
        assertContextActive();
        assertOrdinaryContext();
        if (!this.#options.models) {
          throw new Error("Model router is unavailable");
        }
        return this.#options.models;
      };
      const requireLoops = (): LoopManager => {
        assertContextActive();
        assertOrdinaryContext();
        if (!this.#options.loops) {
          throw new Error("Loop manager is unavailable");
        }
        return this.#options.loops;
      };
      const requireInteractions = (): InteractionService => {
        assertContextActive();
        assertOrdinaryContext();
        if (!this.#options.interactions) {
          throw new Error("Interaction service is unavailable");
        }
        return this.#options.interactions;
      };
      const requireScheduler = (): SchedulerCore => {
        assertContextActive();
        assertOrdinaryContext();
        if (!this.#options.scheduler) {
          throw new Error("Scheduler service is unavailable");
        }
        return this.#options.scheduler;
      };
      const requireGraphContributions = (): GraphContributionRegistry => {
        assertContextActive();
        assertOrdinaryContext();
        if (!this.#options.graphContributions) {
          throw new Error("Graph contribution registry is unavailable");
        }
        return this.#options.graphContributions;
      };

      if (
        definition.configSchema &&
        activationOptions.bootstrapConfigStore === true
      ) {
        const defaults = definition.configSchema.safeParse({});
        if (!defaults.success || !isJsonConfigDocument(defaults.data)) {
          throw new PluginLoadError(
            manifest.id,
            `Bootstrap config schema for ${manifest.id} requires unavailable configuration`,
            defaults.success ? undefined : { cause: defaults.error },
          );
        }
      } else if (definition.configSchema) {
        const config = requireConfig();
        track(config.registerSchema(manifest.id, definition.configSchema));
        await config.get(manifest.id);
      }

      context = {
        pluginId: manifest.id,
        signal: controller.signal,
        host: {
          version: this.hostVersion,
          platform: process.platform,
        },
        dataDir:
          permissions.has("fs:pluginData")
            ? (this.#options.getPluginDataDirectory?.(manifest.id) ?? "")
            : "",
        logger: createConsoleLogger(manifest.id),
        config: {
          get: () => requireConfig().get(manifest.id),
          update: (patch) => requireConfig().update(manifest.id, patch),
          watch: (handler) =>
            stage(() => requireConfig().watch(manifest.id, handler)),
        },
        store: {
          get: (key) => requireStore().get(manifest.id, key),
          set: (key, value) => requireStore().set(manifest.id, key, value),
          delete: (key) => requireStore().delete(manifest.id, key),
          list: (prefix) => requireStore().list(manifest.id, prefix),
          transaction: (operations) =>
            requireStore().transaction(manifest.id, operations),
        },
        secrets: {
          get: (key) => {
            assertOrdinaryContext();
            assertPermission("secrets:read");
            return requireSecrets().get(manifest.id, key);
          },
          set: (key, value) => {
            assertOrdinaryContext();
            assertPermission("secrets:write");
            return requireSecrets().set(manifest.id, key, value);
          },
          delete: (key) => {
            assertOrdinaryContext();
            assertPermission("secrets:write");
            return requireSecrets().delete(manifest.id, key);
          },
          has: (key) => {
            assertOrdinaryContext();
            assertPermission("secrets:read");
            return requireSecrets().has(manifest.id, key);
          },
        },
        persistence: {
          registerConfigStore: (provider) => {
            assertContribution("configStore");
            return stage(() =>
              requirePersistence().registerConfigStore(manifest.id, provider),
            );
          },
          registerSecretStore: (provider) => {
            assertOrdinaryContext();
            assertContribution("secretStore");
            return stage(() =>
              requirePersistence().registerSecretStore(manifest.id, provider),
            );
          },
        },
        tools: {
          register: (tool) => {
            assertPermission("tools.register");
            assertContribution("tool");
            return stage(() =>
              requireTools().register(
                manifest.id,
                {
                  ...tool,
                  execute: (input, execution) =>
                    trackOperation(
                      Promise.resolve().then(async () =>
                        tool.execute(input, {
                          ...execution,
                          signal: AbortSignal.any([
                            execution.signal,
                            controller.signal,
                          ]),
                        }),
                      ),
                    ),
                },
                {
                  workspaceAccess:
                    permissions.has("fs:sessionWorkspace"),
                },
              ),
            );
          },
          registerExecutionScope: (
            runId,
            sessionId,
            allowedTools = ["*"],
          ) => {
            assertPermission("tools.invoke");
            assertPermission("workspace.manage");
            const workspace = requireWorkspaces().get(manifest.id, sessionId);
            if (!workspace) {
              throw new Error(
                `Workspace ${sessionId} is unavailable to ${manifest.id}`,
              );
            }
            return stage(() =>
              requireTools().registerRunPolicy(
                runId,
                manifest.id,
                allowedTools,
                {
                  sessionId,
                  workspaceRoot: workspace.rootPath,
                },
              ),
            );
          },
          invoke: (toolId, input, invocationOptions) => {
            assertPermission("tools.invoke");
            const operation = this.#operationContext.getStore();
            if (operation && !operation.active) {
              throw new Error(
                `Command ${operation.commandId} context is no longer active`,
              );
            }
            return requireTools().invoke(toolId, input, {
              callerPluginId: manifest.id,
              runId: invocationOptions?.runId,
              signal: AbortSignal.any([
                ...(invocationOptions?.signal
                  ? [invocationOptions.signal]
                  : []),
                ...(operation ? [operation.signal] : []),
                controller.signal,
              ]),
            });
          },
        },
        models: {
          registerProvider: (provider) => {
            assertPermission("models.register");
            assertContribution("llmProvider");
            return stage(() =>
              requireModels().registerProvider(manifest.id, {
                ...provider,
                complete: (request, signal, onToken, onUsage) =>
                  trackOperation(
                    Promise.resolve().then(async () =>
                      provider.complete(
                        request,
                        AbortSignal.any([signal, controller.signal]),
                        onToken,
                        onUsage,
                      ),
                    ),
                  ),
              }),
            );
          },
          complete: (request, signal) => {
            assertOrdinaryContext();
            assertPermission("models.complete");
            const operation = this.#operationContext.getStore();
            if (operation && !operation.active) {
              throw new Error(
                `Command ${operation.commandId} context is no longer active`,
              );
            }
            return requireModels().complete(
              {
                ...request,
                tools: [],
                correlationId: randomUUID(),
              },
              signal
                ? AbortSignal.any([
                    signal,
                    ...(operation ? [operation.signal] : []),
                    controller.signal,
                  ])
                : operation
                  ? AbortSignal.any([operation.signal, controller.signal])
                  : controller.signal,
            );
          },
        },
        loops: {
          start: async (input) => {
            assertPermission("loops.start");
            const operation = this.#operationContext.getStore();
            if (operation && !operation.active) {
              throw new Error(
                `Command ${operation.commandId} context is no longer active`,
              );
            }
            return requireLoops().start(
              input,
              manifest.id,
              operation
                ? AbortSignal.any([operation.signal, controller.signal])
                : controller.signal,
              permissions.has("tools.invoke"),
            );
          },
          get: (runId) => {
            assertPermission("loops.start");
            return requireLoops().get(runId, manifest.id);
          },
          list: () => {
            assertPermission("loops.start");
            return requireLoops().list(manifest.id);
          },
          pause: (runId) => {
            assertPermission("loops.start");
            return requireLoops().pause(runId, manifest.id);
          },
          resume: (runId) => {
            assertPermission("loops.start");
            return requireLoops().resume(runId, manifest.id);
          },
          cancel: (runId) => {
            assertPermission("loops.start");
            return requireLoops().cancel(runId, manifest.id);
          },
          subscribe: (runId, handler) => {
            assertPermission("loops.start");
            return track(
              requireLoops().subscribeRun(runId, manifest.id, (event) =>
                trackOperation(Promise.resolve(handler(event))),
              ),
            );
          },
        },
        interactions: {
          requestHumanInput: (request, signal) => {
            assertPermission("interactions.request:human_input");
            const operation = this.#operationContext.getStore();
            if (
              manifest.id !== "borg.feedback" ||
              operation?.pluginId !== manifest.id ||
              operation.commandId !== "borg.feedback.ask" ||
              !operation.active
            ) {
              throw new Error(
                `Plugin ${manifest.id} may request human input only while handling borg.feedback.ask`,
              );
            }
            const wait = requireInteractions().requestHumanInput(
              manifest.id,
              request,
              signal
                ? AbortSignal.any([
                    signal,
                    operation.signal,
                    controller.signal,
                  ])
                : AbortSignal.any([operation.signal, controller.signal]),
            );
            return {
              interactionId: wait.interaction.id,
              response: wait.response,
            };
          },
        },
        cost: {
          record: (record) => {
            assertContextActive();
            assertPermission("cost.record");
            if (!this.#options.costs) {
              throw new Error("Cost ledger is unavailable");
            }
            this.#options.costs.record(record);
          },
          summary: () => {
            assertContextActive();
            assertPermission("cost.read");
            if (!this.#options.costs) {
              throw new Error("Cost ledger is unavailable");
            }
            return this.#options.costs.summary();
          },
          subscribe: (handler) => {
            assertContextActive();
            assertPermission("cost.read");
            if (!this.#options.costs) {
              throw new Error("Cost ledger is unavailable");
            }
            return track(
              this.#options.costs.subscribe((summary) =>
                trackOperation(Promise.resolve(handler(summary))),
              ),
            );
          },
        },
        personas: {
          get: (personaId) => {
            assertPermission("personas.read");
            return requirePersonas().get(personaId);
          },
          list: (includeArchived) => {
            assertPermission("personas.read");
            return requirePersonas().list(includeArchived);
          },
          getDefault: () => {
            assertPermission("personas.read");
            return requirePersonas().getDefault();
          },
          setDefault: (personaId) => {
            assertPermission("personas.write");
            return requirePersonas().setDefault(personaId);
          },
          create: (candidate) => {
            assertPermission("personas.write");
            return requirePersonas().create(candidate);
          },
          update: (personaId, patch) => {
            assertPermission("personas.write");
            return requirePersonas().update(personaId, patch);
          },
          archive: (personaId) => {
            assertPermission("personas.write");
            return requirePersonas().archive(personaId);
          },
        },
        workspace: {
          allocate: (sessionId) => {
            assertPermission("workspace.manage");
            return requireWorkspaces().allocate(manifest.id, sessionId);
          },
          get: (sessionId) => {
            assertPermission("workspace.manage");
            return requireWorkspaces().get(manifest.id, sessionId);
          },
          listFiles: (sessionId) => {
            assertPermission("workspace.manage");
            return requireWorkspaces().listFiles(manifest.id, sessionId);
          },
          release: (sessionId) => {
            assertPermission("workspace.manage");
            return requireWorkspaces().release(manifest.id, sessionId);
          },
        },
        prompts: {
          registerSlot: (slot) => {
            assertPermission("prompts.register");
            assertContribution("promptSlot");
            if (!slot.id.startsWith(`${manifest.id}.`)) {
              throw new Error(
                `Prompt slot ${slot.id} must use the ${manifest.id} namespace`,
              );
            }
            return stage(() => requirePrompts().registerSlot(slot));
          },
        },
        graphs: {
          registerStep: (contribution) => {
            assertPermission("graphs.contribute");
            assertContribution("graphStep");
            return stage(() =>
              requireGraphContributions().registerStep(
                manifest.id,
                {
                  ...contribution,
                  execute: (config, graphContext) => {
                    const signal = AbortSignal.any([
                      graphContext.signal,
                      controller.signal,
                    ]);
                    return this.#operationContext.exit(() =>
                      trackOperation(
                        Promise.resolve().then(() =>
                          contribution.execute(config, {
                            ...graphContext,
                            signal,
                          }),
                        ),
                      ),
                    );
                  },
                },
              ),
            );
          },
          registerTrigger: (contribution) => {
            assertPermission("graphs.contribute");
            assertContribution("graphTrigger");
            return stage(() =>
              requireGraphContributions().registerTrigger(
                manifest.id,
                {
                  ...contribution,
                  subscribe: (config, trigger, graphSignal) => {
                    const signal = AbortSignal.any([
                      graphSignal,
                      controller.signal,
                    ]);
                    return this.#operationContext.exit(() =>
                      trackOperation(
                        Promise.resolve().then(() =>
                          contribution.subscribe(
                            config,
                            async (input) => {
                              signal.throwIfAborted();
                              await trigger(input);
                            },
                            signal,
                          ),
                        ),
                      ),
                    );
                  },
                },
              ),
            );
          },
          listSteps: () => {
            assertPermission("graphs.readContributions");
            return requireGraphContributions().listSteps();
          },
          listTriggers: () => {
            assertPermission("graphs.readContributions");
            return requireGraphContributions().listTriggers();
          },
        },
        scheduler: {
          schedule: (id, runAt, callback) => {
            assertPermission("scheduler.manage");
            return stage(() =>
              requireScheduler().schedule(manifest.id, id, runAt, (signal) =>
                this.#operationContext.exit(() =>
                  trackOperation(
                    Promise.resolve(
                      callback(
                        AbortSignal.any([signal, controller.signal]),
                      ),
                    ),
                  ),
                ),
              ),
            );
          },
          scheduleCron: (id, expression, callback) => {
            assertPermission("scheduler.manage");
            return stage(() =>
              requireScheduler().scheduleCron(
                manifest.id,
                id,
                expression,
                (signal) =>
                  this.#operationContext.exit(() =>
                    trackOperation(
                      Promise.resolve(
                        callback(
                          AbortSignal.any([signal, controller.signal]),
                        ),
                      ),
                    ),
                  ),
              ),
            );
          },
          cancel: (id) => {
            assertPermission("scheduler.manage");
            return requireScheduler().cancel(manifest.id, id);
          },
        },
        runtime: {
          spawn: (task) => {
            assertOrdinaryContext();
            assertPermission("runtime.background");
            assertContextActive();
            const taskController = new AbortController();
            const signal = AbortSignal.any([
              taskController.signal,
              controller.signal,
            ]);
            const operation = this.#operationContext.exit(() =>
              Promise.resolve().then(() => task(signal)),
            );
            void trackOperation(operation).catch((error: unknown) => {
              if (!signal.aborted) {
                console.error(
                  `[kernel] background task from ${manifest.id} failed`,
                  error,
                );
              }
            });
            return track({
              dispose: () => {
                taskController.abort(
                  new Error(`Background task from ${manifest.id} was cancelled`),
                );
              },
            });
          },
        },
        window: {
          show: () => {
            assertContextActive();
            assertOrdinaryContext();
            assertPermission("window.show");
            if (!this.#options.showWindow) {
              throw new Error("Window service is unavailable");
            }
            this.#options.showWindow();
          },
        },
        notify: (request) => {
          assertContextActive();
          assertOrdinaryContext();
          assertPermission("notifications:send");
          if (!this.#options.notifications) {
            throw new Error("Notification service is unavailable");
          }
          void this.#options.notifications
            .notify(manifest.id, request)
            .catch((error: unknown) =>
              console.error(`[kernel] notification from ${manifest.id} failed`, error),
            );
        },
        bus: {
          handle: (command, handler) => {
            assertOrdinaryContext();
            return stage(() =>
              this.bus.handle(manifest.id, commandIds, command, (input, signal, envelope) => {
                const operationSignal = AbortSignal.any([
                  signal,
                  controller.signal,
                ]);
                const operation = {
                  pluginId: manifest.id,
                  commandId: command.id,
                  signal: operationSignal,
                  active: true,
                };
                const pending = this.#operationContext.run(
                  operation,
                  async () => {
                    const expire = (): void => {
                      operation.active = false;
                    };
                    operationSignal.addEventListener("abort", expire, {
                      once: true,
                    });
                    if (operationSignal.aborted) {
                      expire();
                    }
                    try {
                      return await handler(input, operationSignal, envelope);
                    } finally {
                      expire();
                      operationSignal.removeEventListener("abort", expire);
                    }
                  },
                );
                return trackOperation(pending);
              }),
            );
          },
          invoke: (command, input, invocationOptions) => {
            assertOrdinaryContext();
            if (controller.signal.aborted) {
              throw new Error(`Plugin ${manifest.id} context is no longer active`);
            }
            const operation = this.#operationContext.getStore();
            return this.bus.invoke(command, input, {
              source: { kind: "plugin", id: manifest.id },
              signal: invocationOptions?.signal
                ? AbortSignal.any([
                    invocationOptions.signal,
                    ...(operation ? [operation.signal] : []),
                    controller.signal,
                  ])
                : operation
                  ? AbortSignal.any([operation.signal, controller.signal])
                  : controller.signal,
            });
          },
          provides: (command: CommandDefinition) => {
            assertOrdinaryContext();
            return !controller.signal.aborted && this.bus.provides(command);
          },
          emit: (event, payload) => {
            assertOrdinaryContext();
            if (
              !activationCommitted ||
              (controller.signal.aborted && !this.#active.has(manifest.id))
            ) {
              throw new Error(
                `Plugin ${manifest.id} emitted ${event.id} outside its active lifecycle`,
              );
            }
            return this.bus.emit(manifest.id, eventIds, event, payload);
          },
          on: (event, handler) => {
            assertOrdinaryContext();
            return stage(() => this.bus.on(manifest.id, event, handler));
          },
        },
      };

      const activationDisposable = await definition.activate(context);
      if (activationDisposable) {
        track(activationDisposable);
      }

      for (const registration of stagedRegistrations) {
        registration.commit();
      }
      activationCommitted = true;

      this.#active.set(manifest.id, {
        manifest,
        definition,
        controller,
        context,
        disposables,
        operations,
        uiCapability: randomUUID(),
      });
      this.#activationOrder.push(manifest.id);

      const record: PluginRecord = {
        id: manifest.id,
        version: manifest.version,
        status: "active",
      };
      this.#records.set(manifest.id, record);
      this.#publishLifecycle();
      return record;
    } catch (error) {
      controller.abort(error);
      this.#options.tools?.removePlugin(manifest.id);
      this.#options.models?.removePlugin(manifest.id);
      this.#options.prompts?.removePlugin(manifest.id);
      await this.#disposeAll(disposables);
      this.bus.removePlugin(manifest.id);

      const message = error instanceof Error ? error.message : String(error);
      this.#records.set(manifest.id, {
        id: manifest.id,
        version: manifest.version,
        status: "failed",
        error: message,
      });
      this.#publishLifecycle();

      throw error instanceof PluginLoadError
        ? error
        : new PluginLoadError(manifest.id, `Plugin ${manifest.id} failed to activate: ${message}`, {
            cause: error,
          });
    }
  }

  async activateAll(sources: readonly PluginSource[]): Promise<readonly PluginRecord[]> {
    const records: PluginRecord[] = [];
    for (const source of sources) {
      try {
        records.push(await this.activate(source));
      } catch (error) {
        console.error("[kernel] plugin activation failed", error);
        const parsed = pluginManifestSchema.safeParse(source.manifest);
        if (parsed.success) {
          const record = this.#records.get(parsed.data.id);
          if (record) {
            records.push(record);
          }
        }
      }
    }
    return records;
  }

  async deactivate(pluginId: string): Promise<void> {
    const active = this.#active.get(pluginId);
    if (!active) {
      return;
    }

    this.#records.set(pluginId, {
      id: pluginId,
      version: active.manifest.version,
      status: "deactivating",
    });
    let deactivationError: unknown;
    const shutdownDeadline = Date.now() + this.#shutdownTimeoutMs;
    this.bus.removePlugin(pluginId);
    active.controller.abort(new Error(`Plugin ${pluginId} is deactivating`));
    this.#options.tools?.removePlugin(pluginId);
    this.#options.models?.removePlugin(pluginId);
    this.#options.prompts?.removePlugin(pluginId);
    this.#options.graphContributions?.removePlugin(pluginId);
    this.#options.scheduler?.cancelOwned(pluginId);
    try {
      await withTimeout(
        async () => this.#options.loops?.cancelOwned(pluginId),
        Math.max(1, shutdownDeadline - Date.now()),
        `Plugin ${pluginId} loop cancellation`,
      );
    } catch (error) {
      deactivationError = error;
      console.error(`[kernel] plugin ${pluginId} loops did not stop`, error);
    }

    if (active.operations.size > 0) {
      try {
        await withTimeout(
          async () => {
            await Promise.allSettled([...active.operations]);
          },
          Math.max(1, shutdownDeadline - Date.now()),
          `Plugin ${pluginId} active operations`,
        );
      } catch (error) {
        deactivationError = error;
        console.error(`[kernel] plugin ${pluginId} operations did not stop`, error);
      }
    }
    try {
      await withTimeout(
        async () => active.definition.deactivate?.(active.context),
        Math.max(1, shutdownDeadline - Date.now()),
        `Plugin ${pluginId} deactivation`,
      );
    } catch (error) {
      deactivationError ??= error;
      console.error(`[kernel] plugin ${pluginId} deactivation failed`, error);
    } finally {
      await this.#disposeAll(active.disposables, shutdownDeadline);
      this.#active.delete(pluginId);
      const orderIndex = this.#activationOrder.lastIndexOf(pluginId);
      if (orderIndex >= 0) {
        this.#activationOrder.splice(orderIndex, 1);
      }
      this.#records.set(pluginId, {
        id: pluginId,
        version: active.manifest.version,
        status: "disabled",
      });
      this.#publishLifecycle();
    }

    if (deactivationError !== undefined) {
      throw deactivationError;
    }
  }

  async deactivateAll(): Promise<void> {
    for (const pluginId of [...this.#activationOrder].reverse()) {
      try {
        await this.deactivate(pluginId);
      } catch (error) {
        console.error(`[kernel] continuing after ${pluginId} shutdown failure`, error);
      }
    }
  }

  getRecords(): readonly PluginRecord[] {
    return [...this.#records.values()];
  }

  getActivePluginIds(): readonly string[] {
    return [...this.#activationOrder];
  }

  isActive(pluginId: string): boolean {
    return this.#active.has(pluginId);
  }

  hasPermission(pluginId: string, permission: string): boolean {
    return this.#active
      .get(pluginId)
      ?.manifest.permissions.includes(permission) ?? false;
  }

  hasDeclaredEvent(eventId: string): boolean {
    return [...this.#active.values()].some(({ manifest }) =>
      manifest.contributes.events?.includes(eventId),
    );
  }

  resolveUiCapability(capability: string): string | undefined {
    for (const [pluginId, active] of this.#active) {
      if (active.uiCapability === capability) {
        return pluginId;
      }
    }
    return undefined;
  }

  getActivePluginMetadata(): readonly ActivePluginMetadata[] {
    return this.#activationOrder.flatMap((pluginId) => {
      const active = this.#active.get(pluginId);
      return active
        ? [
            {
              id: active.manifest.id,
              version: active.manifest.version,
              uiCapability: active.uiCapability,
              permissions: active.manifest.permissions,
              contributes: active.manifest.contributes,
            },
          ]
        : [];
    });
  }

  #publishLifecycle(): void {
    for (const subscriber of this.#subscribers.values()) {
      Promise.resolve()
        .then(async () => subscriber())
        .catch((error: unknown) =>
          console.error("[kernel] plugin lifecycle subscriber failed", error),
        );
    }
  }

  async #disposeAll(
    disposables: readonly Disposable[],
    deadline = Date.now() + this.#shutdownTimeoutMs,
  ): Promise<void> {
    for (const disposable of [...disposables].reverse()) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        console.error("[kernel] plugin disposal deadline exhausted");
        break;
      }
      try {
        await withTimeout(
          () => disposable.dispose(),
          remainingMs,
          "Plugin disposable",
        );
      } catch (error) {
        console.error("[kernel] plugin disposal failed", error);
      }
    }
  }
}
