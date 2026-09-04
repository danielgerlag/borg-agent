import {
  mcpAppDiscovered,
  mcpServerConfigSchema,
  type McpServerConfig,
  type McpServerSnapshot,
  type Persona,
} from "@borg/contracts";
import type {
  DynamicToolDefinition,
  JsonValue,
  PluginContext,
  PluginLogger,
  PreparedToolCatalog,
  ToolExecutionContext,
  ToolProviderScope,
} from "@borg/plugin-sdk";
import { createAppInstanceId, validateAppResource } from "./apps";
import { McpClient, clientName, type McpResourceContents } from "./client";
import {
  allocatePersonaServerSlugs,
  canonicalizeTools,
  modelVisibleToolIds,
  type CanonicalMcpTool,
  type McpToolDescriptor,
} from "./ids";
import { INTERNAL_ERROR, McpProtocolError, type McpTransport } from "./protocol";
import { assertNoSecrets, safeErrorMessage } from "./redact";
import { resolveServerSecrets, type ResolvedSecrets } from "./secrets";
import { LegacySseTransport } from "./sse";
import { StdioTransport } from "./stdio";
import { StreamableHttpTransport } from "./streamable-http";

export const DEFAULT_PREPARE_TIMEOUT_MS = 15_000;

export interface McpSession {
  initialize(signal?: AbortSignal): Promise<unknown>;
  listTools(signal?: AbortSignal): Promise<readonly McpToolDescriptor[]>;
  callTool(name: string, args: unknown, signal?: AbortSignal): Promise<unknown>;
  readResource(
    uri: string,
    signal?: AbortSignal,
  ): Promise<readonly McpResourceContents[]>;
  close(): Promise<void>;
}

export interface LiveConnection {
  readonly client: McpSession;
  readonly secrets: readonly string[];
  readonly config: McpServerConfig;
}

export type OpenMcpConnection = (
  context: PluginContext,
  config: McpServerConfig,
  signal: AbortSignal,
) => Promise<LiveConnection>;

export interface McpCatalogManagerOptions {
  readonly prepareTimeoutMs?: number | undefined;
  readonly openConnection?: OpenMcpConnection | undefined;
}

export interface ServerRuntimeState {
  readonly config: McpServerConfig;
  status: McpServerSnapshot["status"];
  toolCount: number;
  error?: string | undefined;
  tools: readonly CanonicalMcpTool[];
}

export class McpCatalogManager {
  readonly #context: PluginContext;
  readonly #status = new Map<string, ServerRuntimeState>();
  readonly #leases = new Set<McpPreparedCatalog>();
  readonly #prepareTimeoutMs: number;
  readonly #openConnection: OpenMcpConnection;

  constructor(context: PluginContext, options: McpCatalogManagerOptions = {}) {
    this.#context = context;
    const prepareTimeoutMs =
      options.prepareTimeoutMs ?? DEFAULT_PREPARE_TIMEOUT_MS;
    if (!Number.isSafeInteger(prepareTimeoutMs) || prepareTimeoutMs < 1) {
      throw new Error("MCP prepare timeout is invalid");
    }
    this.#prepareTimeoutMs = prepareTimeoutMs;
    this.#openConnection = options.openConnection ?? openConnection;
  }

  snapshots(personaId?: string): McpServerSnapshot[] {
    const persona = this.#persona(personaId);
    if (!persona) {
      return [];
    }
    return persona.mcpServers.map((config) => {
      const current = this.#status.get(statusKey(persona.id, config.id));
      return toSnapshot(config.id, current);
    });
  }

  snapshot(serverId: string, personaId?: string): McpServerSnapshot {
    const match = this.snapshots(personaId).find((entry) => entry.id === serverId);
    if (!match) {
      return {
        id: serverId,
        status: "idle",
        toolCount: 0,
        toolIds: [],
        error: "Unknown MCP server",
      };
    }
    return match;
  }

