import type {
  BusEnvelope,
  ChannelAttachmentHandle,
  ChannelCapacity,
  CommandDefinition,
  CommandInput,
  CommandOutput,
  CostSummary,
  DataClassification,
  EventDefinition,
  EventPayload,
  EmbeddedContentSnapshot,
  FeedbackAnswer,
  LoopEvent,
  LoopRunSnapshot,
  LoopStartInput,
  ModelDescriptor,
  PendingInteraction,
  Persona,
  PromptScanFinding,
  PromptScanStage,
  ToolSecurityMetadata,
  UsageRecord,
  WorkspaceFile,
  DynamicToolDefinition,
  ToolApproval,
} from "@borg/contracts";
import { z } from "zod";

export { z } from "zod";
export type {
  ChannelAttachmentHandle,
  ChannelCapacity,
  DataClassification,
  DynamicToolDefinition,
  PromptScanAction,
  PromptScanFinding,
  PromptScanStage,
  ToolApproval,
  ToolSecurityMetadata,
} from "@borg/contracts";

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
  readonly sessionId?: string | undefined;
  readonly workspaceRoot?: string | undefined;
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
  readonly approval: ToolApproval;
  readonly sideEffect: boolean;
  readonly security?: ToolSecurityMetadata | undefined;
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

export interface ToolProviderScope {
  readonly runId: string;
  readonly ownerPluginId: string;
  readonly persona?: Persona | undefined;
  readonly personaId?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly workspaceRoot?: string | undefined;
  readonly signal: AbortSignal;
}

export interface PreparedToolCatalog {
  readonly definitions: readonly DynamicToolDefinition[];
  execute(
    toolId: string,
    input: JsonValue,
    context: ToolExecutionContext,
  ): JsonValue | Promise<JsonValue>;
  dispose?(): void | Promise<void>;
  close?(): void | Promise<void>;
}

export interface ToolProviderContribution {
  readonly id: string;
  readonly namespace?: string | undefined;
  prepare?(
    scope: ToolProviderScope,
  ): PreparedToolCatalog | Promise<PreparedToolCatalog>;
  open?(
    scope: ToolProviderScope,
  ): PreparedToolCatalog | Promise<PreparedToolCatalog>;
}

export function defineToolProvider(
  provider: ToolProviderContribution,
): ToolProviderContribution {
  return Object.freeze(provider);
}

export interface PluginTools {
  register(tool: ToolContribution): Disposable;
  registerProvider(provider: ToolProviderContribution): Disposable;
  registerExecutionScope(options: {
    readonly runId: string;
    readonly sessionId: string;
    readonly personaId?: string | undefined;
    readonly allowedTools?: readonly string[] | undefined;
  }): Disposable & { prepare(): Promise<void> };
  invoke(
    toolId: string,
    input: unknown,
    options?: {
      readonly runId?: string | undefined;
      readonly signal?: AbortSignal | undefined;
    },
  ): Promise<JsonValue>;
}

export interface ModelMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
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
    onToken?: ((token: string) => void | Promise<void>) | undefined,
    onUsage?:
      | ((usage: ModelCompletionResult["usage"]) => void | Promise<void>)
      | undefined,
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
  summary(): CostSummary;
  subscribe(handler: (summary: CostSummary) => void | Promise<void>): Disposable;
}

export interface PluginUiCost {
  summary(): Promise<CostSummary>;
  subscribe(
    handler: (summary: CostSummary) => void | Promise<void>,
  ): Promise<Disposable>;
}

export interface PluginPersonas {
  get(personaId: string): Persona | undefined;
  list(includeArchived?: boolean): readonly Persona[];
  getDefault(): Persona;
  setDefault(personaId: string): Promise<Persona>;
  create(candidate: unknown): Promise<Persona>;
  update(
    personaId: string,
    patch: Readonly<Record<string, unknown>>,
  ): Promise<Persona>;
  archive(personaId: string): Promise<void>;
}

export interface PluginWorkspace {
  allocate(sessionId: string): {
    readonly sessionId: string;
    readonly rootPath: string;
  };
  get(sessionId: string):
    | {
        readonly sessionId: string;
        readonly rootPath: string;
      }
    | undefined;
  listFiles(sessionId: string): Promise<readonly WorkspaceFile[]>;
  release(sessionId: string): Promise<void>;
}

export interface PromptSlotContext {
  readonly personaId: string;
  readonly sessionId?: string | undefined;
  readonly feature?: string | undefined;
}

export interface PromptSlotContribution {
  readonly id: string;
  readonly order: number;
  render(context: PromptSlotContext): string | undefined;
}

export interface PluginPrompts {
  registerSlot(slot: PromptSlotContribution): Disposable;
}

