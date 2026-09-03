import type {
  ConfigStoreProvider,
  Disposable,
  JsonValue,
  PluginDefinition,
  SecretStoreProvider,
  StoreEntry,
  StoreTransactionOperation,
} from "@borg/plugin-sdk";

type ConfigSchema = NonNullable<PluginDefinition["configSchema"]>;
type ConfigDocument = Readonly<Record<string, unknown>>;
type ConfigListener = (config: ConfigDocument) => void | Promise<void>;

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }
  if (typeof value !== "object") {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null) &&
    Object.getOwnPropertySymbols(value).length === 0 &&
    Object.values(value).every(isJsonValue)
  );
}

function asJsonValue(value: unknown, description: string): JsonValue {
  if (!isJsonValue(value)) {
    throw new Error(`${description} is not JSON-serializable`);
  }
  return value;
}

function asConfigDocument(value: unknown, pluginId: string): ConfigDocument {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`Config schema for ${pluginId} must produce an object`);
  }
  return value as ConfigDocument;
}

function assertProviderMethods(
  provider: object,
  methods: readonly string[],
  kind: string,
): void {
  for (const method of methods) {
    if (!(method in provider) || typeof Reflect.get(provider, method) !== "function") {
      throw new Error(`${kind} provider is missing method ${method}`);
    }
  }
}

function assertKey(value: string, description: string): void {
  if (value.length === 0 || value.includes("\0")) {
    throw new Error(`${description} must be non-empty and cannot contain NUL`);
  }
}

export class PersistenceRegistry {
  #configStore:
    | { readonly pluginId: string; readonly provider: ConfigStoreProvider }
    | undefined;
  #secretStore:
    | { readonly pluginId: string; readonly provider: SecretStoreProvider }
    | undefined;

  registerConfigStore(pluginId: string, provider: ConfigStoreProvider): Disposable {
    if (typeof provider !== "object" || provider === null) {
      throw new Error("Config store provider must be an object");
    }
    assertProviderMethods(
      provider,
      [
        "readConfig",
        "writeConfig",
        "getStore",
        "listStore",
        "applyStoreTransaction",
      ],
      "Config store",
    );
    if (this.#configStore) {
      throw new Error(
        `Config store is already provided by ${this.#configStore.pluginId}`,
      );
    }
    const registration = { pluginId, provider };
    this.#configStore = registration;
    return {
      dispose: () => {
        if (this.#configStore === registration) {
          this.#configStore = undefined;
        }
      },
    };
  }

  registerSecretStore(pluginId: string, provider: SecretStoreProvider): Disposable {
    if (
      typeof provider !== "object" ||
      provider === null ||
      !["development", "os"].includes(provider.kind)
    ) {
      throw new Error("Secret store provider failed validation");
    }
    assertProviderMethods(
      provider,
      ["get", "set", "delete", "has"],
      "Secret store",
    );
    if (this.#secretStore) {
      throw new Error(
        `Secret store is already provided by ${this.#secretStore.pluginId}`,
      );
    }
    const registration = { pluginId, provider };
    this.#secretStore = registration;
    return {
      dispose: () => {
        if (this.#secretStore === registration) {
          this.#secretStore = undefined;
        }
      },
    };
  }

  getConfigStore(): ConfigStoreProvider {
    if (!this.#configStore) {
      throw new Error("Config store is unavailable");
    }
    return this.#configStore.provider;
  }

  getSecretStore(): SecretStoreProvider {
    if (!this.#secretStore) {
      throw new Error("Secret store is unavailable");
    }
    return this.#secretStore.provider;
  }

  hasConfigStore(): boolean {
    return this.#configStore !== undefined;
  }

  hasSecretStore(): boolean {
    return this.#secretStore !== undefined;
  }

  getSecretStoreKind(): SecretStoreProvider["kind"] | undefined {
    return this.#secretStore?.provider.kind;
  }
}

export class ConfigFacade {
  readonly #schemas = new Map<string, ConfigSchema>();
  readonly #listeners = new Map<string, Set<ConfigListener>>();
  readonly #updateQueues = new Map<string, Promise<void>>();

  constructor(readonly registry: PersistenceRegistry) {}

  registerSchema(pluginId: string, schema: ConfigSchema): Disposable {
    if (this.#schemas.has(pluginId)) {
      throw new Error(`Config schema for ${pluginId} is already registered`);
    }
    this.#schemas.set(pluginId, schema);
    return {
      dispose: () => {
        if (this.#schemas.get(pluginId) === schema) {
          this.#schemas.delete(pluginId);
          this.#listeners.delete(pluginId);
        }
      },
    };
  }

  async get(pluginId: string): Promise<ConfigDocument> {
    const schema = this.#schemas.get(pluginId);
    if (!schema) {
      throw new Error(`Config schema for ${pluginId} is unavailable`);
    }
    const stored = await this.registry.getConfigStore().readConfig(pluginId);
    const parsed = schema.safeParse(stored ?? {});
    if (!parsed.success) {
      throw new Error(`Stored config for ${pluginId} failed schema validation`, {
        cause: parsed.error,
      });
    }
    const document = asConfigDocument(parsed.data, pluginId);
    asJsonValue(document, `Config for ${pluginId}`);
    return document;
  }

