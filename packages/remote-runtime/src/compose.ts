import {
  assertUnattendedAllowlist,
  contractJsonValueSchema,
  type RemoteRunSpec,
} from "@borg-agent/contracts";
import {
  ClassificationService,
  CostLedger,
  DurableModelCallJournal,
  ExecutionSecurityService,
  InteractionService,
  LoopManager,
  ModelGateway,
  PersistenceRegistry,
  PersonaService,
  PromptAssembler,
  ScannerRegistry,
  StoreFacade,
  ToolService,
  TrustAuthorizer,
  WorkspaceService,
} from "@borg-agent/kernel";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";
import {
  defineTool,
  z,
  type ConfigStoreProvider,
  type JsonValue,
  type LlmProviderContribution,
  type ModelCompletionRequest,
  type ModelCompletionResult,
  type StoreEntry,
  type StoreTransactionOperation,
} from "@borg-agent/plugin-sdk";

class MemoryConfigStore implements ConfigStoreProvider {
  readonly configs = new Map<string, JsonValue>();
  readonly values = new Map<string, Map<string, JsonValue>>();

  async readConfig(namespace: string): Promise<unknown | undefined> {
    return this.configs.get(namespace);
  }

  async writeConfig(namespace: string, value: JsonValue): Promise<void> {
    this.configs.set(namespace, value);
  }

  async getStore(
    namespace: string,
    key: string,
  ): Promise<JsonValue | undefined> {
    return this.values.get(namespace)?.get(key);
  }

  async listStore(
    namespace: string,
    prefix: string,
  ): Promise<readonly StoreEntry[]> {
    return [...(this.values.get(namespace) ?? new Map()).entries()]
      .filter(([storeKey]) => storeKey.startsWith(prefix))
      .map(([storeKey, value]) => ({ key: storeKey, value }));
  }

  async applyStoreTransaction(
    namespace: string,
    operations: readonly StoreTransactionOperation[],
  ): Promise<void> {
    const next = new Map(this.values.get(namespace));
    for (const operation of operations) {
      if (operation.type === "set") {
        next.set(operation.key, valueOf(operation));
      } else {
        next.delete(operation.key);
      }
    }
    this.values.set(namespace, next);
  }
}

function valueOf(
  operation: Extract<StoreTransactionOperation, { type: "set" }>,
): JsonValue {
  return operation.value;
}

function scriptedProvider(spec: RemoteRunSpec): LlmProviderContribution {
  if (spec.provider.kind !== "scripted") {
    throw new Error("Scripted provider required");
  }
  const replies = spec.provider.replies;
  let index = 0;
  return {
    id: "borg.runtime.scripted",
    models: ["scripted"],
    egress: {
      kind: "local",
      capacity: "local-only",
    },
    async complete(_request, permit) {
      await permit.commit();
      const reply = replies[Math.min(index, replies.length - 1)];
      index += 1;
      if (!reply) {
        return {
          content: "done",
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            amount: 0,
            currency: "USD",
          },
        };
      }
      if (reply.toolCalls && reply.toolCalls.length > 0) {
        return {
          toolCalls: reply.toolCalls.map((call) => ({
            id: call.id,
            name: call.name,
            input: contractJsonValueSchema.parse(call.input),
          })),
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            amount: 0,
            currency: "USD",
          },
        };
      }
      return {
        content: reply.content ?? "done",
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          amount: 0,
          currency: "USD",
        },
      };
    },
  };
}