  async refresh(
    serverId?: string,
    personaId?: string,
    signal?: AbortSignal,
  ): Promise<McpServerSnapshot[]> {
    const persona = this.#persona(personaId);
    if (!persona) {
      return [];
    }
    const targets = persona.mcpServers.filter(
      (config) => config.enabled && (serverId === undefined || config.id === serverId),
    );
    const slugs = allocatePersonaServerSlugs(
      persona.mcpServers.map((config) => config.id),
    );
    const abort = signal ?? this.#context.signal;
    await Promise.all(
      targets.map((config) => this.#probe(persona.id, config, slugs, abort)),
    );
    return this.snapshots(persona.id);
  }

  async prepare(scope: ToolProviderScope): Promise<PreparedToolCatalog> {
    const persona =
      scope.persona ??
      (scope.personaId ? this.#context.personas.get(scope.personaId) : undefined);
    const catalog = new McpPreparedCatalog(
      this.#context,
      scope,
      persona,
      this.#prepareTimeoutMs,
      this.#openConnection,
    );
    this.#leases.add(catalog);
    await catalog.connect();
    for (const snapshot of catalog.snapshots()) {
      this.#status.set(statusKey(catalog.personaId, snapshot.config.id), {
        config: snapshot.config,
        status: snapshot.status,
        toolCount: snapshot.toolCount,
        tools: snapshot.tools,
        ...(snapshot.error ? { error: snapshot.error } : {}),
      });
    }
    return {
      definitions: catalog.definitions(),
      execute: (toolId, input, context) => catalog.execute(toolId, input, context),
      close: async () => {
        this.#leases.delete(catalog);
        await catalog.close();
      },
    };
  }

  async close(): Promise<void> {
    await Promise.allSettled(
      [...this.#leases].map((catalog) => catalog.close()),
    );
    this.#leases.clear();
  }

  #persona(personaId?: string): Persona | undefined {
    if (personaId) {
      return this.#context.personas.get(personaId);
    }
    return this.#context.personas.getDefault();
  }

  async #probe(
    personaId: string,
    config: McpServerConfig,
    slugs: ReadonlyMap<string, string>,
    signal: AbortSignal,
  ): Promise<void> {
    const key = statusKey(personaId, config.id);
    this.#status.set(key, {
      config,
      status: "connecting",
      toolCount: 0,
      tools: [],
    });
    let connection: LiveConnection | undefined;
    try {
      const discovered = await withPrepareDeadline(
        this.#prepareTimeoutMs,
        signal,
        async (deadline) => {
          const opened = await this.#openConnection(this.#context, config, deadline);
          connection = opened;
          return discoverTools(opened, slugs.get(config.id), deadline);
        },
      );
      connection = discovered.connection;
      const snapshot: ServerRuntimeState = {
        config,
        status: "ready",
        toolCount: discovered.tools.filter((tool) => tool.modelVisible).length,
        tools: discovered.tools,
      };
      assertNoSecrets(snapshot, connection.secrets);
      this.#status.set(key, snapshot);
    } catch (error) {
      this.#status.set(key, {
        config,
        status: "failed",
        toolCount: 0,
        tools: [],
        error: safeErrorMessage(error, connection?.secrets ?? []),
      });
    } finally {
      await connection?.client.close().catch(() => undefined);
    }
  }
}

class McpPreparedCatalog {
  readonly #context: PluginContext;
  readonly #scope: ToolProviderScope;
  readonly #persona: Persona | undefined;
  readonly #prepareTimeoutMs: number;
  readonly #openConnection: OpenMcpConnection;
  readonly #serverSlugs: ReadonlyMap<string, string>;
  readonly #connections = new Map<string, LiveConnection>();
  readonly #opening = new Map<string, Promise<LiveConnection>>();
  readonly #tools = new Map<string, CanonicalMcpTool>();
  readonly #states = new Map<string, ServerRuntimeState>();
  #closed = false;

