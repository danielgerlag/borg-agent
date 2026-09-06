import {
  tavilyConnect,
  tavilyDisconnect,
  tavilyGetStatus,
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
  SAFE_TAVILY_ERRORS,
  TAVILY_SECRET_KEY,
  TavilyClient,
} from "./client";

const tavilyConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
  })
  .strict();

class TavilyController {
  readonly #context: PluginContext;
  readonly #client: TavilyClient;
  #registration: Disposable | undefined;
  #configWatch: Disposable | undefined;
  #queue: Promise<void> = Promise.resolve();
  #disposed = false;

  constructor(context: PluginContext, client: TavilyClient) {
    this.#context = context;
    this.#client = client;
  }

  async initialize(): Promise<void> {
    this.#configWatch = this.#context.config.watch(() => this.sync());
    await this.sync();
  }

  async status(): Promise<SearchProviderStatus> {
    const config = tavilyConfigSchema.parse(await this.#context.config.get());
    const hasKey = await this.#context.secrets.has(TAVILY_SECRET_KEY);
    return {
      hasKey,
      enabled: config.enabled,
      connected: this.#registration !== undefined,
    };
  }

  async connect(): Promise<SearchProviderStatus> {
    if (!(await this.#context.secrets.has(TAVILY_SECRET_KEY))) {
      throw new Error(SAFE_TAVILY_ERRORS.missingKey);
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
    const config = tavilyConfigSchema.parse(await this.#context.config.get());
    const hasKey = await this.#context.secrets.has(TAVILY_SECRET_KEY);
    if (config.enabled && hasKey) {
      if (this.#registration) {
        return;
      }
      this.#registration = this.#context.tools.register(
        defineTool({
          id: "tavily.search",
          description: "Search the public web with Tavily",
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
  id: "borg.search.tavily",
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
    commands: [tavilyConnect.id, tavilyDisconnect.id, tavilyGetStatus.id],
    kinds: ["settingsPage", "tool"],
  },
  configSchema: tavilyConfigSchema,
  async activate(context) {
    const client = new TavilyClient({
      fetchImpl: (input, init) =>
        init === undefined
          ? context.http.fetch(input)
          : context.http.fetch(input, init),
      getApiKey: () => context.secrets.get(TAVILY_SECRET_KEY),
    });
    const controller = new TavilyController(context, client);
    await controller.initialize();
    context.bus.handle(tavilyGetStatus, () => controller.status());
    context.bus.handle(tavilyConnect, () => controller.connect());
    context.bus.handle(tavilyDisconnect, () => controller.disconnect());
    return {
      dispose: () => controller.dispose(),
    };
  },
});
