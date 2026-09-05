import {
  z,
  type Disposable,
  type DynamicToolDefinition,
  type ExecutionId,
  type JsonValue,
  type ParentExecutionGrant,
  type PreparedToolCatalog,
  type ToolContribution,
  type ToolExecutionContext,
  type ToolProviderContribution,
  type ToolProviderScope,
} from "@borg/plugin-sdk";
import {
  channelCapacitySchema,
  dataClassificationSchema,
  type ChannelCapacity,
  type DataClassification,
  type OutputProvenance,
  type Persona,
  type ToolSecurityMetadata,
} from "@borg/contracts";
import { randomUUID } from "node:crypto";
import type { ClassificationService } from "./classification-service";
import type { ExecutionSecurityService } from "./execution-security";
import { InteractionService } from "./interaction-service";
import {
  assertBoundedJsonSchema,
  validateAgainstJsonSchema,
} from "./json-schema";
import type { ScannerRegistry } from "./scanner-registry";
import {
  TrustAuthorizer,
  type AuthorizationRequest,
  type AuthorizationResult,
} from "./trust-authorizer";

const STATIC_TOOL_ID = /^[a-z0-9]+(?:[.-][a-z0-9-]+)+$/;
const DYNAMIC_TOOL_ID = /^[a-z0-9]+(?:[.-][a-z0-9-]+)+$/;
const DYNAMIC_TOOL_NAMESPACE = /^[a-z0-9]+(?:[.-][a-z0-9-]+)*$/;
const PROVIDER_ID = /^[a-z0-9]+(?:[.-][a-z0-9-]+)+$/;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_NODES = 100_000;

/** An unlabelled tool result is internal, never public. */
const DEFAULT_OUTPUT_CLASSIFICATION: DataClassification = "internal";

/**
 * Resolved tool security metadata: declared fields plus the kernel defaults
 * the pipeline enforces.
 */
export interface ResolvedToolSecurity {
  readonly inputClassification?: DataClassification | undefined;
  readonly outputClassification: DataClassification;
  readonly outputProvenance: OutputProvenance;
  readonly channelCapacity?: ChannelCapacity | undefined;
}

export interface ToolServiceSecurity {
  readonly classification?: ClassificationService | undefined;
  readonly executions?: ExecutionSecurityService | undefined;
  readonly scanners?: ScannerRegistry | undefined;
  readonly authorizer?: TrustAuthorizer | undefined;
}

interface RegisteredTool {
  readonly pluginId: string;
  readonly tool: ToolContribution;
  readonly inputSchema: JsonValue;
  readonly security: ResolvedToolSecurity;
  readonly controller: AbortController;
  readonly workspaceAccess: boolean;
}

interface RegisteredProvider {
  readonly pluginId: string;
  readonly provider: ToolProviderContribution;
  readonly controller: AbortController;
  readonly workspaceAccess: boolean;
}

interface DynamicToolBinding {
  readonly definition: DynamicToolDefinition;
  readonly catalog: PreparedToolCatalog;
  readonly pluginId: string;
  readonly providerId: string;
  readonly security: ResolvedToolSecurity;
  readonly workspaceAccess: boolean;
  readonly controller: AbortController;
}

interface CatalogLease {
  readonly catalog: PreparedToolCatalog;
  readonly pluginId: string;
  readonly providerId: string;
  readonly controller: AbortController;
}

interface RunToolPolicy {
  readonly ownerPluginId: string;
  readonly executionId?: ExecutionId | undefined;
  readonly allowedToolGroups: readonly (readonly string[])[];
  readonly controller: AbortController;
  readonly sessionId?: string | undefined;
  readonly workspaceRoot?: string | undefined;
  readonly persona?: Persona | undefined;
  readonly personaId?: string | undefined;
  readonly dynamicTools: Map<string, DynamicToolBinding>;
  readonly catalogs: CatalogLease[];
  classificationRun?: Disposable | undefined;
  preparePromise?: Promise<void> | undefined;
  prepared: boolean;
}

interface ResolvedInvocation {
  readonly toolId: string;
  readonly pluginId: string;
  readonly approval: "auto" | "ask" | "deny";
  readonly security: ResolvedToolSecurity;
  readonly workspaceAccess: boolean;
  readonly extraSignals: readonly AbortSignal[];
  parseInput(candidate: unknown): JsonValue;
  parseOutput(result: unknown): JsonValue;
  execute(
    input: JsonValue,
    context: ToolExecutionContext,
  ): unknown | Promise<unknown>;
  isCurrent(): boolean;
}

export class ToolInvocationError extends Error {
  readonly reasons: readonly string[];