export interface PromptScanContext {
  readonly stage: PromptScanStage;
  readonly text: string;
  readonly truncated: boolean;
  readonly source: {
    readonly kind: "user" | "channel" | "tool" | "model";
    readonly id: string;
  };
  readonly runId?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly signal: AbortSignal;
}

export interface PromptScannerContribution {
  readonly id: string;
  readonly stages: readonly PromptScanStage[];
  scan(context: PromptScanContext): Promise<readonly PromptScanFinding[]>;
}

export interface PluginScanners {
  register(scanner: PromptScannerContribution): Disposable;
}

export interface ChannelInboundDraft {
  readonly text: string;
  readonly destinationId: string;
  readonly externalId: string;
  readonly sender?: string | undefined;
  readonly classification?: DataClassification | undefined;
  readonly attachments?: readonly ChannelAttachmentHandle[] | undefined;
  readonly metadata?: Readonly<Record<string, JsonValue>> | undefined;
  readonly receivedAt?: string | undefined;
}

export interface ChannelSendRequest {
  readonly adapterId: string;
  readonly destinationId: string;
  readonly text: string;
  readonly idempotencyKey: string;
  readonly classification?: DataClassification | undefined;
  readonly runId?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly attachments?: readonly ChannelAttachmentHandle[] | undefined;
  readonly signal?: AbortSignal | undefined;
}

export type ChannelSendReceipt =
  | {
      readonly status: "sent";
      readonly messageId: string;
      readonly externalId: string;
      readonly sentAt: string;
    }
  | {
      readonly status: "duplicate";
      readonly messageId: string;
      readonly externalId?: string | undefined;
    }
  | {
      readonly status: "denied";
      readonly reasons: readonly string[];
    };

export interface ChannelAdapterReceipt {
  readonly externalId: string;
  readonly sentAt: string;
}

export interface ChannelAdapter {
  readonly id: string;
  readonly capacity: ChannelCapacity;
  readonly destinations: readonly string[];
  start?(options: {
    readonly ingest: (draft: ChannelInboundDraft) => void | Promise<void>;
    readonly signal: AbortSignal;
  }): void | Disposable | Promise<void | Disposable>;
  send(
    request: ChannelSendRequest,
  ): ChannelAdapterReceipt | Promise<ChannelAdapterReceipt>;
}

export interface PluginChannels {
  register(adapter: ChannelAdapter): Disposable;
  send(request: ChannelSendRequest): Promise<ChannelSendReceipt>;
}

export interface PluginWebSocketConnectOptions {
  readonly signal?: AbortSignal | undefined;
  readonly protocols?: readonly string[] | undefined;
  readonly maxMessageBytes?: number | undefined;
  readonly maxQueuedMessages?: number | undefined;
}

