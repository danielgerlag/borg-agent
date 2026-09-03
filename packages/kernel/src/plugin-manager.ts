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
import { CommandEventBus } from "./command-event-bus";
import { satisfiesBorgEngine } from "./engine-range";
import { PluginLoadError } from "./errors";
import type { NotificationService } from "./notification-service";
import type {
  ConfigFacade,
  PersistenceRegistry,
  SecretFacade,
  StoreFacade,
} from "./persistence";

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
  getPluginDataDirectory?(pluginId: string): string;
}

interface ActivePlugin {
  readonly manifest: BorgPluginManifest;
  readonly definition: PluginDefinition;
  readonly controller: AbortController;
  readonly context: PluginContext;
  readonly disposables: Disposable[];
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
  readonly #shutdownTimeoutMs: number;
  readonly #options: PluginManagerOptions;

  constructor(
    readonly bus: CommandEventBus,
    readonly hostVersion: string,
    options: PluginManagerOptions = {},
  ) {
    this.#shutdownTimeoutMs =
      options.shutdownTimeoutMs ?? DEFAULT_PLUGIN_SHUTDOWN_TIMEOUT_MS;
    this.#options = options;
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
      return record;
    }

    this.#records.set(manifest.id, {
      id: manifest.id,
      version: manifest.version,
      status: "activating",
    });

    const controller = new AbortController();
    const disposables: Disposable[] = [];
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
              this.bus.handle(manifest.id, commandIds, command, (input, signal) =>
                handler(input, AbortSignal.any([signal, controller.signal])),
              ),
            );
          },
          invoke: (command, input) => {
            assertOrdinaryContext();
            if (controller.signal.aborted) {
              throw new Error(`Plugin ${manifest.id} context is no longer active`);
            }
            return this.bus.invoke(command, input);
          },
          provides: (command: CommandDefinition) => {
            assertOrdinaryContext();
            return !controller.signal.aborted && this.bus.provides(command);
          },
          emit: (event, payload) => {
            assertOrdinaryContext();
            if (!activationCommitted || controller.signal.aborted) {
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
        uiCapability: randomUUID(),
      });
      this.#activationOrder.push(manifest.id);

      const record: PluginRecord = {
        id: manifest.id,
        version: manifest.version,
        status: "active",
      };
      this.#records.set(manifest.id, record);
      return record;
    } catch (error) {
      controller.abort(error);
      await this.#disposeAll(disposables);
      this.bus.removePlugin(manifest.id);

      const message = error instanceof Error ? error.message : String(error);
      this.#records.set(manifest.id, {
        id: manifest.id,
        version: manifest.version,
        status: "failed",
        error: message,
      });

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
    this.bus.removePlugin(pluginId);
    active.controller.abort(new Error(`Plugin ${pluginId} is deactivating`));

    let deactivationError: unknown;
    const shutdownDeadline = Date.now() + this.#shutdownTimeoutMs;
    try {
      await withTimeout(
        async () => active.definition.deactivate?.(active.context),
        Math.max(1, shutdownDeadline - Date.now()),
        `Plugin ${pluginId} deactivation`,
      );
    } catch (error) {
      deactivationError = error;
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