  constructor(
    readonly code: "unavailable" | "forbidden" | "denied" | "invalid" | "failed",
    message: string,
    options?: (ErrorOptions & { readonly reasons?: readonly string[] }) | undefined,
  ) {
    super(message, options);
    this.name = "ToolInvocationError";
    this.reasons = Object.freeze([...(options?.reasons ?? [])]);
  }
}

export interface ToolInvocationOptions {
  readonly callerPluginId: string;
  readonly toolCallId?: string | undefined;
  readonly runId?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  beforeAuthorization?(): void | Promise<void>;
  beforeCommit?(): void | Promise<void>;
  onInteraction?(interactionId: string): void;
}

export interface RegisterRunPolicyContext {
  readonly executionId?: ExecutionId | undefined;
  readonly initialClassification?: DataClassification | undefined;
  readonly sessionId?: string | undefined;
  readonly workspaceRoot?: string | undefined;
  readonly additionalAllowedTools?: readonly string[] | undefined;
  readonly persona?: Persona | undefined;
  readonly personaId?: string | undefined;
}

function isAllowed(toolId: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    if (pattern === "*") {
      return true;
    }
    if (pattern.endsWith("*")) {
      return toolId.startsWith(pattern.slice(0, -1));
    }
    return toolId === pattern;
  });
}

function isAllowedByAll(
  toolId: string,
  patternGroups: readonly (readonly string[])[],
): boolean {
  return patternGroups.every((patterns) => isAllowed(toolId, patterns));
}

function asJsonValue(value: unknown): JsonValue {
  return cloneJsonValue(value, 0, { remaining: MAX_JSON_NODES }, new WeakSet());
}

function cloneJsonValue(
  value: unknown,
  depth: number,
  budget: { remaining: number },
  ancestors: WeakSet<object>,
): JsonValue {
  budget.remaining -= 1;
  if (depth > MAX_JSON_DEPTH || budget.remaining < 0) {
    throw new ToolInvocationError(
      "invalid",
      "Tool value exceeds JSON complexity limits",
    );
  }
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) {
      throw new ToolInvocationError("invalid", "Tool value contains a cycle");
    }
    ancestors.add(value);
    try {
      return Object.freeze(
        value.map((entry) =>
          cloneJsonValue(entry, depth + 1, budget, ancestors),
        ),
      );
    } finally {
      ancestors.delete(value);
    }
  }
  if (
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.getOwnPropertySymbols(value).length === 0
  ) {
    if (ancestors.has(value)) {
      throw new ToolInvocationError("invalid", "Tool value contains a cycle");
    }
    ancestors.add(value);
    try {
      return Object.freeze(
        Object.fromEntries(
          Object.entries(value).map(([key, entry]) => [
            key,
            cloneJsonValue(entry, depth + 1, budget, ancestors),
          ]),
        ),
      );
    } finally {
      ancestors.delete(value);
    }
  }
  throw new ToolInvocationError(
    "invalid",
    "Tool output is not JSON-serializable",
  );
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object") {
    return value;
  }
  const stack: object[] = [value];
  const seen = new WeakSet<object>();
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (seen.has(current)) {
      continue;
    }
    seen.add(current);
    for (const entry of Object.values(current)) {
      if (entry && typeof entry === "object") {
        stack.push(entry);
      }
    }
    Object.freeze(current);
  }
  return value;
}

function freezePersonaSnapshot(persona: Persona): Persona {
  return deepFreeze(structuredClone(persona));
}

function freezeDefinition(
  definition: DynamicToolDefinition,
  security: ResolvedToolSecurity,
): DynamicToolDefinition {
  const inputSchema = asJsonValue(definition.inputSchema);
  const frozen: DynamicToolDefinition = {
    id: definition.id,
    description: definition.description,
    inputSchema,
    approval: definition.approval,
    sideEffect: definition.sideEffect,
    security,
    ...(definition.modelVisible !== undefined
      ? { modelVisible: definition.modelVisible }
      : {}),
    ...(definition.outputSchema !== undefined
      ? { outputSchema: asJsonValue(definition.outputSchema) }
      : {}),
  };
  return deepFreeze(frozen);
}

function parseSecurityField<T>(
  toolId: string,
  field: string,
  candidate: unknown,
  parse: (value: unknown) => { readonly success: boolean; readonly data?: T },
): T | undefined {
  if (candidate === undefined) {
    return undefined;
  }
  const parsed = parse(candidate);
  if (!parsed.success) {
    throw new Error(
      `Tool ${toolId} security ${field} ${String(candidate)} is invalid`,
    );
  }
  return parsed.data;
}

/**
 * `sideEffect` says a tool changes something; it never implies the tool can
 * reach a channel, so a capacity ceiling only comes from a declared capacity.
 */
