# Plugin host APIs

Catalog of what a plugin may call through `@borg/plugin-sdk`.

Types live in `packages/plugin-sdk/src/index.ts`. Main permission and kind checks live in `packages/kernel/src/plugin-manager.ts`. Renderer checks live in `apps/desktop/src/renderer/plugin-ui-manager.ts`. Command and event payloads live in `packages/contracts`.

This document describes the host as implemented. It is not a tutorial.

Related: `docs/architecture.md`. That file is the why. This file is the catalog.

## Two contexts

A plugin has two entry points. They do not share an object.

| Entry | Define with | Context | Runs in |
| --- | --- | --- | --- |
| `main` | `definePlugin` | `PluginContext` | Electron main (Node) |
| `ui` (optional) | `defineUiPlugin` | `PluginUiContext` | Renderer (Solid). No Node. No Electron. No `ipcRenderer`. |

Main activates first. The renderer loads UI only for plugins whose main activation committed.

A plugin cannot import another plugin package. Collaboration is host APIs, contributions, and typed commands or events from `@borg/contracts`.

Installed plugin main code is trusted local JavaScript. Host permission checks wrap SDK calls. They do not stop a malicious main module from importing Node APIs directly.

## Manifest

`borg.plugin.json` is validated before either entry imports. `definePlugin({...})` must agree with it (`id`, `version`, `engines.borg`, `permissions`, `contributes`).

```ts
interface BorgPluginManifest {
  id: string;                 // e.g. borg.chat
  version: string;            // semver
  engines: { borg: string };  // semver range vs kernel host version
  main: string;
  ui?: string;
  permissions: string[];
  contributes: {
    commands?: string[];
    events?: string[];
    extensionPoints?: string[];
    kinds?: string[];
  };
}
```

`contributes.kinds` is an index. Runtime payloads are registered during `activate`. The kernel also requires the matching kind on several `register*` calls.

`contributes.commands` lists command IDs this plugin may `bus.handle`. Duplicate command ownership across plugins fails activation.

`contributes.events` lists event IDs this plugin may `bus.emit`.

`engines.borg` is checked before import. An unsatisfied range leaves the plugin discoverable and inactive.

## Namespacing

| Resource | Scope |
| --- | --- |
| `ctx.config` | this plugin id |
| `ctx.store` | this plugin id |
| `ctx.secrets` | this plugin id |
| `ctx.dataDir` | this plugin id, and only if `fs:pluginData` is declared (otherwise `""`) |
| workspaces | this plugin id plus the session id you pass |
| prompt slot ids | must start with `{pluginId}.` |
| OAuth sessions | this plugin id |

A plugin cannot read another plugin's config, store, or secrets through the SDK.

## Main context (`PluginContext`)

Always present, no extra permission:

