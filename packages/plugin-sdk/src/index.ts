import type {
  CommandDefinition,
  CommandInput,
  CommandOutput,
  EventDefinition,
  EventPayload,
} from "@borg/contracts";
import { z } from "zod";

export { z } from "zod";

export interface Disposable {
  dispose(): void | Promise<void>;
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | { readonly [key: string]: JsonValue }
  | readonly JsonValue[];

export interface StoreEntry {
  readonly key: string;
  readonly value: JsonValue;
}

export type StoreTransactionOperation =
  | {
      readonly type: "set";
      readonly key: string;
      readonly value: JsonValue;
    }
  | {
      readonly type: "delete";
      readonly key: string;
    };

export interface ConfigStoreProvider {
  readConfig(namespace: string): Promise<unknown | undefined>;
  writeConfig(namespace: string, value: JsonValue): Promise<void>;
  getStore(namespace: string, key: string): Promise<JsonValue | undefined>;
  listStore(namespace: string, prefix: string): Promise<readonly StoreEntry[]>;
  applyStoreTransaction(
    namespace: string,
    operations: readonly StoreTransactionOperation[],
  ): Promise<void>;
}

export interface SecretStoreProvider {
  readonly kind: "development" | "os";
  get(namespace: string, key: string): Promise<string | undefined>;
  set(namespace: string, key: string, value: string): Promise<void>;
  delete(namespace: string, key: string): Promise<void>;
  has(namespace: string, key: string): Promise<boolean>;
}

export interface PluginConfig {
  get(): Promise<Readonly<Record<string, unknown>>>;
  update(
    patch: Readonly<Record<string, unknown>>,
  ): Promise<Readonly<Record<string, unknown>>>;
  watch(
    handler: (config: Readonly<Record<string, unknown>>) => void | Promise<void>,
  ): Disposable;
}

export interface PluginStore {
  get(key: string): Promise<JsonValue | undefined>;
  set(key: string, value: JsonValue): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<readonly StoreEntry[]>;
  transaction(operations: readonly StoreTransactionOperation[]): Promise<void>;
}

export interface PluginSecrets {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  has(key: string): Promise<boolean>;
}

export interface PluginPersistenceContributions {
  registerConfigStore(provider: ConfigStoreProvider): Disposable;
  registerSecretStore(provider: SecretStoreProvider): Disposable;
}

export interface NotificationRequest {
  readonly title: string;
  readonly body: string;
  readonly level?: "info" | "success" | "warning" | "error" | undefined;
  readonly os?: boolean | undefined;
}

export interface PluginLogger {
  debug(message: string, metadata?: Readonly<Record<string, unknown>>): void;
  info(message: string, metadata?: Readonly<Record<string, unknown>>): void;
  warn(message: string, metadata?: Readonly<Record<string, unknown>>): void;
  error(message: string, metadata?: Readonly<Record<string, unknown>>): void;
}

export interface PluginBus {
  handle<TCommand extends CommandDefinition>(
    command: TCommand,
    handler: (
      input: CommandInput<TCommand>,
      signal: AbortSignal,
    ) => CommandOutput<TCommand> | Promise<CommandOutput<TCommand>>,
  ): Disposable;
  invoke<TCommand extends CommandDefinition>(
    command: TCommand,
    input: CommandInput<TCommand>,
  ): Promise<CommandOutput<TCommand>>;
  provides(command: CommandDefinition): boolean;
  emit<TEvent extends EventDefinition>(
    event: TEvent,
    payload: EventPayload<TEvent>,
  ): Promise<void>;
  on<TEvent extends EventDefinition>(
    event: TEvent,
    handler: (payload: EventPayload<TEvent>) => void | Promise<void>,
  ): Disposable;
}

export interface PluginContext {
  readonly pluginId: string;
  readonly signal: AbortSignal;
  readonly bus: PluginBus;
  readonly config: PluginConfig;
  readonly store: PluginStore;
  readonly secrets: PluginSecrets;
  readonly persistence: PluginPersistenceContributions;
  readonly dataDir: string;
  notify(request: NotificationRequest): void;
  readonly logger: PluginLogger;
  readonly host: {
    readonly version: string;
    readonly platform: string;
  };
}

export interface PluginContributionDeclaration {
  readonly commands?: readonly string[] | undefined;
  readonly events?: readonly string[] | undefined;
  readonly extensionPoints?: readonly string[] | undefined;
  readonly kinds?: readonly string[] | undefined;
}

export interface PluginDefinition {
  readonly id: string;
  readonly version: string;
  readonly engines: {
    readonly borg: string;
  };
  readonly permissions: readonly string[];
  readonly contributes: PluginContributionDeclaration;
  readonly configSchema?: z.ZodType;
  activate(context: PluginContext): void | Disposable | Promise<void | Disposable>;
  deactivate?(context: PluginContext): void | Promise<void>;
}

export interface BorgPluginManifest {
  readonly id: string;
  readonly version: string;
  readonly engines: {
    readonly borg: string;
  };
  readonly main: string;
  readonly ui?: string | undefined;
  readonly permissions: readonly string[];
  readonly contributes: PluginContributionDeclaration;
}

const semanticVersionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export const pluginManifestSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:[.-][a-z0-9-]+)+$/),
  version: z.string().regex(semanticVersionPattern),
  engines: z.object({
    borg: z.string().min(1),
  }),
  main: z.string().min(1),
  ui: z.string().min(1).optional(),
  permissions: z.array(z.string()),
  contributes: z.object({
    commands: z.array(z.string()).optional(),
    events: z.array(z.string()).optional(),
    extensionPoints: z.array(z.string()).optional(),
    kinds: z.array(z.string()).optional(),
  }),
});