function resolveToolSecurity(
  toolId: string,
  candidate: ToolSecurityMetadata | undefined,
  defaultProvenance: OutputProvenance,
): ResolvedToolSecurity {
  if (
    candidate !== undefined &&
    (typeof candidate !== "object" || candidate === null)
  ) {
    throw new Error(`Tool ${toolId} security metadata is invalid`);
  }
  const inputClassification = parseSecurityField<DataClassification>(
    toolId,
    "inputClassification",
    candidate?.inputClassification,
    (value) => dataClassificationSchema.safeParse(value),
  );
  const outputClassification =
    parseSecurityField<DataClassification>(
      toolId,
      "outputClassification",
      candidate?.outputClassification,
      (value) => dataClassificationSchema.safeParse(value),
    ) ?? DEFAULT_OUTPUT_CLASSIFICATION;
  const channelCapacity = parseSecurityField<ChannelCapacity>(
    toolId,
    "channelCapacity",
    candidate?.channelCapacity,
    (value) => channelCapacitySchema.safeParse(value),
  );
  const provenance = candidate?.outputProvenance;
  if (
    provenance !== undefined &&
    provenance !== "trusted" &&
    provenance !== "external"
  ) {
    throw new Error(
      `Tool ${toolId} security outputProvenance ${String(provenance)} is invalid`,
    );
  }
  return Object.freeze({
    ...(inputClassification !== undefined ? { inputClassification } : {}),
    outputClassification,
    outputProvenance: provenance ?? defaultProvenance,
    ...(channelCapacity !== undefined ? { channelCapacity } : {}),
  });
}

function providerPrepare(
  provider: ToolProviderContribution,
):
  | ((
      scope: ToolProviderScope,
    ) => PreparedToolCatalog | Promise<PreparedToolCatalog>)
  | undefined {
  if (typeof provider.prepare === "function") {
    return provider.prepare.bind(provider);
  }
  if (typeof provider.open === "function") {
    return provider.open.bind(provider);
  }
  return undefined;
}

function closeCatalog(catalog: PreparedToolCatalog): void {
  const closer = catalog.close ?? catalog.dispose;
  if (typeof closer !== "function") {
    return;
  }
  try {
    const result = closer.call(catalog);
    if (result && typeof result.then === "function") {
      void result.catch((error: unknown) =>
        console.error("[kernel] tool catalog close failed", error),
      );
    }
  } catch (error) {
    console.error("[kernel] tool catalog close failed", error);
  }
}

export class ToolService {
  readonly #tools = new Map<string, RegisteredTool>();
  readonly #providers = new Map<string, RegisteredProvider>();
  readonly #runPolicies = new Map<string, RunToolPolicy>();
  readonly #closedCatalogs = new WeakSet<PreparedToolCatalog>();
  readonly #classification: ClassificationService | undefined;
  readonly #executions: ExecutionSecurityService | undefined;
  readonly #scanners: ScannerRegistry | undefined;
  readonly #authorizer: TrustAuthorizer;

  constructor(
    readonly interactions: InteractionService,
    security: ToolServiceSecurity = {},
  ) {
    this.#classification = security.classification;
    this.#executions = security.executions;
    this.#scanners = security.scanners;
    this.#authorizer =
      security.authorizer ??
      new TrustAuthorizer(
        interactions,
        security.classification ? { classification: security.classification } : {},
      );
  }

  register(
    pluginId: string,
    tool: ToolContribution,
    options?: { readonly workspaceAccess?: boolean | undefined },
  ): Disposable {
    if (
      typeof tool.id !== "string" ||
      !STATIC_TOOL_ID.test(tool.id) ||
      tool.id.length > 512 ||
      typeof tool.description !== "string" ||
      tool.description.trim().length === 0 ||
      tool.description.length > 10_000 ||
      !["auto", "ask", "deny"].includes(tool.approval) ||
      typeof tool.sideEffect !== "boolean" ||
      typeof tool.input?.safeParse !== "function" ||
      typeof tool.output?.safeParse !== "function" ||
      typeof tool.execute !== "function"
    ) {
      throw new Error(`Invalid tool contribution ${tool.id}`);
    }
    if (this.#tools.has(tool.id)) {
      throw new Error(`Tool ${tool.id} is already registered`);
    }
    const toolId = tool.id;
    const inputSchema = asJsonValue(z.toJSONSchema(tool.input));
    const security = resolveToolSecurity(toolId, tool.security, "trusted");
    const registeredTool: ToolContribution = Object.freeze({
      id: tool.id,
      description: tool.description,
      input: tool.input,
      output: tool.output,
      approval: tool.approval,
      sideEffect: tool.sideEffect,
      security,
      execute: tool.execute.bind(tool),
    });
    const registration = {
      pluginId,
      tool: registeredTool,
      inputSchema,
      security,
      controller: new AbortController(),
      workspaceAccess: options?.workspaceAccess === true,
    };
    this.#tools.set(toolId, registration);
    return {
      dispose: () => {
        if (this.#tools.get(toolId) === registration) {
          this.#tools.delete(toolId);
          registration.controller.abort(
            new Error(`Tool ${toolId} was unregistered`),
          );
        }
      },
    };
  }