export interface PluginWebSocketConnection extends Disposable {
  readonly ready: Promise<void>;
  onMessage(handler: (data: string) => void | Promise<void>): Disposable;
  onClose(
    handler: (code: number, reason: string) => void | Promise<void>,
  ): Disposable;
  onError(handler: (error: Error) => void | Promise<void>): Disposable;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface PluginWebSockets {
  connect(
    url: string,
    options?: PluginWebSocketConnectOptions | undefined,
  ): Promise<PluginWebSocketConnection>;
}

export interface GraphStepExecutionContext {
  readonly instanceId: string;
  readonly nodeId: string;
  readonly input: Readonly<Record<string, JsonValue>>;
  readonly variables: Readonly<Record<string, JsonValue>>;
  readonly signal: AbortSignal;
}

export interface GraphStepContribution {
  readonly kind: string;
  readonly type: "task" | "control";
  readonly label: string;
  readonly replaySafe?: boolean;
  readonly configSchema: z.ZodType;
  execute(
    config: JsonValue,
    context: GraphStepExecutionContext,
  ): JsonValue | Promise<JsonValue>;
}

export interface GraphTriggerContribution {
  readonly kind: string;
  readonly label: string;
  readonly configSchema: z.ZodType;
  subscribe(
    config: JsonValue,
    trigger: (input?: Readonly<Record<string, JsonValue>>) => void | Promise<void>,
    signal: AbortSignal,
  ): Disposable | Promise<Disposable>;
}

export interface PluginGraphs {
  registerStep(contribution: GraphStepContribution): Disposable;
  registerTrigger(contribution: GraphTriggerContribution): Disposable;
  listSteps(): readonly GraphStepContribution[];
  listTriggers(): readonly GraphTriggerContribution[];
}

export interface PluginScheduler {
  schedule(
    id: string,
    runAt: string,
    callback: (signal: AbortSignal) => void | Promise<void>,
  ): Disposable;
  scheduleCron(
    id: string,
    expression: string,
    callback: (signal: AbortSignal) => void | Promise<void>,
  ): Disposable;
  cancel(id: string): boolean;
}

export interface PluginRuntime {
  spawn(task: (signal: AbortSignal) => void | Promise<void>): Disposable;
}

export interface PluginProcessSpawnOptions {
  readonly cwd?: string | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly graceTimeoutMs?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface PluginProcessExit {
  readonly code: number | null;
  readonly signal: string | null;
}

export interface PluginProcess extends Disposable {
  readonly pid: number;
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exit: Promise<PluginProcessExit>;
  close(): Promise<void>;
  kill(): Promise<void>;
}

export interface PluginProcesses {
  spawn(
    command: string,
    args: readonly string[],
    options?: PluginProcessSpawnOptions,
  ): Promise<PluginProcess>;
}

export interface PluginHttp {
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
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
      envelope: BusEnvelope,
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
    handler: (
      payload: EventPayload<TEvent>,
      envelope: BusEnvelope,
    ) => void | Promise<void>,
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
  readonly personas: PluginPersonas;
  readonly workspace: PluginWorkspace;
  readonly prompts: PluginPrompts;
  readonly scanners: PluginScanners;
  readonly graphs: PluginGraphs;
  readonly scheduler: PluginScheduler;
  readonly runtime: PluginRuntime;
  readonly process: PluginProcesses;
  readonly http: PluginHttp;
  readonly channels: PluginChannels;
  readonly webSockets: PluginWebSockets;
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

export interface PluginTestHarness {
  readonly plugin: PluginDefinition;
  readonly context: PluginContext;
  deactivate(): Promise<void>;
}

export async function createTestHarness(
  plugin: PluginDefinition,
  context: PluginContext,
): Promise<PluginTestHarness> {
  if (plugin.id !== context.pluginId) {
    throw new Error(
      `Plugin ${plugin.id} cannot activate in harness context ${context.pluginId}`,
    );
  }
  const activation = await plugin.activate(context);
  let active = true;
  return {
    plugin,
    context,
    deactivate: async () => {
      if (!active) {
        return;
      }
      active = false;
      try {
        await plugin.deactivate?.(context);
      } finally {
        await activation?.dispose();
      }
    },
  };
}

export interface FlightDeckWidgetContribution<TComponent = unknown> {
  readonly id: string;
  readonly label: string;
  readonly order?: number;
  readonly placement?: "primary" | "developer";
  readonly component: TComponent;
}

export interface WorkspaceViewContribution<TComponent = unknown> {
  readonly id: string;
  readonly label: string;
  readonly order?: number;
  readonly placement?: "primary" | "developer";
  readonly component: TComponent;
}

export interface SettingsPageContribution<TComponent = unknown> {
  readonly id: string;
  readonly label: string;
  readonly order?: number;
  readonly placement?: "primary" | "developer";
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

export interface EmbeddedContentRendererProps {
  readonly content: EmbeddedContentSnapshot;
}

export interface EmbeddedContentRendererContribution<TComponent = unknown> {
  readonly id: string;
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
  registerEmbeddedContentRenderer(
    contribution: EmbeddedContentRendererContribution<
      (props: EmbeddedContentRendererProps) => unknown
    >,
  ): Disposable;
  getEmbeddedContentRenderer(
    id: string,
  ):
    | EmbeddedContentRendererContribution<
        (props: EmbeddedContentRendererProps) => unknown
      >
    | undefined;
}

export interface PluginUiBus {
  invoke<TCommand extends CommandDefinition>(
    command: TCommand,
    input: CommandInput<TCommand>,
  ): Promise<CommandOutput<TCommand>>;
  provides(command: CommandDefinition): Promise<boolean>;
  on<TEvent extends EventDefinition>(
    event: TEvent,
    handler: (
      payload: EventPayload<TEvent>,
      envelope: BusEnvelope,
    ) => void | Promise<void>,
  ): Promise<Disposable>;
}

export interface PluginUiPersonas {
  get(personaId: string): Promise<Persona | undefined>;
  list(includeArchived?: boolean): Promise<readonly Persona[]>;
  getDefault(): Promise<Persona>;
  setDefault(personaId: string): Promise<Persona>;
  create(candidate: unknown): Promise<Persona>;
  update(
    personaId: string,
    patch: Readonly<Record<string, unknown>>,
  ): Promise<Persona>;
}

export interface PluginUiModels {
  list(): Promise<readonly ModelDescriptor[]>;
}

export interface PluginUiContext<TComponent = unknown> {
  readonly pluginId: string;
  readonly bus: PluginUiBus;
  readonly ui: PluginUiHost<TComponent>;
  readonly config: Pick<PluginConfig, "get" | "update">;
  readonly secrets: Pick<PluginSecrets, "set" | "delete" | "has">;
  readonly loops: PluginUiLoops;
  readonly interactions: PluginUiInteractions;
  readonly personas: PluginUiPersonas;
  readonly models: PluginUiModels;
  readonly cost: PluginUiCost;
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