| Member | Notes |
| --- | --- |
| `pluginId` | Manifest id |
| `signal` | Aborted on deactivate |
| `host.version` | Kernel host version string |
| `host.platform` | `process.platform` |
| `logger` | `debug` `info` `warn` `error` |
| `config` | `get` `update` `watch`. Schema from `definePlugin.configSchema` |
| `store` | `get` `set` `delete` `list` `transaction`. JSON only |
| `bus` | See [Command and event bus](#command-and-event-bus) |
| `a2a.snapshot()` | `{ enabled, listening, port, personaId? }`. No permission check |

### `ctx.secrets`

| Method | Permission |
| --- | --- |
| `get` `has` | `secrets:read` |
| `set` `delete` | `secrets:write` |

### `ctx.persistence`

| Method | Kind |
| --- | --- |
| `registerConfigStore` | `configStore` |
| `registerSecretStore` | `secretStore` |

Bootstrap config-store plugins may register a store. They cannot use ordinary host services.

### `ctx.executions`

Permission `executions.manage`.

| Method | Role |
| --- | --- |
| `bind(intent)` | Start or resume an execution. Returns `observe` `importDetachedResult` `summary` `close` |
| `grant(executionId)` | Parent grant for a child plugin call |

### `ctx.tools`

| Method | Permission | Kind |
| --- | --- | --- |
| `register` | `tools.register` | `tool` |
| `registerProvider` | `tools.provide` | `toolProvider` |
| `registerExecutionScope` | `tools.invoke` |  |
| `invoke` | `tools.invoke` |  |
| `listCatalog` | `tools.invoke` |  |

`register` also records whether the plugin declared `fs:sessionWorkspace`. That flag is tool-pipeline access to the session workspace, not a separate method.

`invoke` may also require `personas.read` when the call resolves a persona.

### `ctx.models`

| Method | Permission | Kind |
| --- | --- | --- |
| `registerProvider` | `models.register` | `llmProvider` |
| `complete` | `models.complete` |  |

`complete` is auxiliary generation through `ModelGateway`. It is not chat.

### `ctx.loops`

All methods require `loops.start`: `start` `get` `list` `pause` `resume` `cancel` `subscribe`.

### `ctx.interactions`

| Method | Permission |
| --- | --- |
| `requestHumanInput` | `interactions.request:human_input` |

Only usable while this plugin's command handler is the active operation. The kernel creates safety interactions (`tool_approval`, classification) itself.

### `ctx.cost`

Permission `cost.read`: `summary` `subscribe`.

### `ctx.personas`

| Method | Permission |
| --- | --- |
| `get` `list` `getDefault` | `personas.read` |
| `setDefault` `create` `update` `archive` | `personas.write` |

Personas are kernel-owned. Plugins do not persist persona records in their own store.

### `ctx.skills`

Same permissions as personas (`personas.read` / `personas.write`).

| Method | Permission |
| --- | --- |
| `get` `list` | `personas.read` |
| `create` `update` `archive` | `personas.write` |

There is no `skills.*` permission. Catalog identity stays in the kernel (`system.skills`).

### `ctx.workspace`

Permission `workspace.manage`: `allocate` `get` `listFiles` `readFile` `importNativePaths` `release`.

Session ids are namespaced to the calling plugin. Reusing another plugin's session id does not grant access.

### `ctx.prompts`

| Method | Permission | Kind |
| --- | --- | --- |
| `registerSlot` | `prompts.register` | `promptSlot` |

### `ctx.memory`

| Method | Permission | Kind |
| --- | --- | --- |
| `registerProvider` | `memory.provide` | `memoryProvider` |
| `write` | `memory.write` |  |
| `retrieve` | `memory.read` |  |

The kernel selects one memory provider.

### `ctx.sandbox`

Permission `sandbox.run`. `run({ kind: "os" \| "uv" \| "node", root, ... })`.

### `ctx.scanners`

| Method | Permission | Kind |
| --- | --- | --- |
| `register` | `scanners.register` | `promptScanner` |

Findings are advisory. The kernel combines them with classification and permission policy.

### `ctx.graphs`

| Method | Permission | Kind |
| --- | --- | --- |
| `registerStep` | `graphs.contribute` | `graphStep` |
| `registerTrigger` | `graphs.contribute` | `graphTrigger` |
| `listSteps` `listTriggers` | `graphs.readContributions` |  |

`borg.graphs` is the graph engine. There is no `ctx` method to register a replacement engine. `graphEngine` appears in that plugin's `kinds` index only.

### `ctx.scheduler`

Permission `scheduler.manage`: `schedule` `scheduleCron` `cancel`.

### `ctx.runtime`

Permission `runtime.background`. `spawn(task)` runs until dispose or deactivate.

### `ctx.process`

Permission `subprocess:mcp`. `spawn(command, args, options)` returns pid, stdio streams, `exit`, `close`, `kill`.

Architecture text still mentions `subprocess:uv` and `subprocess:node`. The spawn wrapper checks `subprocess:mcp` only.

### `ctx.http`

Permission `network:dynamic`. `fetch` is the standard Fetch API, audited by `NetworkService`.

Several bundled LLM plugins also declare `network:api.openai.com` and similar host tokens. `ctx.http.fetch` does not read those tokens. Declaring a host does not grant fetch, and `network:dynamic` is not limited to a host list.

### `ctx.channels`

| Method | Permission | Kind |
| --- | --- | --- |
| `register` | `channels.register` | `channel` |
| `send` | `channels.send` |  |

Adapters receive inbound drafts through the `ingest` callback supplied at `start`. They must not emit inbound events themselves.

### `ctx.webSockets`

Permission `network:websocket`. `connect(url, options)`.

### `ctx.tls`

Permission `network:tls`. `connect({ host, port, ... })`.

### `ctx.oauth`

Permission `oauth.connect`: `connect` `snapshot` `accessToken` `disconnect`.

### `ctx.window`

Permission `window.show`. `show()` focuses the desktop window.

### `ctx.notify`

Permission `notifications:send`. Toast, optional OS notification.

### `ctx.dataDir`

String path if `fs:pluginData` is declared. Empty string otherwise. Not a method.

## Renderer context (`PluginUiContext`)

No `store`, `http`, `tools`, `workspace.allocate`, `process`, or secret `get`.

Always present:

| Member | Notes |
| --- | --- |
| `pluginId` |  |
| `config.get` `config.update` | Same namespaced config as main |
| `bus.invoke` `bus.provides` `bus.on` | See bus. `invoke` can call any registered command, not only this plugin's |
| `ui` | Shell slots. Each `register*` needs a UI permission and a kind |

### `ctx.ui`

| Method | Permission | Kind |
| --- | --- | --- |
| `registerWorkspaceView` | `ui.workspace` | `workspaceView` |
| `registerSettingsPage` | `ui.settings` | `settingsPage` |
| `registerWizardStep` | `ui.wizard` | `wizardStep` |
| `registerFlightDeckWidget` | `ui.flightDeck` | `flightDeckWidget` |
| `registerInteractionRenderer` | `ui.interactions` | `interactionRenderer` |
| `registerEmbeddedContentRenderer` | `ui.embeddedContent.render` | `embeddedContentRenderer` |
| `getEmbeddedContentRenderer` | `ui.embeddedContent.consume` |  |

Settings `group` is optional. The shell maps known ids in `apps/desktop/src/renderer/settings-groups.ts`.

### Other UI host methods

| Member | Permission |
| --- | --- |
| `secrets.has` | `secrets:read` |
| `secrets.set` `secrets.delete` | `secrets:write` |
| `loops.*` | `loops.start` |
| `interactions.list` | `interactions.read` |
| `personas.get` `list` `getDefault` | `personas.read` |
| `personas.setDefault` `create` `update` | `personas.write` |
| `skills.get` `list` | `personas.read` |
| `skills.create` `update` `archive` | `personas.write` |
| `models.list` | `models.read` |
| `cost.summary` `cost.subscribe` | `cost.read` |
| `files.*` | `workspace.manage` |
| `notify` | `notifications:send` |

`PluginUiPersonas` has no `archive`. `PluginUiSecrets` has no `get`. `PluginUiModels` has no `complete`.

`files` covers drag, clipboard paths, reveal, and copy for workspace files the plugin already owns on main.

## Command and event bus

One bus, in main. Definitions use `defineCommand` / `defineEvent` in `@borg/contracts`.

| Call | Who | Rule |
| --- | --- | --- |
| `handle` | main | Command id must be in this plugin's `contributes.commands`. One handler worldwide |
| `invoke` | main and UI | Any registered command |
| `provides` | main and UI | Whether a handler exists |
| `emit` | main | Event id must be in this plugin's `contributes.events` |
| `on` | main and UI | UI may subscribe only to an event an active plugin declared |

Handler timeout comes from `command.timeoutMs` when set.

`borg.remote` is the only handler for:

| Command | Role |
| --- | --- |
| `borg.remote.listWorkers` | Workers the plugin has provisioned |
| `borg.remote.provision` | Create a `local`, `azure-vm`, or `kubernetes` worker |
| `borg.remote.destroy` | Forget the worker. Azure also DELETEs the VM |
| `borg.remote.submitRun` | Write the spec. Local spawns detached `borg-runtime` with `ELECTRON_RUN_AS_NODE=1`. Azure PUTs spec and status blobs on a user storage account. Kubernetes POSTs a Job that mounts the spec ConfigMap |
| `borg.remote.getRun` | Read `status.json` (local file, Azure blob, Kubernetes ConfigMap, or Job conditions) |

`submitRun` calls `assertUnattendedAllowlist` before the provider. Local spawn uses detached `node:child_process` with `ELECTRON_RUN_AS_NODE` so the Electron binary runs the CLI as Node. Azure blob writes omit `openai-compat` API keys and require an ARM token. Kubernetes apiserver calls send the kubeconfig token. There is no `ctx.runtimes` field and no `agentRuntime` kind.

Plugins do not add IPC channels. Renderer traffic for kernel objects uses the fixed `borg:kernel:call` map. Product commands use `borg:command:invoke` with the command id.

## Contribution kinds the kernel checks

These `kinds` values are required at the matching `register*` call:

| Kind | Register on |
| --- | --- |
| `tool` | `ctx.tools.register` |
| `toolProvider` | `ctx.tools.registerProvider` |
| `llmProvider` | `ctx.models.registerProvider` |
| `promptSlot` | `ctx.prompts.registerSlot` |
| `memoryProvider` | `ctx.memory.registerProvider` |
| `promptScanner` | `ctx.scanners.register` |
| `graphStep` | `ctx.graphs.registerStep` |
| `graphTrigger` | `ctx.graphs.registerTrigger` |
| `channel` | `ctx.channels.register` |
| `configStore` | `ctx.persistence.registerConfigStore` |
| `secretStore` | `ctx.persistence.registerSecretStore` |

UI kinds are listed under `ctx.ui`.

Declared in a bundled manifest and not wired to a `ctx.register*` method:

| Kind | Meaning today |
| --- | --- |
| `graphEngine` | `borg.graphs` owns the engine. Index only |

## Permissions the wrappers check

Exact strings `assertPermission` / the renderer equivalent currently test.

```
channels.register
channels.send
cost.read
executions.manage
graphs.contribute
graphs.readContributions
interactions.read
interactions.request:human_input
loops.start
memory.provide
memory.read
memory.write
models.complete
models.read
models.register
network:dynamic
network:tls
network:websocket
notifications:send
oauth.connect
personas.read
personas.write
prompts.register
runtime.background
sandbox.run
scanners.register
scheduler.manage
secrets:read
secrets:write
subprocess:mcp
tools.invoke
tools.provide
tools.register
ui.embeddedContent.consume
ui.embeddedContent.render
ui.flightDeck
ui.interactions
ui.settings
ui.wizard
ui.workspace
window.show
workspace.manage
```

Used as flags, not as the permission on a dedicated method:

| Token | Effect |
| --- | --- |
| `fs:pluginData` | Non-empty `ctx.dataDir` |
| `fs:sessionWorkspace` | Tools registered by this plugin may use the session workspace |

Appears in some manifests and in architecture examples, not as the check on `ctx.http.fetch` or `ctx.process.spawn`:

| Token | Actual check |
| --- | --- |
| `network:<hostname>` | Unused by `ctx.http.fetch`. Fetch needs `network:dynamic` |
| `subprocess:uv` `subprocess:node` | Unused. Spawn needs `subprocess:mcp` |

## Helpers on the SDK

| Export | Role |
| --- | --- |
| `z` | Zod, re-exported |
| `definePlugin` | Main descriptor |
| `defineUiPlugin` | UI descriptor |
| `defineTool` | Tool contribution |
| `defineToolProvider` | Dynamic tool catalog |
| `createTestHarness` | Activate against a fake `PluginContext` |

Shared UI widgets are `@borg/ui-kit`, not the plugin SDK.

## Not available through the SDK

- Importing another plugin's package
- Adding Electron IPC channels
- Node or Electron APIs from the UI entry
- Reading another plugin's store, config, or secrets
- Secret plaintext `get` from the renderer
- Registering a second graph engine
- A `skills.*` permission separate from personas

## Source of truth

Reread these files if this catalog and the code disagree. Trust the code.

- `packages/plugin-sdk/src/index.ts`
- `packages/kernel/src/plugin-manager.ts`
- `apps/desktop/src/renderer/plugin-ui-manager.ts`
- `packages/contracts/src/index.ts` (command and event payloads)
- `plugins/*/borg.plugin.json` (what bundled plugins declare)
