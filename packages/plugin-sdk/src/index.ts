import type {
  CommandDefinition,
  CommandInput,
  CommandOutput,
  EventDefinition,
  EventPayload,
  FeedbackAnswer,
  LoopEvent,
  LoopRunSnapshot,
  LoopStartInput,
  PendingInteraction,
  UsageRecord,
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

export interface ToolExecutionContext {
  readonly toolCallId: string;
  readonly runId?: string | undefined;
  readonly signal: AbortSignal;
}

export interface ToolContribution<
  TInput extends z.ZodType = z.ZodType,
  TOutput extends z.ZodType = z.ZodType,
> {
  readonly id: string;
  readonly description: string;
  readonly input: TInput;
  readonly output: TOutput;
  readonly approval: "auto" | "ask" | "deny";
  readonly sideEffect: boolean;
  execute(
    input: z.output<TInput>,
    context: ToolExecutionContext,
  ): z.input<TOutput> | Promise<z.input<TOutput>>;
}

export function defineTool<
  const TInput extends z.ZodType,
  const TOutput extends z.ZodType,
>(
  tool: ToolContribution<TInput, TOutput>,
): ToolContribution<TInput, TOutput> {
  return Object.freeze(tool);
}

export interface PluginTools {
  register(tool: ToolContribution): Disposable;
  invoke(
    toolId: string,
    input: unknown,
    options?: {
      readonly runId?: string | undefined;
    },
  ): Promise<JsonValue>;
}

export interface ModelMessage {
  readonly role: "user" | "assistant" | "tool";
  readonly content: string;
  readonly toolCallId?: string | undefined;
  readonly toolCalls?: readonly ModelToolCall[] | undefined;
}

export interface ModelToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

export interface ModelCompletionRequest {
  readonly modelId: string;
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly {
    readonly id: string;
    readonly description: string;
    readonly inputSchema: JsonValue;
  }[];
}

export interface ModelCompletionResult {
  readonly content?: string | undefined;
  readonly toolCalls?: readonly ModelToolCall[] | undefined;
  readonly usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cachedInputTokens?: number | undefined;
    readonly cacheWriteTokens?: number | undefined;
    readonly amount?: number | undefined;
    readonly currency?: string | undefined;
  };
}

export interface LlmProviderContribution {
  readonly id: string;
  readonly models: readonly string[];
  complete(
    request: ModelCompletionRequest,
    signal: AbortSignal,
  ): Promise<ModelCompletionResult>;
}

export interface PluginModels {
  registerProvider(provider: LlmProviderContribution): Disposable;
  complete(
    request: {
      readonly providerId?: string | undefined;
      readonly modelId?: string | undefined;
      readonly messages: readonly ModelMessage[];
    },
    signal?: AbortSignal,
  ): Promise<{
    readonly providerId: string;
    readonly modelId: string;
    readonly result: ModelCompletionResult;
  }>;
}

export interface PluginLoops {
  start(input: LoopStartInput): Promise<LoopRunSnapshot>;
  get(runId: string): LoopRunSnapshot | undefined;
  list(): readonly LoopRunSnapshot[];
  pause(runId: string): boolean;
  resume(runId: string): boolean;
  cancel(runId: string): boolean;
  subscribe(
    runId: string,
    handler: (event: LoopEvent) => void | Promise<void>,
  ): Disposable;
}

export interface PluginUiLoops {
  start(input: LoopStartInput): Promise<LoopRunSnapshot>;
  get(runId: string): Promise<LoopRunSnapshot | undefined>;
  list(): Promise<readonly LoopRunSnapshot[]>;
  subscribe(
    runId: string,
    handler: (event: LoopEvent) => void | Promise<void>,
  ): Promise<Disposable>;
  pause(runId: string): Promise<boolean>;
  resume(runId: string): Promise<boolean>;
  cancel(runId: string): Promise<boolean>;
}

export interface PluginUiInteractions {
  list(): Promise<readonly PendingInteraction[]>;
}

export interface HumanInputRequest {
  readonly title?: string | undefined;
  readonly prompt: string;
  readonly form: "text" | "confirm" | "choice";
  readonly choices?:
    | readonly { readonly id: string; readonly label: string }[]
    | undefined;
  readonly source: {
    readonly sessionId?: string | undefined;
    readonly runId?: string | undefined;
    readonly instanceId?: string | undefined;
    readonly stepId?: string | undefined;
    readonly toolCallId?: string | undefined;
  };
  readonly timeoutMs?: number | undefined;
}

export interface PluginInteractions {
  requestHumanInput(
    request: HumanInputRequest,
    signal?: AbortSignal,
  ): {
    readonly interactionId: string;
    readonly response: Promise<FeedbackAnswer>;
  };
}

export interface PluginCost {
  record(record: UsageRecord): void;
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
    options?: { readonly signal?: AbortSignal | undefined },
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
  readonly tools: PluginTools;
  readonly models: PluginModels;
  readonly loops: PluginLoops;
  readonly interactions: PluginInteractions;
  readonly cost: PluginCost;
  readonly window: {
    show(): void;
  };
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

export interface InteractionRendererProps {
  readonly interaction: PendingInteraction;
  respond(response: import("@borg/contracts").InteractionResponse): Promise<void>;
}

export interface InteractionRendererContribution<TComponent = unknown> {
  readonly id: string;
  readonly kind: "tool_approval" | "classification" | "human_input";
  readonly component: TComponent;
}

export interface PluginUiHost<TComponent = unknown> {
  registerWorkspaceView(contribution: WorkspaceViewContribution<TComponent>): Disposable;
  registerSettingsPage(contribution: SettingsPageContribution<TComponent>): Disposable;
  registerWizardStep(contribution: WizardStepContribution<TComponent>): Disposable;
  registerFlightDeckWidget(
    contribution: FlightDeckWidgetContribution<TComponent>,
  ): Disposable;
  registerInteractionRenderer(
    contribution: InteractionRendererContribution<
      (props: InteractionRendererProps) => unknown
    >,
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
  readonly loops: PluginUiLoops;
  readonly interactions: PluginUiInteractions;
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
