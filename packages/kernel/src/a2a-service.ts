import {
  a2aConfigSchema,
  modelOperationPrefixSchema,
  type A2AConfig,
  type LoopRunSnapshot,
  type LoopRunStatus,
} from "@borg/contracts";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { LoopManager } from "./loop-manager";
import type { PersonaService } from "./persona-service";
import type { WorkspaceService } from "./workspace-service";

export const A2A_OWNER_PLUGIN_ID = "borg.a2a";
export const A2A_PROTOCOL_VERSION = "1.0";

const JSON_RPC_PARSE_ERROR = -32_700;
const JSON_RPC_INVALID_REQUEST = -32_600;
const JSON_RPC_METHOD_NOT_FOUND = -32_601;
const JSON_RPC_INVALID_PARAMS = -32_602;
const JSON_RPC_INTERNAL_ERROR = -32_603;
const A2A_TASK_NOT_FOUND = -32_001;
const A2A_TASK_NOT_CANCELABLE = -32_002;
const MAX_BODY_BYTES = 1_048_576;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type JsonRpcId = string | number | null;

export interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly method: string;
  readonly params?: unknown;
  readonly id?: JsonRpcId;
}

export interface JsonRpcError {
  readonly code: number;
  readonly message: string;
}

export type JsonRpcResponse =
  | {
      readonly jsonrpc: "2.0";
      readonly id: JsonRpcId;
      readonly result: unknown;
    }
  | {
      readonly jsonrpc: "2.0";
      readonly id: JsonRpcId;
      readonly error: JsonRpcError;
    };

export type A2ATaskState =
  | "working"
  | "input-required"
  | "completed"
  | "failed"
  | "canceled";

export interface A2ATask {
  readonly id: string;
  readonly contextId: string;
  readonly kind: "task";
  readonly status: {
    readonly state: A2ATaskState;
    readonly timestamp: string;
    readonly message?: {
      readonly role: "agent";
      readonly messageId: string;
      readonly parts: readonly {
        readonly kind: "text";
        readonly text: string;
      }[];
    };
  };
}

export type A2ACreateServer = typeof createServer;

export interface A2AServiceOptions {
  readonly loops: LoopManager;
  readonly personas?: PersonaService | undefined;
  readonly workspaces?: WorkspaceService | undefined;
  readonly createServer?: A2ACreateServer | undefined;
  readonly hostVersion?: string | undefined;
}

export interface A2AListenAddress {
  readonly host: string;
  readonly port: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function jsonRpcId(value: unknown): JsonRpcId {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === "string" || typeof value === "number") {
    return value;
  }
  return null;
}