  registerProvider(
    pluginId: string,
    provider: ToolProviderContribution,
    options?: { readonly workspaceAccess?: boolean | undefined },
  ): Disposable {
    const prepare = providerPrepare(provider);
    if (
      typeof provider.id !== "string" ||
      !PROVIDER_ID.test(provider.id) ||
      provider.id.length > 200 ||
      (provider.namespace !== undefined &&
        (typeof provider.namespace !== "string" ||
          !DYNAMIC_TOOL_NAMESPACE.test(provider.namespace) ||
          provider.namespace.length > 200)) ||
      typeof prepare !== "function"
    ) {
      throw new Error(`Invalid tool provider contribution ${provider.id}`);
    }
    if (this.#providers.has(provider.id)) {
      throw new Error(`Tool provider ${provider.id} is already registered`);
    }
    const providerId = provider.id;
    const registration: RegisteredProvider = {
      pluginId,
      provider: Object.freeze({
        id: provider.id,
        ...(provider.namespace !== undefined
          ? { namespace: provider.namespace }
          : {}),
        prepare,
      }),
      controller: new AbortController(),
      workspaceAccess: options?.workspaceAccess === true,
    };
    this.#providers.set(providerId, registration);
    return {
      dispose: () => {
        if (this.#providers.get(providerId) === registration) {
          this.#removeProvider(registration);
        }
      },
    };
  }