export function definePlugin<const TPlugin extends PluginDefinition>(plugin: TPlugin): TPlugin {
  return Object.freeze(plugin);
}

export interface FlightDeckWidgetContribution<TComponent = unknown> {
  readonly id: string;
  readonly label: string;
  readonly order?: number;
  readonly component: TComponent;
}

export interface WorkspaceViewContribution<TComponent = unknown> {
  readonly id: string;
  readonly label: string;
  readonly order?: number;
  readonly component: TComponent;
}

export interface SettingsPageContribution<TComponent = unknown> {
  readonly id: string;
  readonly label: string;
  readonly order?: number;
  readonly component: TComponent;
}

export interface WizardStepContribution<TComponent = unknown> {
  readonly id: string;
  readonly label: string;
  readonly order?: number;
  readonly required?: boolean;
  readonly isComplete?: () => boolean;
  readonly component: TComponent;
}

export interface PluginUiHost<TComponent = unknown> {
  registerWorkspaceView(contribution: WorkspaceViewContribution<TComponent>): Disposable;
  registerSettingsPage(contribution: SettingsPageContribution<TComponent>): Disposable;
  registerWizardStep(contribution: WizardStepContribution<TComponent>): Disposable;
  registerFlightDeckWidget(
    contribution: FlightDeckWidgetContribution<TComponent>,
  ): Disposable;
}

export interface PluginUiBus {
  invoke<TCommand extends CommandDefinition>(
    command: TCommand,
    input: CommandInput<TCommand>,
  ): Promise<CommandOutput<TCommand>>;
  provides(command: CommandDefinition): Promise<boolean>;
}

export interface PluginUiContext<TComponent = unknown> {
  readonly pluginId: string;
  readonly bus: PluginUiBus;
  readonly ui: PluginUiHost<TComponent>;
  readonly config: Pick<PluginConfig, "get" | "update">;
  readonly secrets: Pick<PluginSecrets, "set" | "delete" | "has">;
  notify(request: NotificationRequest): Promise<void>;
}

export interface PluginUiDefinition<TComponent = unknown> {
  readonly id: string;
  activate(context: PluginUiContext<TComponent>): void | Disposable | Promise<void | Disposable>;
}

export function defineUiPlugin<TComponent>(
  plugin: PluginUiDefinition<TComponent>,
): PluginUiDefinition<TComponent> {
  return Object.freeze(plugin);
}