function openaiCompatProvider(spec: RemoteRunSpec): LlmProviderContribution {
  if (spec.provider.kind !== "openai-compat") {
    throw new Error("OpenAI-compatible provider required");
  }
  const { baseUrl, model } = spec.provider;
  const apiKey =
    spec.provider.apiKey ?? process.env.BORG_RUNTIME_API_KEY ?? "";
  if (apiKey.length === 0) {
    throw new Error("OpenAI-compatible provider requires an API key");
  }
  return {
    id: "borg.runtime.openai",
    models: [model],
    egress: {
      kind: "remote",
      capacity: "internal",
      destination: baseUrl,
    },
    async complete(request, permit, signal) {
      await permit.commit();
      const response = await fetch(
        `${baseUrl.replace(/\/$/, "")}/chat/completions`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(chatCompletionsBody(model, request)),
          signal,
        },
      );
      if (!response.ok) {
        throw new Error(`Model HTTP ${response.status}`);
      }
      return completionFromChatResponse(await response.json());
    },
  };
}

export function chatCompletionsBody(
  model: string,
  request: ModelCompletionRequest,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    messages: request.messages.map(toChatMessage),
  };
  if (request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.id,
        description: tool.description,
        parameters: tool.inputSchema,
      },
    }));
  }
  return body;
}

function toChatMessage(
  message: ModelCompletionRequest["messages"][number],
): Record<string, unknown> {
  if (message.role === "assistant" && message.toolCalls?.length) {
    return {
      role: "assistant",
      content: message.content.trim().length > 0 ? message.content : null,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: {
          name: call.name,
          arguments: JSON.stringify(call.input ?? {}),
        },
      })),
    };
  }
  if (message.role === "tool") {
    return {
      role: "tool",
      tool_call_id: message.toolCallId ?? "",
      content: message.content,
    };
  }
  return {
    role: message.role,
    content: message.content,
  };
}

export function completionFromChatResponse(payload: unknown): ModelCompletionResult {
  const usage = {
    inputTokens: 1,
    outputTokens: 1,
    amount: 0,
    currency: "USD" as const,
  };
  if (payload === null || typeof payload !== "object") {
    throw new Error("Model returned an unreadable response");
  }
  const choices = "choices" in payload ? payload.choices : undefined;
  const first =
    Array.isArray(choices) && choices[0] !== null && typeof choices[0] === "object"
      ? choices[0]
      : undefined;
  const message =
    first && "message" in first && first.message !== null && typeof first.message === "object"
      ? first.message
      : undefined;
  const toolCalls =
    message && "tool_calls" in message && Array.isArray(message.tool_calls)
      ? message.tool_calls
      : [];
  if (toolCalls.length > 0) {
    return {
      toolCalls: toolCalls.map((item: unknown) => {
        if (item === null || typeof item !== "object") {
          throw new Error("Model returned an unreadable tool call");
        }
        const id = "id" in item && typeof item.id === "string" ? item.id : "";
        const fn =
          "function" in item && item.function !== null && typeof item.function === "object"
            ? item.function
            : undefined;
        const name =
          fn && "name" in fn && typeof fn.name === "string" ? fn.name : "";
        const rawArgs =
          fn && "arguments" in fn && typeof fn.arguments === "string"
            ? fn.arguments
            : "{}";
        if (id.length === 0 || name.length === 0) {
          throw new Error("Model returned an unreadable tool call");
        }
        return {
          id,
          name,
          input: contractJsonValueSchema.parse(JSON.parse(rawArgs)),
        };
      }),
      usage,
    };
  }
  const content =
    message && "content" in message && typeof message.content === "string"
      ? message.content
      : "";
  if (content.length === 0) {
    throw new Error("Model completion requires content or a tool call");
  }
  return { content, usage };
}

function resolveWorkspaceReadPath(root: string, requestedPath: string): string {
  if (
    requestedPath.length === 0 ||
    requestedPath.includes("\0") ||
    path.isAbsolute(requestedPath)
  ) {
    throw new Error("Workspace path must be a non-empty relative path");
  }
  const resolved = path.resolve(root, requestedPath);
  const relative = path.relative(root, resolved);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("Workspace path escapes the session workspace");
  }
  return resolved;
}

export { assertUnattendedAllowlist };