  registerRunPolicy(
    runId: string,
    ownerPluginId: string,
    allowedTools: readonly string[],
    context?: RegisterRunPolicyContext,
  ): Disposable {
    if (this.#runPolicies.has(runId)) {
      throw new Error(`Tool policy for run ${runId} is already registered`);
    }
    const persona = context?.persona
      ? freezePersonaSnapshot(context.persona)
      : undefined;
    const classificationRun =
      context?.executionId &&
      context.initialClassification === undefined
        ? undefined
        : this.#classification?.openRun(
            runId,
            context?.initialClassification,
          );
    const policy: RunToolPolicy = {
      ownerPluginId,
      executionId: context?.executionId,
      allowedToolGroups: Object.freeze(
        [
          allowedTools,
          ...(context?.additionalAllowedTools
            ? [context.additionalAllowedTools]
            : []),
        ].map((patterns) => Object.freeze([...patterns])),
      ),
      controller: new AbortController(),
      sessionId: context?.sessionId,
      workspaceRoot: context?.workspaceRoot,
      ...(persona ? { persona } : {}),
      ...(persona?.id ?? context?.personaId
        ? { personaId: persona?.id ?? context?.personaId }
        : {}),
      dynamicTools: new Map(),
      catalogs: [],
      ...(classificationRun ? { classificationRun } : {}),
      prepared: false,
    };
    this.#runPolicies.set(runId, policy);
    return {
      dispose: () => {
        if (this.#runPolicies.get(runId) === policy) {
          this.#disposePolicy(runId, policy);
        }
      },
    };
  }

  bindExecutionClassification(
    runId: string,
    ownerPluginId: string,
    executionId: ExecutionId,
    classification: DataClassification,
  ): void {
    const policy = this.#runPolicies.get(runId);
    if (
      !policy ||
      policy.ownerPluginId !== ownerPluginId ||
      policy.executionId !== executionId
    ) {
      throw new Error(
        `Tool policy for run ${runId} cannot bind execution ${executionId}`,
      );
    }
    const parsedClassification =
      dataClassificationSchema.parse(classification);
    if (!this.#classification) {
      return;
    }
    if (policy.classificationRun) {
      this.#classification.raise(
        runId,
        parsedClassification,
        `execution ${executionId} classification`,
      );
      return;
    }
    policy.classificationRun = this.#classification.openRun(
      runId,
      parsedClassification,
    );
  }

  async prepareRun(runId: string): Promise<void> {
    const policy = this.#runPolicies.get(runId);
    if (!policy) {
      throw new Error(`Tool policy for run ${runId} is unavailable`);
    }
    if (policy.prepared) {
      return;
    }
    if (policy.preparePromise) {
      await policy.preparePromise;
      return;
    }
    const pending = this.#preparePolicy(runId, policy);
    policy.preparePromise = pending;
    try {
      await pending;
    } finally {
      if (policy.preparePromise === pending) {
        policy.preparePromise = undefined;
      }
    }
  }

  async prepareScope(runId: string): Promise<void> {
    await this.prepareRun(runId);
  }

  removePlugin(pluginId: string): void {
    for (const [toolId, registration] of this.#tools) {
      if (registration.pluginId === pluginId) {
        this.#tools.delete(toolId);
        registration.controller.abort(
          new Error(`Plugin ${pluginId} was deactivated`),
        );
      }
    }
    for (const registration of [...this.#providers.values()]) {
      if (registration.pluginId === pluginId) {
        this.#removeProvider(registration);
      }
    }
  }

  getProviderPluginId(toolId: string, runId?: string): string | undefined {
    const staticTool = this.#tools.get(toolId);
    if (staticTool) {
      return staticTool.pluginId;
    }
    if (runId) {
      return this.#runPolicies.get(runId)?.dynamicTools.get(toolId)?.pluginId;
    }
    return undefined;
  }

  listDefinitions(
    allowedTools: readonly string[] = ["*"],
    additionalAllowedTools?: readonly string[],
    runId?: string,
  ): readonly {
    readonly id: string;
    readonly description: string;
    readonly inputSchema: JsonValue;
  }[] {
    const policy = runId ? this.#runPolicies.get(runId) : undefined;
    const allowedToolGroups = policy
      ? policy.allowedToolGroups
      : [
          allowedTools,
          ...(additionalAllowedTools ? [additionalAllowedTools] : []),
        ];
    const listed = [...this.#tools.values()].map(({ tool, inputSchema }) => ({
      id: tool.id,
      description: tool.description,
      inputSchema,
    }));
    if (policy) {
      for (const { definition } of policy.dynamicTools.values()) {
        if (definition.modelVisible === false) {
          continue;
        }
        listed.push({
          id: definition.id,
          description: definition.description,
          inputSchema: definition.inputSchema as JsonValue,
        });
      }
    }
    return listed
      .filter(({ id }) => isAllowedByAll(id, allowedToolGroups))
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  has(toolId: string): boolean {
    return this.#tools.has(toolId);
  }

  executionIdForRun(runId: string): ExecutionId | undefined {
    return this.#runPolicies.get(runId)?.executionId;
  }

  describeSecurity(
    toolId: string,
    runId?: string,
  ): ResolvedToolSecurity | undefined {
    const staticTool = this.#tools.get(toolId);
    if (staticTool) {
      return staticTool.security;
    }
    if (runId) {
      return this.#runPolicies.get(runId)?.dynamicTools.get(toolId)?.security;
    }
    return undefined;
  }

  async invoke(
    toolId: string,
    candidateInput: unknown,
    options: ToolInvocationOptions,
  ): Promise<JsonValue> {
    options.signal?.throwIfAborted();
    await options.beforeAuthorization?.();
    const runPolicy = options.runId
      ? this.#runPolicies.get(options.runId)
      : undefined;
    if (
      options.runId &&
      (!runPolicy || runPolicy.ownerPluginId !== options.callerPluginId)
    ) {
      throw new ToolInvocationError(
        "forbidden",
        `Tool policy for run ${options.runId} is unavailable to ${options.callerPluginId}`,
      );
    }
    if (
      runPolicy?.executionId &&
      this.#classification &&
      !runPolicy.classificationRun
    ) {
      throw new ToolInvocationError(
        "forbidden",
        `Tool policy for run ${options.runId} has no execution classification`,
      );
    }
    const resolved = this.#resolveInvocation(toolId, options, runPolicy);
    if (!resolved) {
      throw new ToolInvocationError("unavailable", `Tool ${toolId} is unavailable`);
    }
    const allowedToolGroups = runPolicy?.allowedToolGroups ?? [["*"]];
    if (!isAllowedByAll(toolId, allowedToolGroups)) {
      throw new ToolInvocationError(
        "forbidden",
        `Tool ${toolId} is not allowed for this run`,
      );
    }
    const invocationSignal = AbortSignal.any([
      ...(options.signal ? [options.signal] : []),
      ...resolved.extraSignals,
      ...(runPolicy ? [runPolicy.controller.signal] : []),
    ]);
    invocationSignal.throwIfAborted();

    let jsonInput: JsonValue;
    try {
      jsonInput = resolved.parseInput(candidateInput);
    } catch (error) {
      if (error instanceof ToolInvocationError) {
        throw error;
      }
      throw new ToolInvocationError("invalid", `Tool ${toolId} input is invalid`, {
        cause: error,
      });
    }

    const toolCallId = options.toolCallId ?? randomUUID();
    const preflight = await this.#authorize(
      {
        pluginId: options.callerPluginId,
        feature: "tool",
        title: `Approve ${toolId}`,
        approval: resolved.approval,
        runId: options.runId,
        sessionId: runPolicy?.sessionId,
        toolCallId,
        payloadClassification: resolved.security.inputClassification,
        capacity: resolved.security.channelCapacity,
        interactionUsed: false,
        signal: invocationSignal,
        ...(options.onInteraction
          ? { onInteraction: options.onInteraction.bind(options) }
          : {}),
      },
      toolId,
      options,
      resolved,
      runPolicy,
    );
    if (!preflight.allowed) {
      throw new ToolInvocationError(
        "denied",
        `Tool ${toolId} was denied`,
        { reasons: preflight.reasons },
      );
    }
    invocationSignal.throwIfAborted();
    if (!resolved.isCurrent()) {
      throw new ToolInvocationError(
        "unavailable",
        `Tool ${toolId} is no longer available`,
      );
    }
    let parentExecutionGrant: ParentExecutionGrant | undefined;
    if (runPolicy?.executionId && this.#executions) {
      parentExecutionGrant = await this.#executions.createParentGrant({
        parentExecutionId: runPolicy.executionId,
        granteePluginId: resolved.pluginId,
      });
    }
    await options.beforeCommit?.();
    if (preflight.commitment && !preflight.commitment.recheck()) {
      throw new ToolInvocationError("denied", `Tool ${toolId} was denied`, {
        reasons: [
          `Run ${options.runId ?? "unknown"} classification changed after approval.`,
        ],
      });
    }
    if (!resolved.isCurrent()) {
      throw new ToolInvocationError(
        "unavailable",
        `Tool ${toolId} is no longer available`,
      );
    }

    try {
      const result = await resolved.execute(jsonInput, {
        toolCallId,
        runId: options.runId,
        executionId: runPolicy?.executionId,
        parentExecutionGrant,
        sessionId: runPolicy?.sessionId,
        workspaceRoot: resolved.workspaceAccess
          ? runPolicy?.workspaceRoot
          : undefined,
        signal: invocationSignal,
      });
      if (!resolved.isCurrent()) {
        throw new ToolInvocationError(
          "unavailable",
          `Tool ${toolId} is no longer available`,
        );
      }
      invocationSignal.throwIfAborted();
      const output = resolved.parseOutput(result);
      if (options.runId !== undefined) {
        this.#classification?.raise(
          options.runId,
          resolved.security.outputClassification,
          `tool ${toolId} output`,
        );
      }
      if (runPolicy?.executionId && this.#executions) {
        await this.#executions.observe(
          runPolicy.ownerPluginId,
          runPolicy.executionId,
          {
            classification: resolved.security.outputClassification,
            provenance: {
              kind: "plugin",
              id: `tool:${toolId}`,
            },
            reason: `Tool ${toolId} produced a result`,
          },
        );
      }
      await this.#reviewOutput(
        output,
        toolId,
        toolCallId,
        options,
        resolved,
        runPolicy,
        preflight,
        invocationSignal,
      );
      return output;
    } catch (error) {
      if (error instanceof ToolInvocationError) {
        throw error;
      }
      throw new ToolInvocationError("failed", `Tool ${toolId} failed`, {
        cause: error,
      });
    }
  }

  async #authorize(
    request: AuthorizationRequest,
    toolId: string,
    options: ToolInvocationOptions,
    resolved: ResolvedInvocation,
    runPolicy: RunToolPolicy | undefined,
  ): Promise<AuthorizationResult> {
    try {
      return await this.#authorizer.authorize(request);
    } catch (error) {
      if (!resolved.isCurrent()) {
        const replaced =
          options.runId !== undefined &&
          this.#runPolicies.get(options.runId) !== runPolicy;
        throw new ToolInvocationError(
          replaced ? "forbidden" : "unavailable",
          replaced
            ? `Tool policy for run ${options.runId} is no longer active`
            : `Tool ${toolId} is no longer available`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  /**
   * External tool output is untrusted text entering the model, so it is scanned
   * after it parses. The result may only prompt when the preflight did not.
   */
  async #reviewOutput(
    output: JsonValue,
    toolId: string,
    toolCallId: string,
    options: ToolInvocationOptions,
    resolved: ResolvedInvocation,
    runPolicy: RunToolPolicy | undefined,
    preflight: AuthorizationResult,
    signal: AbortSignal,
  ): Promise<void> {
    if (resolved.security.outputProvenance !== "external" || !this.#scanners) {
      return;
    }
    const report = await this.#scanners.scan({
      stage: "tool_result",
      text: JSON.stringify(output),
      source: { kind: "tool", id: toolId },
      runId: options.runId,
      sessionId: runPolicy?.sessionId,
      signal,
    });
    const verdict = await this.#authorize(
      {
        pluginId: options.callerPluginId,
        feature: "tool",
        title: `Review ${toolId} result`,
        approval: "auto",
        runId: options.runId,
        sessionId: runPolicy?.sessionId,
        toolCallId,
        scanReport: report,
        interactionUsed: preflight.interactionUsed,
        signal,
        ...(options.onInteraction
          ? { onInteraction: options.onInteraction.bind(options) }
          : {}),
      },
      toolId,
      options,
      resolved,
      runPolicy,
    );
    if (!verdict.allowed) {
      throw new ToolInvocationError(
        "denied",
        `Tool ${toolId} result was denied`,
        { reasons: verdict.reasons },
      );
    }
  }

  #resolveInvocation(
    toolId: string,
    options: ToolInvocationOptions,
    runPolicy: RunToolPolicy | undefined,
  ): ResolvedInvocation | undefined {
    const registration = this.#tools.get(toolId);
    if (registration) {
      return {
        toolId,
        pluginId: registration.pluginId,
        approval: registration.tool.approval,
        security: registration.security,
        workspaceAccess: registration.workspaceAccess,
        extraSignals: [registration.controller.signal],
        parseInput: (candidate) => {
          const parsedInput = registration.tool.input.safeParse(candidate);
          if (!parsedInput.success) {
            throw new ToolInvocationError(
              "invalid",
              `Tool ${toolId} input is invalid`,
              { cause: parsedInput.error },
            );
          }
          return asJsonValue(parsedInput.data);
        },
        parseOutput: (result) => {
          const parsedOutput = registration.tool.output.safeParse(result);
          if (!parsedOutput.success) {
            throw new ToolInvocationError(
              "invalid",
              `Tool ${toolId} output is invalid`,
              { cause: parsedOutput.error },
            );
          }
          return asJsonValue(parsedOutput.data);
        },
        execute: (input, context) => registration.tool.execute(input, context),
        isCurrent: () =>
          this.#tools.get(toolId) === registration &&
          (!options.runId || this.#runPolicies.get(options.runId) === runPolicy),
      };
    }

    if (!options.runId || !runPolicy) {
      return undefined;
    }
    const binding = runPolicy.dynamicTools.get(toolId);
    if (!binding) {
      return undefined;
    }
    return {
      toolId,
      pluginId: binding.pluginId,
      approval: binding.definition.approval,
      security: binding.security,
      workspaceAccess: binding.workspaceAccess,
      extraSignals: [binding.controller.signal],
      parseInput: (candidate) => {
        const parsed = validateAgainstJsonSchema(
          binding.definition.inputSchema,
          candidate,
        );
        if (!parsed.success) {
          throw new ToolInvocationError(
            "invalid",
            `Tool ${toolId} input is invalid`,
            { cause: parsed.error },
          );
        }
        return asJsonValue(parsed.data);
      },
      parseOutput: (result) => {
        if (binding.definition.outputSchema === undefined) {
          return asJsonValue(result);
        }
        const parsed = validateAgainstJsonSchema(
          binding.definition.outputSchema,
          result,
        );
        if (!parsed.success) {
          throw new ToolInvocationError(
            "invalid",
            `Tool ${toolId} output is invalid`,
            { cause: parsed.error },
          );
        }
        return asJsonValue(parsed.data);
      },
      execute: (input, context) =>
        binding.catalog.execute(toolId, input, context),
      isCurrent: () =>
        this.#runPolicies.get(options.runId!) === runPolicy &&
        runPolicy.dynamicTools.get(toolId) === binding,
    };
  }

  async #preparePolicy(runId: string, policy: RunToolPolicy): Promise<void> {
    const signal = policy.controller.signal;
    signal.throwIfAborted();
    const providers = [...this.#providers.values()];
    for (const registration of providers) {
      if (this.#runPolicies.get(runId) !== policy) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new Error(`Tool policy for run ${runId} was released`);
      }
      signal.throwIfAborted();
      const prepare = providerPrepare(registration.provider);
      if (!prepare) {
        continue;
      }
      const providerSignal = AbortSignal.any([
        signal,
        registration.controller.signal,
      ]);
      const scope: ToolProviderScope = {
        runId,
        ownerPluginId: policy.ownerPluginId,
        signal: providerSignal,
        ...(policy.persona ? { persona: policy.persona } : {}),
        ...(policy.personaId ? { personaId: policy.personaId } : {}),
        ...(policy.sessionId ? { sessionId: policy.sessionId } : {}),
        ...(registration.workspaceAccess && policy.workspaceRoot
          ? { workspaceRoot: policy.workspaceRoot }
          : {}),
      };
      try {
        const catalog = await prepare(scope);
        if (this.#runPolicies.get(runId) !== policy || signal.aborted) {
          this.#closeLease(catalog);
          signal.throwIfAborted();
          throw new Error(`Tool policy for run ${runId} was released`);
        }
        if (registration.controller.signal.aborted) {
          this.#closeLease(catalog);
          continue;
        }
        this.#acceptCatalog(policy, registration, catalog);
        policy.catalogs.push({
          catalog,
          pluginId: registration.pluginId,
          providerId: registration.provider.id,
          controller: registration.controller,
        });
      } catch (error) {
        if (signal.aborted || this.#runPolicies.get(runId) !== policy) {
          throw signal.reason instanceof Error
            ? signal.reason
            : error instanceof Error
              ? error
              : new Error(`Tool catalog preparation for run ${runId} was cancelled`);
        }
        if (registration.controller.signal.aborted) {
          continue;
        }
        console.error(
          `[kernel] tool provider ${registration.provider.id} failed to prepare`,
          error,
        );
      }
    }
    if (this.#runPolicies.get(runId) !== policy) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new Error(`Tool policy for run ${runId} was released`);
    }
    signal.throwIfAborted();
    policy.prepared = true;
  }

  #acceptCatalog(
    policy: RunToolPolicy,
    registration: RegisteredProvider,
    catalog: PreparedToolCatalog,
  ): void {
    const definitions = Array.isArray(catalog.definitions)
      ? catalog.definitions
      : [];
    if (typeof catalog.execute !== "function") {
      this.#closeLease(catalog);
      throw new Error(
        `Tool catalog from ${registration.provider.id} is invalid`,
      );
    }
    for (const candidate of definitions) {
      try {
        if (
          !candidate ||
          !DYNAMIC_TOOL_ID.test(candidate.id) ||
          candidate.id.length > 512 ||
          typeof candidate.description !== "string" ||
          candidate.description.trim().length === 0 ||
          candidate.description.length > 10_000 ||
          !["auto", "ask", "deny"].includes(candidate.approval) ||
          typeof candidate.sideEffect !== "boolean" ||
          (candidate.modelVisible !== undefined &&
            typeof candidate.modelVisible !== "boolean")
        ) {
          throw new Error(`Invalid dynamic tool ${String(candidate?.id)}`);
        }
        assertBoundedJsonSchema(candidate.inputSchema);
        if (candidate.outputSchema !== undefined) {
          assertBoundedJsonSchema(candidate.outputSchema);
        }
        if (this.#tools.has(candidate.id)) {
          throw new Error(
            `Dynamic tool ${candidate.id} collides with a static tool`,
          );
        }
        if (policy.dynamicTools.has(candidate.id)) {
          throw new Error(`Dynamic tool ${candidate.id} is already prepared`);
        }
        const namespace = registration.provider.namespace;
        if (
          namespace !== undefined &&
          !candidate.id.startsWith(`${namespace}.`)
        ) {
          throw new Error(
            `Dynamic tool ${candidate.id} is outside namespace ${namespace}`,
          );
        }
        // A provider catalog is remote content by default, so its output is
        // external unless the provider says otherwise.
        const security = resolveToolSecurity(
          candidate.id,
          candidate.security,
          "external",
        );
        const definition = freezeDefinition(candidate, security);
        policy.dynamicTools.set(definition.id, {
          definition,
          catalog,
          pluginId: registration.pluginId,
          providerId: registration.provider.id,
          security,
          workspaceAccess: registration.workspaceAccess,
          controller: registration.controller,
        });
      } catch (error) {
        console.error(
          `[kernel] dynamic tool from ${registration.provider.id} was rejected`,
          error,
        );
      }
    }
  }

  #removeProvider(registration: RegisteredProvider): void {
    if (this.#providers.get(registration.provider.id) !== registration) {
      return;
    }
    this.#providers.delete(registration.provider.id);
    registration.controller.abort(
      new Error(`Tool provider ${registration.provider.id} was unregistered`),
    );
    for (const policy of this.#runPolicies.values()) {
      for (const [toolId, binding] of policy.dynamicTools) {
        if (binding.providerId === registration.provider.id) {
          policy.dynamicTools.delete(toolId);
        }
      }
      const remaining: CatalogLease[] = [];
      for (const lease of policy.catalogs) {
        if (lease.providerId === registration.provider.id) {
          this.#closeLease(lease.catalog);
        } else {
          remaining.push(lease);
        }
      }
      policy.catalogs.splice(0, policy.catalogs.length, ...remaining);
    }
  }

  #disposePolicy(runId: string, policy: RunToolPolicy): void {
    this.#runPolicies.delete(runId);
    policy.controller.abort(
      new Error(`Tool policy for run ${runId} was released`),
    );
    for (const lease of policy.catalogs) {
      this.#closeLease(lease.catalog);
    }
    policy.catalogs.length = 0;
    policy.dynamicTools.clear();
    void policy.classificationRun?.dispose();
  }

  #closeLease(catalog: PreparedToolCatalog): void {
    if (this.#closedCatalogs.has(catalog)) {
      return;
    }
    this.#closedCatalogs.add(catalog);
    closeCatalog(catalog);
  }
}
