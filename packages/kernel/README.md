# @borg/kernel

Borg's kernel is a small core that can be embedded. The desktop app is one host of it. Any plain Node process can build the same services, supply its own host adapters, activate plugins, and run agent loops. `@borg/kernel` never imports Electron, and `scripts/check-plugin-boundaries.mjs` enforces that during `pnpm typecheck`.

## Embedding

```ts
export const KERNEL_VERSION: string;      // kernel release, equal to package.json "version"
export const KERNEL_API_VERSION: string;  // what plugin `engines.borg` ranges are checked against

export function createKernel(options: CreateKernelOptions): Kernel;

interface CreateKernelOptions {
  plugins: readonly PluginSource[];
  distribution?: Distribution; // when set, only these plugins activate
  host: KernelHost;
  /** Returns the id of the secretStore plugin to activate; called once the config store is active. */
  resolveSecretStore(config: ConfigFacade): Promise<string>;
}

interface KernelHost {
  dataDirectory: string;                        // workspaces/sessions and plugins/<id> live under it
  showOsNotification?: OsNotificationHandler;
  openExternal?: (url: string) => Promise<void>; // used by OAuth
  showWindow?: () => void;                      // backs the `window.show` permission
  logError?: (message: string, error: unknown) => void; // defaults to console.error
}

interface Kernel {
  version: string;
  bus; plugins; config; secrets; notifications; interactions;
  loops; personas; models; costs; workspaces;
  start(): Promise<void>; // config store, then secret store, then every other plugin
  stop(): Promise<void>;  // deactivate plugins and shut services down; safe to call twice
}
```

A kernel requires exactly one compatible `configStore` plugin and the `secretStore` plugin named by `resolveSecretStore`.

`test/create-kernel.test.ts` is a complete embed that runs as written. It uses in-memory config and secret stores, a scripted model provider, and one tool. It boots the kernel in plain Node, runs a single loop that calls the tool, and stops the kernel.

## Distributions

A distribution names the plugins, defaults, and policy a host runs on the kernel. The desktop app is the `borg.desktop` distribution. `@borg/kernel` checks the distribution against `KERNEL_API_VERSION` and activates only the listed plugins. `@borg/plugin-sdk` stays the contract for plugin authors.

```ts
export interface DistributionPluginEntry {
  readonly id: string;
  readonly enabled?: boolean; // defaults to true
}

export interface DistributionDefinition {
  readonly id: string;            // same id syntax as plugin ids, such as "borg.desktop"
  readonly name: string;          // non-empty display name
  readonly version: string;       // semver
  readonly kernel: string;        // range checked against KERNEL_API_VERSION, same syntax as plugin engines.borg
  readonly plugins: readonly (string | DistributionPluginEntry)[];
  readonly defaults?: {
    /** Model preferences ("providerId:modelId") for model requests that name no provider or model. Persona preferences are unaffected. */
    readonly models?: readonly string[];
  };
  readonly policy?: {
    /** Execution subjects whose results are detached from the parent execution instead of merged into it. */
    readonly detachedResults?: readonly { readonly pluginId: string; readonly subjectKinds: readonly string[] }[];
  };
}

export interface Distribution {  // normalized, deeply frozen
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly kernel: string;
  readonly plugins: readonly { readonly id: string; readonly enabled: boolean }[];
  readonly defaults: { readonly models?: readonly string[] };
  readonly policy: {
    readonly detachedResults?: readonly { readonly pluginId: string; readonly subjectKinds: readonly string[] }[];
  };
}

export function defineDistribution(definition: DistributionDefinition): Distribution;
```

`defineDistribution` returns a deeply frozen `Distribution`. A string in `plugins` becomes `{ id, enabled: true }`. An invalid definition throws one `Error`. The message starts with `Invalid distribution <id>:` and lists every problem. The checks cover id syntax (the same rule as plugin ids), a non-empty name, a semver `version`, a `kernel` range in the same syntax as `engines.borg`, at least one plugin, unique plugin ids, `defaults.models` entries shaped as `provider:model`, and `policy.detachedResults` entries with plugin ids and non-empty subject kinds.

Plugins are named by manifest id, for example `borg.chat`. The kernel uses that id for activation, locks, the `system.plugins` enablement document, and `engines.borg` checks. The npm package that supplies an id is chosen at build time. `scripts/generate-bundled-plugins.mjs` reads the desktop distribution and emits those packages.

`createKernel` accepts an optional `distribution`. Callers that omit it keep today's activation behavior. When a distribution is set, `createKernel` checks it before constructing any service. `Distribution` is a plain structural type, so `createKernel` first reruns every `defineDistribution` check on the object it receives; a hand-built object gets no shortcut. It then checks the distribution against the kernel and the sources. A failed check throws one `Error` whose message starts with `Distribution <id>@<version> cannot run on this kernel:` and lists every problem. The kernel range has to include `KERNEL_API_VERSION`. Each declared id needs exactly one matching source in `plugins`, so two sources that share a declared id fail the check. Sources the distribution does not name are ignored. Declared plugins activate in the order of their sources in `plugins`, not the order of the distribution's list.

A plugin with `enabled: false` starts disabled when `system.plugins` has no stored document. After that document is written, the stored document is authoritative. The config store and the active secret store stay locked on.

When `defaults.models` is present, it replaces the built-in model fallback `borg.mock-llm:mock:scripted`, which the gateway uses for requests that name no provider or model. Loops still pick models from the persona. When `policy.detachedResults` is present, a subject is detached when an entry names its plugin and includes its kind. Every other subject merges into the parent execution. Omitted fields keep the built-in values. Removing those built-ins is tracked by issue #39.

```ts
import { defineDistribution } from "@borg/kernel";

export const minimalDistribution = defineDistribution({
  id: "example.minimal",
  name: "Minimal",
  version: "0.1.0",
  kernel: "^0.1.0",
  plugins: [
    "example.config",
    "example.secrets",
    "example.decoy",
    "example.llm",
    { id: "example.optional", enabled: false },
  ],
  defaults: {
    models: ["example.llm:scripted"],
  },
});
```
