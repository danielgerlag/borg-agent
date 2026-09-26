# @borg/kernel

Borg's kernel is a small core that can be embedded. The desktop app is one host of it. Any plain Node process can build the same services, supply its own host adapters, activate plugins, and run agent loops. `@borg/kernel` never imports Electron, and `scripts/check-plugin-boundaries.mjs` enforces that during `pnpm typecheck`.

## Embedding

```ts
export const KERNEL_VERSION: string;      // kernel release, equal to package.json "version"
export const KERNEL_API_VERSION: string;  // what plugin `engines.borg` ranges are checked against

export function createKernel(options: CreateKernelOptions): Kernel;

interface CreateKernelOptions {
  plugins: readonly PluginSource[];
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