  async update(
    pluginId: string,
    patch: Readonly<Record<string, unknown>>,
  ): Promise<ConfigDocument> {
    if (patch === null || Array.isArray(patch) || typeof patch !== "object") {
      throw new Error("Config patch must be an object");
    }
    const previous = this.#updateQueues.get(pluginId) ?? Promise.resolve();
    let releaseQueue: (() => void) | undefined;
    const queueTail = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    this.#updateQueues.set(pluginId, queueTail);

    await previous;
    let document: ConfigDocument;
    try {
      document = await this.#updateNow(pluginId, patch);
    } finally {
      releaseQueue?.();
      if (this.#updateQueues.get(pluginId) === queueTail) {
        this.#updateQueues.delete(pluginId);
      }
    }
    await this.#publish(pluginId, document);
    return document;
  }

  async #updateNow(
    pluginId: string,
    patch: Readonly<Record<string, unknown>>,
  ): Promise<ConfigDocument> {
    const schema = this.#schemas.get(pluginId);
    if (!schema) {
      throw new Error(`Config schema for ${pluginId} is unavailable`);
    }
    const current = await this.get(pluginId);
    const parsed = schema.safeParse({ ...current, ...patch });
    if (!parsed.success) {
      throw new Error(`Config update for ${pluginId} failed schema validation`, {
        cause: parsed.error,
      });
    }
    const document = asConfigDocument(parsed.data, pluginId);
    await this.registry
      .getConfigStore()
      .writeConfig(pluginId, asJsonValue(document, `Config for ${pluginId}`));
    return document;
  }

  watch(pluginId: string, listener: ConfigListener): Disposable {
    const listeners = this.#listeners.get(pluginId) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(pluginId, listeners);
    return {
      dispose: () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          this.#listeners.delete(pluginId);
        }
      },
    };
  }

  async #publish(pluginId: string, document: ConfigDocument): Promise<void> {
    const listeners = [...(this.#listeners.get(pluginId) ?? [])];
    await Promise.allSettled(
      listeners.map(async (listener) => listener(document)),
    );
  }
}

export class StoreFacade {
  constructor(readonly registry: PersistenceRegistry) {}

  async get(pluginId: string, key: string): Promise<JsonValue | undefined> {
    assertKey(key, "Store key");
    const value = await this.registry.getConfigStore().getStore(pluginId, key);
    return value === undefined ? undefined : asJsonValue(value, "Store value");
  }

  set(pluginId: string, key: string, value: JsonValue): Promise<void> {
    return this.transaction(pluginId, [{ type: "set", key, value }]);
  }

  delete(pluginId: string, key: string): Promise<void> {
    return this.transaction(pluginId, [{ type: "delete", key }]);
  }

  list(pluginId: string, prefix = ""): Promise<readonly StoreEntry[]> {
    if (prefix.includes("\0")) {
      throw new Error("Store prefix cannot contain NUL");
    }
    return this.#list(pluginId, prefix);
  }

  async #list(pluginId: string, prefix: string): Promise<readonly StoreEntry[]> {
    const entries = await this.registry.getConfigStore().listStore(pluginId, prefix);
    return entries.map((entry) => {
      assertKey(entry.key, "Store entry key");
      if (!entry.key.startsWith(prefix)) {
        throw new Error("Config store returned an entry outside the requested prefix");
      }
      return {
        key: entry.key,
        value: asJsonValue(entry.value, `Store value ${pluginId}/${entry.key}`),
      };
    });
  }

  transaction(
    pluginId: string,
    operations: readonly StoreTransactionOperation[],
  ): Promise<void> {
    if (!Array.isArray(operations)) {
      throw new Error("Store transaction operations must be an array");
    }
    for (const operation of operations) {
      if (
        typeof operation !== "object" ||
        operation === null ||
        (operation.type !== "set" && operation.type !== "delete")
      ) {
        throw new Error("Store transaction contains an invalid operation");
      }
      assertKey(operation.key, "Store key");
      if (operation.type === "set") {
        asJsonValue(operation.value, `Store value ${pluginId}/${operation.key}`);
      }
    }
    return this.registry
      .getConfigStore()
      .applyStoreTransaction(pluginId, operations);
  }
}

export class SecretFacade {
  constructor(readonly registry: PersistenceRegistry) {}

  async get(pluginId: string, key: string): Promise<string | undefined> {
    assertKey(key, "Secret key");
    const value = await this.registry.getSecretStore().get(pluginId, key);
    if (value !== undefined && typeof value !== "string") {
      throw new Error("Secret store returned a non-string value");
    }
    return value;
  }

  set(pluginId: string, key: string, value: string): Promise<void> {
    assertKey(key, "Secret key");
    if (typeof value !== "string") {
      throw new Error("Secret value must be a string");
    }
    return this.registry.getSecretStore().set(pluginId, key, value);
  }

  delete(pluginId: string, key: string): Promise<void> {
    assertKey(key, "Secret key");
    return this.registry.getSecretStore().delete(pluginId, key);
  }

  async has(pluginId: string, key: string): Promise<boolean> {
    assertKey(key, "Secret key");
    const result = await this.registry.getSecretStore().has(pluginId, key);
    if (typeof result !== "boolean") {
      throw new Error("Secret store returned a non-boolean availability result");
    }
    return result;
  }
}
