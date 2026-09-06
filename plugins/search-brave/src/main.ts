import {
  braveConnect,
  braveDisconnect,
  braveGetStatus,
  webSearchInputSchema,
  webSearchOutputSchema,
  type SearchProviderStatus,
} from "@borg/contracts";
import {
  definePlugin,
  defineTool,
  z,
  type Disposable,
  type PluginContext,
} from "@borg/plugin-sdk";
import {
  BRAVE_SECRET_KEY,
  BraveClient,
  SAFE_BRAVE_ERRORS,
} from "./client";

const braveConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
  })
  .strict();

class BraveController {
  readonly #context: PluginContext;
  readonly #client: BraveClient;
  #registration: Disposable | undefined;
  #configWatch: Disposable | undefined;
  #queue: Promise<void> = Promise.resolve();
  #disposed = false;

  constructor(context: PluginContext, client: BraveClient) {
    this.#context = context;
    this.#client = client;
  }

  async initialize(): Promise<void> {
    this.#configWatch = this.#context.config.watch(() => this.sync());
    await this.sync();
  }

  async status(): Promise<SearchProviderStatus> {
    const config = braveConfigSchema.parse(await this.#context.config.get());
    const hasKey = await this.#context.secrets.has(BRAVE_SECRET_KEY);
    return {
      hasKey,
      enabled: config.enabled,
      connected: this.#registration !== undefined,
    };
  }

  async connect(): Promise<SearchProviderStatus> {
    if (!(await this.#context.secrets.has(BRAVE_SECRET_KEY))) {
      throw new Error(SAFE_BRAVE_ERRORS.missingKey);
    }
    await this.#context.config.update({ enabled: true });
    await this.sync();
    return this.status();
  }

  async disconnect(): Promise<SearchProviderStatus> {
    await this.#context.config.update({ enabled: false });
    await this.sync();
    return this.status();
  }

  sync(): Promise<void> {
    const run = this.#queue.then(() => this.#syncNow());
    this.#queue = run.catch(() => undefined);
    return run;
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#configWatch?.dispose();
    this.#configWatch = undefined;
    await this.#clearRegistration();
  }

  async #syncNow(): Promise<void> {
    if (this.#disposed) {
      await this.#clearRegistration();
      return;
    }
    const config = braveConfigSchema.parse(await this.#context.config.get());
    const hasKey = await this.#context.secrets.has(BRAVE_SECRET_KEY);
    if (config.enabled && hasKey) {
      if (this.#registration) {
        return;
      }
      this.#registration = this.#context.tools.register(
        defineTool({
          id: "brave.search",
          description: "Search the public web with Brave Search",
          input: webSearchInputSchema,
          output: webSearchOutputSchema,
          approval: "ask",
          sideEffect: false,
          security: {
            outputClassification: "public",
            outputProvenance: "external",
            channelCapacity: "public",
          },
          execute: (input, execution) =>
            this.#client.search(
              {
                query: input.query,
                ...(input.maxResults !== undefined
                  ? { maxResults: input.maxResults }
                  : {}),
              },
              execution.signal,
            ),
        }),
      );
      return;
    }
    await this.#clearRegistration();
  }

  async #clearRegistration(): Promise<void> {
    const current = this.#registration;
    this.#registration = undefined;
    await current?.dispose();
  }
}

export default definePlugin({
  id: "borg.search.brave",
  version: "0.1.0",
  engines: {
    borg: "^0.1.0",
  },
  permissions: [
    "network:dynamic",
    "secrets:read",
    "secrets:write",
    "tools.register",
    "ui.settings",
  ],
  contributes: {
    commands: [braveConnect.id, braveDisconnect.id, braveGetStatus.id],
    kinds: ["settingsPage", "tool"],
  },
  configSchema: braveConfigSchema,
  async activate(context) {
    const client = new BraveClient({
      fetchImpl: (input, init) =>
        init === undefined
          ? context.http.fetch(input)
          : context.http.fetch(input, init),
      getApiKey: () => context.secrets.get(BRAVE_SECRET_KEY),
    });
    const controller = new BraveController(context, client);
    await controller.initialize();
    context.bus.handle(braveGetStatus, () => controller.status());
    context.bus.handle(braveConnect, () => controller.connect());
    context.bus.handle(braveDisconnect, () => controller.disconnect());
    return {
      dispose: () => controller.dispose(),
    };
  },
});