  constructor(
    context: PluginContext,
    scope: ToolProviderScope,
    persona: Persona | undefined,
    prepareTimeoutMs: number,
    openConnectionImpl: OpenMcpConnection,
  ) {
    this.#context = context;
    this.#scope = scope;
    this.#persona = persona;
    this.#prepareTimeoutMs = prepareTimeoutMs;
    this.#openConnection = openConnectionImpl;
    this.#serverSlugs = allocatePersonaServerSlugs(
      (persona?.mcpServers ?? []).map((config) => config.id),
    );
  }

  get personaId(): string {
    return this.#persona?.id ?? "system/general";
  }

  snapshots(): readonly (ServerRuntimeState & { readonly config: McpServerConfig })[] {
    return [...this.#states.values()];
  }

  definitions(): readonly DynamicToolDefinition[] {
    return [...this.#tools.values()]
      .map((tool) => {
        const config = this.#persona?.mcpServers.find(
          (entry) => entry.id === tool.serverId,
        );
        return {
          id: tool.id,
          description: tool.description,
          inputSchema: tool.inputSchema,
          approval: tool.approval,
          sideEffect: tool.sideEffect,
          modelVisible: tool.modelVisible,
          security: {
            outputProvenance: "external" as const,
            outputClassification: "internal" as const,
            ...(config ? { channelCapacity: config.channelClass } : {}),
          },
        };
      });
  }

  async connect(): Promise<void> {
    const servers = (this.#persona?.mcpServers ?? []).filter(
      (config) => config.enabled,
    );
    await Promise.all(
      servers.map((config) =>
        this.#ensure(config, this.#scope.signal).catch(() => undefined),
      ),
    );
  }

  async execute(
    toolId: string,
    input: JsonValue,
    context: ToolExecutionContext,
  ): Promise<JsonValue> {
    const tool = this.#tools.get(toolId);
    if (!tool) {
      throw new Error(`MCP tool ${toolId} is unavailable`);
    }
    const config = mcpServerConfigSchema.parse(
      this.#persona?.mcpServers.find((entry) => entry.id === tool.serverId),
    );
    const startedAt = new Date().toISOString();
    const signal = AbortSignal.any([context.signal, this.#scope.signal]);
    const result = await this.#call(config, tool, input, signal);
    assertNoSecrets(
      result,
      this.#connections.get(tool.serverId)?.secrets ?? [],
    );
    await this.#discoverApp(tool, input, result, context, startedAt);
    return asJsonValue(result);
  }

  async close(): Promise<void> {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    await Promise.allSettled(this.#opening.values());
    this.#opening.clear();
    await Promise.allSettled(
      [...this.#connections.values()].map((connection) => connection.client.close()),
    );
    this.#connections.clear();
  }

  async #call(
    config: McpServerConfig,
    tool: CanonicalMcpTool,
    input: JsonValue,
    signal: AbortSignal,
  ): Promise<unknown> {
    let connection: LiveConnection | undefined;
    try {
      connection = await this.#ensure(config, signal);
      return await connection.client.callTool(tool.mcpName, input, signal);
    } catch (error) {
      const safeError = sanitizeConnectionError(
        error,
        connection?.secrets ?? [],
      );
      if (!config.reconnect || !isTransportFailure(safeError)) {
        throw safeError;
      }
      await this.#drop(config.id);
      if (tool.sideEffect) {
        throw safeError;
      }
      connection = await this.#ensure(config, signal);
      const refreshed = this.#tools.get(tool.id);
      if (!refreshed || refreshed.serverId !== config.id) {
        throw new Error(`MCP tool ${tool.id} is unavailable after reconnect`);
      }
      try {
        return await connection.client.callTool(
          refreshed.mcpName,
          input,
          signal,
        );
      } catch (retryError) {
        throw sanitizeConnectionError(retryError, connection.secrets);
      }
    }
  }

  async #discoverApp(
    tool: CanonicalMcpTool,
    input: JsonValue,
    result: unknown,
    context: ToolExecutionContext,
    startedAt: string,
  ): Promise<void> {
    if (!tool.resourceUri || !context.sessionId) {
      return;
    }
    const connection = this.#connections.get(tool.serverId);
    if (!connection) {
      return;
    }
    try {
      const contents = await connection.client.readResource(
        tool.resourceUri,
        context.signal,
      );
      const app = validateAppResource(tool.resourceUri, contents);
      const completedAt = new Date().toISOString();
      const payload = mcpAppDiscovered.payload.parse({
        sessionId: context.sessionId,
        personaId: this.personaId,
        appInstanceId: createAppInstanceId({
          sessionId: context.sessionId,
          serverId: tool.serverId,
          resourceUri: tool.resourceUri,
          toolCallId: context.toolCallId,
        }),
        serverId: tool.serverId,
        resourceUri: tool.resourceUri,
        html: app.html,
        csp: app.csp,
        permissions: app.permissions,
        tools: [...this.#tools.values()]
          .filter(
            (candidate) =>
              candidate.serverId === tool.serverId && candidate.appVisible,
          )
          .map((candidate) => ({
            name: candidate.mcpName,
            toolId: candidate.id,
            description: candidate.description,
            inputSchema: asJsonValue(candidate.inputSchema),
          })),
        sourceToolId: tool.id,
        sourceToolName: tool.mcpName,
        toolInput: input,
        callResult: asJsonValue(result),
        startedAt,
        completedAt,
        discoveredAt: completedAt,
      });
      assertNoSecrets(payload, connection.secrets);
      await this.#context.bus.emit(mcpAppDiscovered, payload);
    } catch (error) {
      this.#logger.warn("MCP app resource was not published", {
        reason: safeErrorMessage(error, connection.secrets),
      });
    }
  }

  #ensure(config: McpServerConfig, signal: AbortSignal): Promise<LiveConnection> {
    if (this.#closed) {
      return Promise.reject(new Error("MCP catalog is closed"));
    }
    const existing = this.#connections.get(config.id);
    if (existing) {
      return Promise.resolve(existing);
    }
    const opening = this.#opening.get(config.id);
    if (opening) {
      return waitForSignal(opening, signal);
    }
    const pending = this.#open(config, this.#scope.signal);
    this.#opening.set(config.id, pending);
    void pending.finally(() => {
      if (this.#opening.get(config.id) === pending) {
        this.#opening.delete(config.id);
      }
    }).catch(() => undefined);
    return waitForSignal(pending, signal);
  }

  async #open(
    config: McpServerConfig,
    signal: AbortSignal,
  ): Promise<LiveConnection> {
    this.#states.set(config.id, {
      config,
      status: "connecting",
      toolCount: 0,
      tools: [],
    });
    let secrets: readonly string[] = [];
    let connection: LiveConnection | undefined;
    let discoveryCompleted = false;
    try {
      const discovered = await withPrepareDeadline(
        this.#prepareTimeoutMs,
        signal,
        async (deadline) => {
          const opened = await this.#openConnection(this.#context, config, deadline);
          connection = opened;
          secrets = opened.secrets;
          const result = await discoverTools(
            opened,
            this.#serverSlugs.get(config.id),
            deadline,
          );
          discoveryCompleted = true;
          return result;
        },
      );
      if (this.#closed) {
        throw new Error("MCP catalog is closed");
      }
      assertNoSecrets(discovered.tools, discovered.connection.secrets);
      this.#removeServerTools(config.id);
      for (const tool of discovered.tools) {
        this.#tools.set(tool.id, tool);
      }
      this.#connections.set(config.id, discovered.connection);
      this.#states.set(config.id, {
        config,
        status: "ready",
        toolCount: discovered.tools.filter((tool) => tool.modelVisible).length,
        tools: discovered.tools,
      });
      connection = undefined;
      return discovered.connection;
    } catch (error) {
      if (discoveryCompleted) {
        await connection?.client.close().catch(() => undefined);
      }
      this.#states.set(config.id, {
        config,
        status: "failed",
        toolCount: 0,
        tools: [],
        error: safeErrorMessage(error, secrets),
      });
      throw error;
    }
  }

  async #drop(serverId: string): Promise<void> {
    const connection = this.#connections.get(serverId);
    this.#connections.delete(serverId);
    this.#removeServerTools(serverId);
    await connection?.client.close().catch(() => undefined);
  }

  #removeServerTools(serverId: string): void {
    for (const [toolId, tool] of this.#tools) {
      if (tool.serverId === serverId) {
        this.#tools.delete(toolId);
      }
    }
  }

  get #logger(): PluginLogger {
    return this.#context.logger;
  }
}

