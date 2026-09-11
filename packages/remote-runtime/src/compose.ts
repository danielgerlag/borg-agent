import {
  assertUnattendedAllowlist,
  contractJsonValueSchema,
  type RemoteRunSpec,
} from "@borg/contracts";
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
} from "@borg/kernel";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  defineTool,
  z,
  type ConfigStoreProvider,
  type JsonValue,
  type LlmProviderContribution,
  type StoreEntry,
  type StoreTransactionOperation,
} from "@borg/plugin-sdk";

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
  const { baseUrl, apiKey, model } = spec.provider;
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
      const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: request.messages.map((message) => ({
            role: message.role,
            content: message.content,
          })),
        }),
        signal,
      });
      if (!response.ok) {
        throw new Error(`Model HTTP ${response.status}`);
      }
      const payload = (await response.json()) as {
        choices?: { message?: { content?: string } }[];
      };
      const content = payload.choices?.[0]?.message?.content ?? "";
      return {
        content,
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
          throw new Error("Workspace is unavailable");
        }
        const resolvedRoot = path.resolve(root);
        const target = path.resolve(resolvedRoot, input.path);
        const prefix = resolvedRoot.endsWith(path.sep)
          ? resolvedRoot
          : `${resolvedRoot}${path.sep}`;
        if (target !== resolvedRoot && !target.startsWith(prefix)) {
          throw new Error("Path escapes the workspace");
        }
        return {
          path: input.path,
          content: await readFile(target, "utf8"),
        };
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
    });
  } else {
    await personas.create({
      id: options.spec.persona.id,
      name: options.spec.persona.name,
      instructions: options.spec.persona.instructions,
      preferredModels: options.spec.persona.preferredModels,
      allowedTools: options.spec.persona.allowedTools,
      loopStrategy: options.spec.persona.loopStrategy,
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
