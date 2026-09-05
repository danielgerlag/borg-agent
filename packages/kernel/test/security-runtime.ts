import type {
  ConfigStoreProvider,
  JsonValue,
  StoreEntry,
  StoreTransactionOperation,
} from "@borg/plugin-sdk";
import {
  CostLedger,
  ClassificationService,
  DurableModelCallJournal,
  ExecutionSecurityService,
  InteractionService,
  ModelGateway,
  PersistenceRegistry,
  ScannerRegistry,
  StoreFacade,
  ToolService,
  TrustAuthorizer,
  type ModelGatewayOptions,
} from "../src";

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
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => ({ key, value }));
  }

  async applyStoreTransaction(
    namespace: string,
    operations: readonly StoreTransactionOperation[],
  ): Promise<void> {
    const next = new Map(this.values.get(namespace));
    for (const operation of operations) {
      if (operation.type === "set") {
        next.set(operation.key, operation.value);
      } else {
        next.delete(operation.key);
      }
    }
    this.values.set(namespace, next);
  }
}

export function createSecurityRuntime(
  options: ModelGatewayOptions = {},
) {
  const registry = new PersistenceRegistry();
  registry.registerConfigStore(
    "borg.test-config-store",
    new MemoryConfigStore(),
  );
  const store = new StoreFacade(registry);
  const interactions = new InteractionService();
  const classification = new ClassificationService();
  const costs = new CostLedger();
  const scanners = new ScannerRegistry();
  scanners.register("borg.test-security", {
    id: "borg.test-security.allow-model-io",
    stages: ["model_input", "model_output"],
    scan: async () => [],
  });
  const authorizer = new TrustAuthorizer(interactions, {
    classification,
  });
  const executions = new ExecutionSecurityService(store);
  const tools = new ToolService(interactions, {
    executions,
    classification,
    scanners,
    authorizer,
  });
  const models = new ModelGateway({
    journal: new DurableModelCallJournal(store),
    executions,
    scanners,
    authorizer,
    costs,
    options,
  });

  return {
    authorizer,
    classification,
    costs,
    executions,
    interactions,
    models,
    scanners,
    store,
    tools,
  };
}