export async function openConnection(
  context: PluginContext,
  config: McpServerConfig,
  signal: AbortSignal,
): Promise<LiveConnection> {
  const resolved = await resolveServerSecrets(context.secrets, config);
  const transport = await openTransport(context, config, resolved, signal);
  const client = new McpClient({
    transport,
    clientInfo: {
      name: clientName(),
      version: context.host.version,
    },
    ...(config.transport === "stdio"
      ? {
          reopen: () => openTransport(context, config, resolved, signal),
        }
      : {}),
  });
  return { client, secrets: resolved.values, config };
}

async function openTransport(
  context: PluginContext,
  config: McpServerConfig,
  resolved: ResolvedSecrets,
  signal: AbortSignal,
): Promise<McpTransport> {
  if (config.transport === "stdio") {
    return StdioTransport.open({
      process: context.process,
      command: config.command,
      args: config.arguments,
      env: resolved.env,
      signal,
      secrets: resolved.values,
      onDiagnostic: (message) => {
        context.logger.warn("MCP stdio diagnostic", { message });
      },
    });
  }
  if (config.transport === "sse") {
    return LegacySseTransport.open({
      http: context.http,
      url: config.url,
      headers: resolved.headers,
      signal,
    });
  }
  return new StreamableHttpTransport({
    http: context.http,
    url: config.url,
    headers: resolved.headers,
    signal,
  });
}