export async function composeRuntime(options: {
  readonly spec: RemoteRunSpec;
  readonly workspaceRoot: string;
}) {
  assertUnattendedAllowlist(options.spec.persona.allowedTools);
  const registry = new PersistenceRegistry();
  registry.registerConfigStore("borg.runtime-config", new MemoryConfigStore());
  const store = new StoreFacade(registry);
  const interactions = new InteractionService();
  const classification = new ClassificationService();
  const scanners = new ScannerRegistry();
  scanners.register("borg.runtime", {
    id: "borg.runtime.allow-model-io",
    stages: ["model_input", "model_output"],
    scan: async () => [],
  });
  const authorizer = new TrustAuthorizer(interactions, { classification });
  const executions = new ExecutionSecurityService(store);
  const tools = new ToolService(interactions, {
    executions,
    classification,
    scanners,
    authorizer,
  });
  const costs = new CostLedger();
  const models = new ModelGateway({
    journal: new DurableModelCallJournal(store),
    executions,
    scanners,
    authorizer,
    costs,
  });
  const personas = new PersonaService(store);
  await personas.initialize();
  const prompts = new PromptAssembler(personas);
  const workspaces = new WorkspaceService(options.workspaceRoot);
  tools.register(
    "borg.tools.echo",
    defineTool({
      id: "tools.echo",
      description: "Echo text",
      input: z.object({ text: z.string() }).strict(),
      output: z.object({ echoed: z.string() }).strict(),
      approval: "auto",
      sideEffect: false,
      execute: ({ text }) => ({ echoed: text }),
    }),
  );
  tools.register(
    "borg.tools.core",
    defineTool({
      id: "filesystem.read",
      description: "Read a UTF-8 text file from the session workspace",
      input: z.object({ path: z.string().min(1) }).strict(),
      output: z
        .object({ path: z.string(), content: z.string() })
        .strict(),
      approval: "auto",
      sideEffect: false,
      async execute(input, execution) {
        const root = execution.workspaceRoot;
        if (!root) {
          throw new Error("This tool requires a session workspace");
        }
        const physicalRoot = await realpath(root);
        const target = resolveWorkspaceReadPath(physicalRoot, input.path);
        const file = await open(
          target,
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
        );
        try {
          const stats = await file.stat();
          if (stats.isSymbolicLink() || !stats.isFile()) {
            throw new Error("Workspace reads require a regular file");
          }
          return {
            path: input.path,
            content: await file.readFile("utf8"),
          };
        } finally {
          await file.close();
        }
      },
    }),
    { workspaceAccess: true },
  );
  const provider =
    options.spec.provider.kind === "scripted"
      ? scriptedProvider(options.spec)
      : openaiCompatProvider(options.spec);
  models.registerProvider("borg.runtime", provider);
  const existing = personas.get(options.spec.persona.id);
  if (existing) {
    await personas.update(options.spec.persona.id, {
      name: options.spec.persona.name,
      instructions: options.spec.persona.instructions,
      preferredModels: options.spec.persona.preferredModels,
      allowedTools: options.spec.persona.allowedTools,
      loopStrategy: options.spec.persona.loopStrategy,
      maxTurns: options.spec.persona.maxTurns,
    });
  } else {
    await personas.create({
      id: options.spec.persona.id,
      name: options.spec.persona.name,
      instructions: options.spec.persona.instructions,
      preferredModels: options.spec.persona.preferredModels,
      allowedTools: options.spec.persona.allowedTools,
      loopStrategy: options.spec.persona.loopStrategy,
      maxTurns: options.spec.persona.maxTurns,
      secondaryModels: [],
      mcpServers: [],
      skillIds: [],
      promptTemplates: [],
      archived: false,
    });
  }
  const loops = new LoopManager(
    models,
    executions,
    tools,
    costs,
    () => true,
    personas,
    prompts,
    workspaces,
  );
  return { loops, personas, workspaces };
}
