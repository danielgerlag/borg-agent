# Write a plugin

This is the path for a plugin package in this repo. `plugins/hello` (`@borg/plugin-hello`, id `borg.hello`) is the example. Hello has no `test/` directory. [Tests](#tests) uses other plugins for the harness and the boundary test.

The kernel loads a `PluginSource`. It does not read `package.json`. `scripts/generate-bundled-plugins.mjs` is what turns the `borg` field into the sources the desktop passes to `createKernel()`.

## Layout of a plugin package

Hello's package contains these files.

- `borg.plugin.json`, the static manifest.
- `package.json`, with a `borg` field and `exports`.
- `src/main.ts`, the main entry, built by `tsc -p tsconfig.main.json`.
- `src/contract.ts`, included by `tsconfig.main.json` and built to `dist/contract.js`.
- `src/ui.tsx`, typechecked by `tsconfig.ui.json` and exported as source.
- `tsconfig.main.json` includes `src/main.ts` and `src/contract.ts`, with `outDir` `dist`.
- `tsconfig.ui.json` includes `src/ui.tsx`, sets `jsx` to `preserve` and `jsxImportSource` to `solid-js`, and sets `noEmit` to true.

`plugins/hello/package.json` exports and the `borg` field:

```json
"exports": {
  "./main": "./dist/main.js",
  "./contract": "./dist/contract.js",
  "./ui": "./src/ui.tsx"
},
"borg": {
  "id": "borg.hello",
  "manifest": "borg.plugin.json",
  "main": "/main",
  "ui": "/ui"
}
```

The generator reads every directory under `plugins/` and `examples/`. A package with no `borg` field is skipped. For a package that has one, it requires string `name`, `borg.id`, `borg.manifest`, and `borg.main`. `borg.ui` may be absent. If it is present it must be a string. The manifest path must stay inside the package directory.

`borg.id` is the manifest id. `borg.manifest` is the path to `borg.plugin.json`, relative to the package. `borg.main` and `borg.ui` are export subpaths appended to the package name. Hello's main specifier is `@borg/plugin-hello/main`. Its UI specifier is `@borg/plugin-hello/ui`. Those strings must equal `manifest.main` and `manifest.ui`. A mismatch throws `Borg metadata and static manifest disagree`. Two packages with the same `borg.id` throw `Plugin packages share an id`.

The generated main loader `require`s that main specifier and passes the module's default export to the kernel. `PluginManager` accepts either a `PluginDefinition` or a module whose `default` is one (`asDefinition` in `packages/kernel/src/plugin-manager.ts`).

## Manifest

Hello's manifest, `plugins/hello/borg.plugin.json`:

```json
{
  "id": "borg.hello",
  "version": "0.1.0",
  "engines": {
    "borg": "^0.1.0"
  },
  "main": "@borg/plugin-hello/main",
  "ui": "@borg/plugin-hello/ui",
  "permissions": [
    "notifications:send",
    "ui.flightDeck",
    "ui.settings"
  ],
  "contributes": {
    "commands": [
      "borg.hello.getStatus"
    ],
    "kinds": [
      "flightDeckWidget",
      "settingsPage"
    ]
  }
}
```

`pluginManifestSchema` in `packages/plugin-sdk/src/index.ts` is the shape `PluginManager` parses. `id` matches `/^[a-z0-9]+(?:[.-][a-z0-9-]+)+$/`, the same pattern as `pluginIdPattern` in `packages/kernel/src/plugin-enablement.ts`. `version` is a semver string. `engines.borg` is a non-empty string. `main` is a non-empty string. `ui` is an optional non-empty string. `permissions` is an array of strings. `contributes` may list `commands`, `events`, `extensionPoints`, and `kinds`, each an array of strings. The schema does not enumerate permission or kind names.

`src/main.ts` passes the same identity to `definePlugin()`. `definePlugin` freezes the object and returns it. The hello main entry:

```ts
export default definePlugin({
  id: "borg.hello",
  version: "0.1.0",
  engines: {
    borg: "^0.1.0",
  },
  permissions: ["notifications:send", "ui.flightDeck", "ui.settings"],
  contributes: {
    commands: ["borg.hello.getStatus"],
    kinds: ["flightDeckWidget", "settingsPage"],
  },
  configSchema: z.object({
    message: z.string().trim().min(1).max(80).default("Kernel alive"),
  }),
  activate(context) {
    // ...
  },
});
```

`PluginDefinition` has no `main` or `ui` field. On activation, `definitionsAgree` requires the manifest and the `definePlugin` object to share `id`, `version`, `engines.borg`, `permissions`, and the four `contributes` arrays. Array order does not matter. The comparison sorts copies. A mismatch throws `Plugin <id> main definition does not agree with its static manifest`.

`PluginManager.activate` then does the following, in `packages/kernel/src/plugin-manager.ts`.

1. `pluginManifestSchema.safeParse` must succeed. A bad manifest throws `Plugin manifest did not match the Borg manifest schema`.
2. A contributed event id for which `isKernelOnlyEvent` is true throws `Event <id> is reserved by the kernel`. `KERNEL_ONLY_EVENT_IDS` in `packages/contracts/src/index.ts` contains `channelInboundMessage`.
3. Discovering an id that already has a record other than `disabled` throws `Plugin <id> was discovered twice`.
4. `satisfiesBorgEngine(manifest.engines.borg, hostVersion)` must be true. `createKernel` passes `KERNEL_API_VERSION` (`0.1.0` in `packages/kernel/src/create-kernel.ts`) as `hostVersion`. A prerelease kernel version satisfies a range only when the range string contains `-` (`satisfiesBorgEngine` in `packages/kernel/src/engine-range.ts`). An unsatisfied range is stored as status `incompatible` and `loadMain` is not called.
5. `loadMain()` runs, and `definitionsAgree` must pass.
6. `context.bus.handle` later requires the command id to be in `contributes.commands`. `context.bus.emit` requires the event id to be in `contributes.events`. Both checks live in `packages/kernel/src/command-event-bus.ts` and throw `did not declare command` or `did not declare event`. A second handler for the same command id throws `already handled`.

Permission strings and contribution kinds are checked when a plugin calls the matching host method, not when the manifest is parsed. The strings `PluginManager` checks are listed under [Activation and PluginContext](#activation-and-plugincontext). UI registration strings are listed under [UI](#ui).

## Activation and PluginContext

`PluginDefinition.activate` receives a `PluginContext` and may return nothing, a `Disposable`, or a promise of either. `deactivate` is optional. A `Disposable` is `{ dispose(): void | Promise<void> }` from `packages/plugin-sdk/src/index.ts`.

Hello's main `activate` registers one command and returns nothing.

```ts
activate(context) {
  const startedAt = new Date().toISOString();

  context.bus.handle(helloGetStatus, async () => {
    const config = await context.config.get();
    return {
      pluginId: "borg.hello",
      kernelVersion: context.host.version,
      status: "alive" as const,
      message:
        typeof config.message === "string" ? config.message : "Kernel alive",
      startedAt,
      now: new Date().toISOString(),
    };
  });
},
```

If `configSchema` is set, `PluginManager` registers it with the config facade and reads it before `activate`, unless this activation is the bootstrap config store. Hello takes the ordinary path, so `context.config.get()` inside the handler sees the schema, including the default `message`. `context.config` itself does not check a permission string.

On deactivation, `PluginManager.deactivate` aborts the plugin signal, calls `definition.deactivate` when it exists, and then disposes the tracked disposables. Registrations made through `context.bus.handle` and the other `stage` helpers are in that disposable list.

`PluginManager` builds the context in `packages/kernel/src/plugin-manager.ts`. Calling a method without the permission it checks throws `Plugin <id> did not declare permission <permission>`. A missing contribution kind throws `Plugin <id> did not declare contribution <kind>`. The manifest schema still accepts any string. These are the strings that method checks.

| Call | Permission or contribution |
| --- | --- |
| `pluginId`, `signal`, `host`, `logger` | None |
| `config.get`, `config.update`, `config.watch` | None. A bootstrap config store cannot call ordinary host services. |
| `store.get`, `store.set`, `store.delete`, `store.list`, `store.transaction` | None |
| `secrets.get`, `secrets.has` | `secrets:read` |
| `secrets.set`, `secrets.delete` | `secrets:write` |
| `persistence.registerConfigStore` | Contribution `configStore` |
| `persistence.registerSecretStore` | Contribution `secretStore` |
| `executions.bind`, `executions.grant` | `executions.manage` |
| `tools.register` | `tools.register` and contribution `tool`. `fs:sessionWorkspace`, when present, sets `workspaceAccess`. |
| `tools.registerProvider` | `tools.provide` and contribution `toolProvider`. Same `workspaceAccess` flag. |
| `tools.registerExecutionScope` | `tools.invoke`. A `personaId` also requires `personas.read`. `workspace.manage`, when present, looks up that session's workspace root. |
| `tools.invoke`, `tools.listCatalog` | `tools.invoke` |
| `models.registerProvider` | `models.register` and contribution `llmProvider` |
| `models.complete` | `models.complete` |
| `loops.start`, `loops.get`, `loops.list`, `loops.pause`, `loops.resume`, `loops.cancel`, `loops.subscribe` | `loops.start`. `start` also records whether `tools.invoke` is present. |
| `interactions.requestHumanInput` | `interactions.request:human_input`. The caller must be `borg.feedback` while it is handling `borg.feedback.ask`. |
| `cost.summary`, `cost.subscribe` | `cost.read` |
| `personas.get`, `personas.list`, `personas.getDefault` | `personas.read` |
| `personas.setDefault`, `personas.create`, `personas.update`, `personas.archive` | `personas.write` |
| `workspace.allocate`, `workspace.get`, `workspace.listFiles`, `workspace.readFile`, `workspace.importNativePaths`, `workspace.release` | `workspace.manage` |
| `prompts.registerSlot` | `prompts.register` and contribution `promptSlot`. The slot id must start with `<pluginId>.` |
| `memory.registerProvider` | `memory.provide` and contribution `memoryProvider` |
| `memory.write` | `memory.write` |
| `memory.retrieve` | `memory.read` |
| `sandbox.run` | `sandbox.run` |
| `scanners.register` | `scanners.register` and contribution `promptScanner` |
| `graphs.registerStep` | `graphs.contribute` and contribution `graphStep` |
| `graphs.registerTrigger` | `graphs.contribute` and contribution `graphTrigger` |
| `graphs.listSteps`, `graphs.listTriggers` | `graphs.readContributions` |
| `scheduler.schedule`, `scheduler.scheduleCron`, `scheduler.cancel` | `scheduler.manage` |
| `process.spawn` | `subprocess:mcp` |
| `http.fetch` | `network:dynamic` |
| `channels.register` | `channels.register` and contribution `channel` |
| `channels.send` | `channels.send` |
| `webSockets.connect` | `network:websocket` |
| `tls.connect` | `network:tls` |
| `oauth.connect`, `oauth.snapshot`, `oauth.accessToken`, `oauth.disconnect` | `oauth.connect` |
| `runtime.spawn` | `runtime.background` |
| `window.show` | `window.show` |
| `notify` | `notifications:send` |
| `a2a.snapshot` | None. The context `PluginManager` builds always sets `a2a`. |
| `dataDir` | The plugin data directory when `fs:pluginData` is present. Otherwise `""`. This is a presence check, not `assertPermission`. |
| `bus.handle` | The command id must be listed in `contributes.commands` |
| `bus.invoke`, `bus.provides` | None |
| `bus.emit` | The event id must be listed in `contributes.events`, and `isKernelOnlyEvent` must be false |
| `bus.on` | None |

`ui.flightDeck` and `ui.settings` are on hello's manifest because the renderer checks them. `PluginManager` does not.

## Contracts

Command and event schemas live in `src/contract.ts`. Hello's command, from `plugins/hello/src/contract.ts`:

```ts
export const helloGetStatus = defineCommand({
  id: "borg.hello.getStatus",
  input: z.object({}).strict(),
  output: z.object({
    pluginId: z.string(),
    kernelVersion: z.string(),
    status: z.literal("alive"),
    message: z.string(),
    startedAt: z.string().datetime(),
    now: z.string().datetime(),
  }),
});
```

`defineCommand` and `defineEvent` are exported from `@borg-agent/contracts` (`packages/contracts/src/index.ts`). A command has `id`, `input`, `output`, and an optional `timeoutMs`. An event has `id` and `payload`. Both helpers freeze the object.

`plugins/bots/src/contract.ts` defines an event:

```ts
export const botUpdated = defineEvent({
  id: "borg.bots.updated",
  payload: z.object({ bot: botSchema }).strict(),
});
```

`scripts/check-plugin-boundaries.mjs` enforces the `./contract` export.

- The target must be `./dist/contract.js`.
- `src/contract.ts` must exist.
- The tsconfig named by the package's `build` script (`tsconfig.main.json` for hello) must list `src/contract.ts`, `src/*.ts`, or `src/**/*.ts` in `include`.
- If `src/contract.ts` exists, `package.json` must export `./contract`.
- `src/contract.ts` may import `zod`, `@borg-agent/contracts`, `@borg-agent/contracts/<subpath>` matching `[a-z0-9-]+`, or `@borg/plugin-<name>/contract`.

`defineCommand(` and `defineEvent(` outside `packages/contracts/src` and `plugins/*/src/contract.ts` fail that script, except three kernel tests named in the allowlist. The full rule list is in [boundaries.md](boundaries.md).

Another plugin imports the built contract and lists the package in `dependencies`. `plugins/graphs/src/executor.ts` imports `chatAppend`, and `plugins/graphs/package.json` lists `"@borg/plugin-chat": "workspace:*"`.

```ts
import { chatAppend } from "@borg/plugin-chat/contract";
```

`PluginBus` in `packages/plugin-sdk/src/index.ts` has `handle`, `invoke`, `provides`, `emit`, and `on`. Hello's main entry calls `context.bus.handle`. A caller uses `context.bus.invoke` with the same command object. `emit` publishes an event the plugin declared. `on` subscribes, and the subscriber does not declare that event. There is no `call`, `publish`, or `subscribe` method on `PluginBus`. `loops.subscribe` is the loop helper, not the bus.

`contributes.commands` must include every id passed to `bus.handle`. `contributes.events` must include every id passed to `bus.emit`. `PluginManager` passes those sets into `CommandEventBus`.

## What a plugin may import

`scripts/check-plugin-boundaries.mjs` is the check `pnpm check:boundaries` runs. For a plugin it requires all of the following.

- Import `@borg-agent/plugin-sdk` for the plugin API. Import `@borg-agent/contracts` for kernel schemas, and a capability subpath (`@borg-agent/contracts/calendar`, `/connector-accounts`, `/contacts`, `/drive`, `/web-search`) for schemas shared across plugins. For example, `plugins/channel-google/src/tools.ts` imports `@borg-agent/contracts/calendar`. `src/contract.ts` has the stricter import list above. Hello's UI also imports `@borg/ui-kit`. The boundary script does not restrict `@borg/ui-kit`.
- Import another plugin only as `@borg/plugin-<name>/contract`, and list that package in `dependencies`.
- Keep relative imports inside this plugin's directory.
- Keep plugin-to-plugin contract dependencies acyclic.
- Keep `plugins/graphs` off `langgraph` and `@langchain/langgraph`, both as imports and as dependencies.

Locked decision 10 in `docs/architecture.md` states the same rule for authors. A plugin uses host APIs, contributions, kernel schemas from `@borg-agent/contracts`, and another plugin's commands, events, and schemas through that plugin's `@borg/plugin-<name>/contract` subpath, declared as a package dependency.

## UI

Hello's renderer entry is `plugins/hello/src/ui.tsx`. It default-exports `defineUiPlugin`. The package export `./ui` points at `./src/ui.tsx`. The desktop dynamic-imports that source file.

The widget calls `context.bus.invoke(helloGetStatus, {})`. Settings call `context.config.get`, `context.config.update`, and `context.notify`. Registration at the end of `activate` is:

```tsx
const widget = context.ui.registerFlightDeckWidget({
  id: "borg.hello.kernel-status",
  label: "Kernel status",
  placement: "developer",
  component: HelloWidget,
});
const settings = context.ui.registerSettingsPage({
  id: "borg.hello.settings",
  label: "Hello",
  order: 10,
  placement: "developer",
  component: HelloSettings,
});
return {
  dispose: async () => {
    await settings.dispose();
    await widget.dispose();
  },
};
```

`scripts/generate-bundled-plugins.mjs` writes one loader per declared plugin that has `borg.ui`. Hello's line in `apps/desktop/src/renderer/bundled-ui-plugins.ts` is a dynamic `import("@borg/plugin-hello/ui")`. `activatePluginUi` in `apps/desktop/src/renderer/plugin-ui-manager.ts` looks up `bundledUiPlugins[plugin.id]`, loads `default`, and requires `definition.id` to equal the active plugin id. A missing loader is skipped.

`createUiTransaction` in that file refuses a registration unless the manifest has both the permission and the contribution kind.

| Host method | Permission | Kind |
| --- | --- | --- |
| `registerWorkspaceView` | `ui.workspace` | `workspaceView` |
| `registerSettingsPage` | `ui.settings` | `settingsPage` |
| `registerWizardStep` | `ui.wizard` | `wizardStep` |
| `registerFlightDeckWidget` | `ui.flightDeck` | `flightDeckWidget` |
| `registerInteractionRenderer` | `ui.interactions` | `interactionRenderer` |
| `registerEmbeddedContentRenderer` | `ui.embeddedContent.render` | `embeddedContentRenderer` |
| `getEmbeddedContentRenderer` | `ui.embeddedContent.consume` | None |

The same file checks other `PluginUiContext` methods before they call the preload bridge. `secrets.has` requires `secrets:read`. `secrets.set` and `secrets.delete` require `secrets:write`. Every `loops` method requires `loops.start`. `interactions.list` requires `interactions.read`. Persona reads require `personas.read`. Persona writes require `personas.write`. `models.list` requires `models.read`. Cost reads require `cost.read`. Every `files` method requires `workspace.manage`. `notify` requires `notifications:send`. `bus.invoke`, `bus.provides`, and `bus.on` do not check a permission in this file. `config.get` and `config.update` do not either.

## Tests

Plugin tests live in `plugins/<name>/test/*.test.ts`. `vitest.config.mts` includes `plugins/**/test/**/*.test.ts` along with the app, distribution, and package tests. `tsconfig.tests.json` includes `plugins/**/test/**/*.ts`. `pnpm typecheck` runs `tsc -p tsconfig.tests.json` after the build. `pnpm test` runs `pnpm build` and then `vitest run`.

`createTestHarness` is in `packages/plugin-sdk/src/index.ts`. It requires `plugin.id === context.pluginId`, calls `activate`, and on `deactivate` calls `plugin.deactivate` and then the activation disposable.

```ts
export async function createTestHarness(
  plugin: PluginDefinition,
  context: PluginContext,
): Promise<PluginTestHarness> {
  if (plugin.id !== context.pluginId) {
    throw new Error(
      `Plugin ${plugin.id} cannot activate in harness context ${context.pluginId}`,
    );
  }
  const activation = await plugin.activate(context);
  // ...
}
```

`plugins/a2a/test/harness.ts` builds a `PluginContext` and returns `activate: () => createTestHarness(a2aPlugin, context)`. `plugins/context-map/test/main.test.ts` calls `createTestHarness` directly and asserts the prompt the plugin registers. `plugins/usage/test/boundaries.test.ts` reads that package's `package.json` and `src` imports and expects no `@borg/plugin-*` package other than `@borg-agent/plugin-sdk`.

Hello has no tests. To run one plugin's tests after a build:

```sh
npx --yes pnpm@12.0.0 exec vitest run plugins/usage/test/boundaries.test.ts
```

`pnpm test` is the full suite, and it builds first. The `vitest run` command above does not build.

## Add a plugin to the desktop

The desktop bundle is the union of the ids in `distributions/desktop/src/index.ts` and `distributions/print-bench/src/index.ts`. The generator loads the built `@borg/distribution-desktop` and `@borg/distribution-print-bench` modules. If either package is not built yet, generation throws `Could not load @borg/distribution-desktop` or `Could not load @borg/distribution-print-bench`. Build the distribution package before generating bundled plugins.

Do this to add a plugin.

1. Put the package in `plugins/<dir>`, or in `examples/<dir>` for a worked example, with a `borg` field, as [Layout of a plugin package](#layout-of-a-plugin-package) describes. `borg.id` must match `borg.plugin.json`.
2. Add that manifest id to the `plugins` array in `distributions/desktop/src/index.ts` for the reference app, or `distributions/print-bench/src/index.ts` for the print harness. A string means enabled. `{ id, enabled: false }` is valid and still requires a package. The generator sorts the union by `id.localeCompare` before it writes files. `apps/desktop/test/bundled-plugins.test.ts` expects the generated main ids to equal that union, so keep each distribution array in the same order.
3. Add the package name to `dependencies` in `apps/desktop/package.json`. The generator reads that object. A declared plugin whose package is missing there throws `Selected plugins are not dependencies of @borg/desktop`.
4. Run `pnpm install` so the workspace links the new dependency.
5. Run `pnpm build`. The root build runs `pnpm check:boundaries`, then each package build. `apps/desktop` builds with `node ../../scripts/generate-bundled-plugins.mjs`, then `tsc`, then Vite. The generator writes only declared plugins into `apps/desktop/src/main/bundled-plugins.ts` and, for packages with `borg.ui`, into `apps/desktop/src/renderer/bundled-ui-plugins.ts`. Both files are tracked in git. Each file starts with `Generated by scripts/generate-bundled-plugins.mjs. Do not edit.`
6. Add the id to `baselinePluginIds` in `distributions/desktop/test/desktop-distribution.test.ts` when it belongs to the reference app, or to `harnessPluginIds` in `distributions/print-bench/test/print-bench-distribution.test.ts` when it belongs to the harness. Those tests also expect every listed plugin to be enabled, and the desktop test expects the current `defaults.models` and `policy.detachedResults`. An `enabled: false` entry fails the enabled assertion until you change the test. If the plugin has `borg.ui` and the bundle includes it, add the id to `baselineUiIds` in `apps/desktop/test/bundled-plugins.test.ts`. Plugins without `borg.ui` stay out of that list. `borg.channel.mock` and `borg.tools.echo` are declared and have no UI loader.

A declared id with no `plugins/*/package.json` or `examples/*/package.json` `borg.id` throws `Bundled distributions declare plugin ids with no package`.

`createKernel` does not wait for `start()` to notice a missing source. `resolveDistribution` in `packages/kernel/src/create-kernel.ts` runs first. Each declared id, including one with `enabled: false`, needs exactly one source whose manifest id matches. Zero sources for an id adds `missing plugin source <id>`. Two sources add `duplicate plugin source <id>`. Any problem throws `Distribution <id>@<version> cannot run on this kernel:` and the kernel does not construct services. The desktop calls `createKernel` from `apps/desktop/src/main/index.ts` with `bundledMainPlugins` and the distribution selected by `BORG_DISTRIBUTION`. Unset selects `borg.desktop`. `borg.print-bench` selects the print harness. Sources the selected distribution does not name stay in the bundle and are not activated. A list the generator cannot satisfy fails the desktop build before that call.