function mapLoopStatus(status: LoopRunStatus): A2ATaskState {
  switch (status) {
    case "running":
    case "paused":
      return "working";
    case "waiting":
      return "input-required";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
      return "canceled";
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

function taskFromSnapshot(snapshot: LoopRunSnapshot): A2ATask {
  const state = mapLoopStatus(snapshot.status);
  const text =
    state === "completed"
      ? snapshot.output
      : state === "failed" || state === "canceled"
        ? snapshot.error
        : undefined;
  return {
    id: snapshot.id,
    contextId: snapshot.sessionId ?? snapshot.id,
    kind: "task",
    status: {
      state,
      timestamp: snapshot.updatedAt,
      ...(text !== undefined && text.length > 0
        ? {
            message: {
              role: "agent" as const,
              messageId: snapshot.id,
              parts: [{ kind: "text" as const, text }],
            },
          }
        : {}),
    },
  };
}

function extractText(message: Record<string, unknown>): string | undefined {
  const parts = message.parts;
  if (!Array.isArray(parts)) {
    return undefined;
  }
  const texts: string[] = [];
  for (const part of parts) {
    if (!isRecord(part) || typeof part.text !== "string") {
      continue;
    }
    if (part.text.trim().length > 0) {
      texts.push(part.text);
    }
  }
  const combined = texts.join("\n").trim();
  return combined.length > 0 ? combined : undefined;
}

function taskIdFromParams(params: unknown): string | undefined {
  if (!isRecord(params)) {
    return undefined;
  }
  if (isUuid(params.id)) {
    return params.id;
  }
  if (isUuid(params.taskId)) {
    return params.taskId;
  }
  return undefined;
}

export class A2AService {
  readonly #loops: LoopManager;
  readonly #personas: PersonaService | undefined;
  readonly #workspaces: WorkspaceService | undefined;
  readonly #createServer: A2ACreateServer;
  readonly #hostVersion: string;
  #config: A2AConfig = a2aConfigSchema.parse({});
  #server: Server | undefined;
  #listenQueue: Promise<void> = Promise.resolve();

  constructor(options: A2AServiceOptions) {
    this.#loops = options.loops;
    this.#personas = options.personas;
    this.#workspaces = options.workspaces;
    this.#createServer = options.createServer ?? createServer;
    this.#hostVersion = options.hostVersion ?? "0.1.0";
  }

  get config(): A2AConfig {
    return this.#config;
  }

  address(): A2AListenAddress | undefined {
    const address = this.#server?.address();
    if (!address || typeof address === "string") {
      return undefined;
    }
    return {
      host: address.address,
      port: address.port,
    };
  }

  listening(): boolean {
    return this.#server?.listening === true;
  }

  async applyConfig(candidate: unknown): Promise<void> {
    const config = a2aConfigSchema.parse(candidate ?? {});
    this.#config = config;
    const run = this.#listenQueue.then(async () => {
      if (!config.enabled) {
        await this.#closeNow();
        return;
      }
      await this.#listenNow(config.port);
    });
    this.#listenQueue = run.catch(() => undefined);
    await run;
  }

  async listen(port: number): Promise<void> {
    const run = this.#listenQueue.then(() => this.#listenNow(port));
    this.#listenQueue = run.catch(() => undefined);
    await run;
  }

  async close(): Promise<void> {
    const run = this.#listenQueue.then(() => this.#closeNow());
    this.#listenQueue = run.catch(() => undefined);
    await run;
  }

  async dispatch(request: JsonRpcRequest): Promise<JsonRpcResponse> {
    const id = jsonRpcId(request.id);
    if (request.jsonrpc !== "2.0" || request.method.trim().length === 0) {
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: JSON_RPC_INVALID_REQUEST,
          message: "Invalid JSON-RPC request",
        },
      };
    }
    try {
      switch (request.method) {
        case "message/send":
        case "SendMessage":
          return {
            jsonrpc: "2.0",
            id,
            result: await this.#sendMessage(request.params),
          };
        case "tasks/get":
        case "GetTask":
          return {
            jsonrpc: "2.0",
            id,
            result: this.#getTask(request.params),
          };
        case "tasks/cancel":
        case "CancelTask":
          return {
            jsonrpc: "2.0",
            id,
            result: this.#cancelTask(request.params),
          };
        default:
          return {
            jsonrpc: "2.0",
            id,
            error: {
              code: JSON_RPC_METHOD_NOT_FOUND,
              message: `Method ${request.method} is not supported`,
            },
          };
      }
    } catch (error) {
      if (error instanceof A2ARpcError) {
        return {
          jsonrpc: "2.0",
          id,
          error: { code: error.code, message: error.message },
        };
      }
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: JSON_RPC_INTERNAL_ERROR,
          message: error instanceof Error ? error.message : "A2A request failed",
        },
      };
    }
  }

  agentCard(port = this.address()?.port ?? this.#config.port): Record<string, unknown> {
    const url = `http://127.0.0.1:${port}/`;
    const persona = this.#resolvePersona();
    return {
      protocolVersion: A2A_PROTOCOL_VERSION,
      name: persona?.name ?? "Borg",
      description:
        persona?.description ??
        "Local Borg agent exposed over Agent2Agent JSON-RPC.",
      url,
      version: this.#hostVersion,
      capabilities: {
        streaming: false,
        pushNotifications: false,
      },
      defaultInputModes: ["text/plain"],
      defaultOutputModes: ["text/plain"],
      skills: [],
      supportedInterfaces: [
        {
          protocolBinding: "JSONRPC",
          url,
          protocolVersion: A2A_PROTOCOL_VERSION,
        },
      ],
    };
  }

  async #sendMessage(params: unknown): Promise<A2ATask> {
    if (!isRecord(params) || !isRecord(params.message)) {
      throw new A2ARpcError(JSON_RPC_INVALID_PARAMS, "message/send requires a message");
    }
    const text = extractText(params.message);
    if (text === undefined) {
      throw new A2ARpcError(
        JSON_RPC_INVALID_PARAMS,
        "message/send requires a text part",
      );
    }
    const messageId = isUuid(params.message.messageId)
      ? params.message.messageId
      : randomUUID();
    const contextId = isUuid(params.message.contextId)
      ? params.message.contextId
      : randomUUID();
    const persona = this.#resolvePersona();
    const workspaces = this.#workspaces;
    const sessionId = workspaces
      ? workspaces.allocate(A2A_OWNER_PLUGIN_ID, contextId).sessionId
      : undefined;
    const snapshot = await this.#loops.start(
      {
        prompt: text,
        ...(persona ? { personaId: persona.id } : {}),
        ...(sessionId !== undefined ? { sessionId } : {}),
        security: {
          kind: "root",
          subject: { kind: "a2a-task", id: messageId },
          classification: "internal",
          provenance: { kind: "plugin", id: A2A_OWNER_PLUGIN_ID },
          operationPrefix: modelOperationPrefixSchema.parse(`a2a/${messageId}`),
        },
      },
      A2A_OWNER_PLUGIN_ID,
    );
    return taskFromSnapshot(snapshot);
  }

  #getTask(params: unknown): A2ATask {
    const taskId = taskIdFromParams(params);
    if (taskId === undefined) {
      throw new A2ARpcError(JSON_RPC_INVALID_PARAMS, "tasks/get requires a task id");
    }
    const snapshot = this.#loops.get(taskId, A2A_OWNER_PLUGIN_ID);
    if (!snapshot) {
      throw new A2ARpcError(A2A_TASK_NOT_FOUND, `Task ${taskId} was not found`);
    }
    return taskFromSnapshot(snapshot);
  }

  #cancelTask(params: unknown): A2ATask {
    const taskId = taskIdFromParams(params);
    if (taskId === undefined) {
      throw new A2ARpcError(
        JSON_RPC_INVALID_PARAMS,
        "tasks/cancel requires a task id",
      );
    }
    const existing = this.#loops.get(taskId, A2A_OWNER_PLUGIN_ID);
    if (!existing) {
      throw new A2ARpcError(A2A_TASK_NOT_FOUND, `Task ${taskId} was not found`);
    }
    if (!this.#loops.cancel(taskId, A2A_OWNER_PLUGIN_ID)) {
      throw new A2ARpcError(
        A2A_TASK_NOT_CANCELABLE,
        `Task ${taskId} cannot be canceled`,
      );
    }
    const snapshot = this.#loops.get(taskId, A2A_OWNER_PLUGIN_ID) ?? existing;
    return taskFromSnapshot({
      ...snapshot,
      status: "cancelled",
      updatedAt: new Date().toISOString(),
    });
  }

  #resolvePersona() {
    const personas = this.#personas;
    if (!personas) {
      return undefined;
    }
    const configured = this.#config.personaId
      ? personas.get(this.#config.personaId)
      : undefined;
    if (configured && !configured.archived) {
      return configured;
    }
    return personas.getDefault();
  }

  async #listenNow(port: number): Promise<void> {
    const current = this.address();
    if (this.#server?.listening && current?.port === port && current.host === "127.0.0.1") {
      return;
    }
    await this.#closeNow();
    const server = this.#createServer((request, response) => {
      void this.#handleHttp(request, response);
    });
    this.#server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off("listening", onListening);
        if (this.#server === server) {
          this.#server = undefined;
        }
        reject(error);
      };
      const onListening = (): void => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, "127.0.0.1");
    });
  }

  async #closeNow(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    if (!server) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  async #handleHttp(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      const path = request.url?.split("?")[0] ?? "/";
      if (request.method === "GET" && path === "/.well-known/agent-card.json") {
        this.#writeJson(response, 200, this.agentCard());
        return;
      }
      if (request.method !== "POST") {
        response.writeHead(404);
        response.end();
        return;
      }
      const raw = await readBody(request, MAX_BODY_BYTES);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        this.#writeJson(response, 200, {
          jsonrpc: "2.0",
          id: null,
          error: {
            code: JSON_RPC_PARSE_ERROR,
            message: "Parse error",
          },
        } satisfies JsonRpcResponse);
        return;
      }
      const rpc = parseJsonRpcRequest(parsed);
      if (!rpc) {
        this.#writeJson(response, 200, {
          jsonrpc: "2.0",
          id: jsonRpcId(isRecord(parsed) ? parsed.id : null),
          error: {
            code: JSON_RPC_INVALID_REQUEST,
            message: "Invalid JSON-RPC request",
          },
        } satisfies JsonRpcResponse);
        return;
      }
      this.#writeJson(response, 200, await this.dispatch(rpc));
    } catch {
      if (!response.headersSent) {
        response.writeHead(500);
      }
      response.end();
    }
  }

  #writeJson(response: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(payload),
    });
    response.end(payload);
  }
}

class A2ARpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "A2ARpcError";
  }
}

function parseJsonRpcRequest(value: unknown): JsonRpcRequest | undefined {
  if (!isRecord(value) || value.jsonrpc !== "2.0" || typeof value.method !== "string") {
    return undefined;
  }
  const method = value.method.trim();
  if (method.length === 0) {
    return undefined;
  }
  return {
    jsonrpc: "2.0",
    method,
    ...(value.params !== undefined ? { params: value.params } : {}),
    ...(value.id !== undefined ? { id: jsonRpcId(value.id) } : {}),
  };
}

function readBody(request: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        request.destroy();
        reject(new Error("A2A request body is too large"));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}