async function discoverTools(
  connection: LiveConnection,
  serverSlug: string | undefined,
  deadline: AbortSignal,
): Promise<{ connection: LiveConnection; tools: readonly CanonicalMcpTool[] }> {
  const close = (): void => {
    void connection.client.close().catch(() => undefined);
  };
  if (deadline.aborted) {
    close();
    throw new McpProtocolError(INTERNAL_ERROR, "MCP server prepare timed out");
  }
  deadline.addEventListener("abort", close, { once: true });
  try {
    await connection.client.initialize(deadline);
    const tools = canonicalizeTools(
      connection.config.id,
      await connection.client.listTools(deadline),
      serverSlug,
    );
    if (deadline.aborted) {
      throw new McpProtocolError(INTERNAL_ERROR, "MCP server prepare timed out");
    }
    return { connection, tools };
  } catch (error) {
    await connection.client.close().catch(() => undefined);
    throw error;
  } finally {
    deadline.removeEventListener("abort", close);
  }
}

async function withPrepareDeadline<T>(
  timeoutMs: number,
  signal: AbortSignal,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const combined = AbortSignal.any([signal, timeout]);
  let rejectDeadline: (() => void) | undefined;
  const deadline = new Promise<never>((_, reject) => {
    rejectDeadline = (): void => {
      reject(
        signal.aborted
          ? abortReason(signal)
          : new McpProtocolError(
              INTERNAL_ERROR,
              "MCP server prepare timed out",
            ),
      );
    };
    if (combined.aborted) {
      rejectDeadline();
      return;
    }
    combined.addEventListener("abort", rejectDeadline, { once: true });
  });
  const running = work(combined);
  void running.catch(() => undefined);
  try {
    return await Promise.race([running, deadline]);
  } finally {
    if (rejectDeadline) {
      combined.removeEventListener("abort", rejectDeadline);
    }
  }
}

function waitForSignal<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(abortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => reject(abortReason(signal));
    signal.addEventListener("abort", abort, { once: true });
    void operation.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", abort);
    });
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new McpProtocolError(INTERNAL_ERROR, "MCP request was aborted");
}

function statusKey(personaId: string, serverId: string): string {
  return `${personaId}\0${serverId}`;
}

function toSnapshot(
  serverId: string,
  current: ServerRuntimeState | undefined,
): McpServerSnapshot {
  return {
    id: serverId,
    status: current?.status ?? "idle",
    toolCount: current?.toolCount ?? 0,
    toolIds: [...modelVisibleToolIds(current?.tools ?? [])],
    ...(current?.error ? { error: current.error } : {}),
  };
}

function isTransportFailure(error: unknown): boolean {
  return (
    error instanceof McpProtocolError &&
    /closed|aborted|failed|unavailable/i.test(error.message)
  );
}

function sanitizeConnectionError(
  error: unknown,
  secrets: readonly string[],
): Error {
  const message = safeErrorMessage(error, secrets);
  return error instanceof McpProtocolError
    ? new McpProtocolError(error.code, message)
    : new Error(message);
}

function asJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
