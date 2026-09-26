# Borg Agent

Borg Agent is an agentic harness microkernel: a minimal, stable core (agent loop, tool dispatch, context, lifecycle, plugin contract) that you bundle with plugins to build domain-specific harnesses.

In this repo the core is `@borg/kernel` (`packages/kernel`). `LoopManager` runs agent loops, `ToolService` dispatches tool calls, `PluginManager` activates and deactivates plugins, and each plugin receives a `PluginContext` with the host services it declared permissions for. The plugin contract is `@borg/plugin-sdk`: a plugin is a `definePlugin()` object plus a static `borg.plugin.json` manifest, and `PluginManager` checks the two against each other on activation. `createKernel()` boots the kernel headless in plain Node; see [packages/kernel/README.md](packages/kernel/README.md).

A host chooses its plugins with `defineDistribution()`. The desktop app in `apps/desktop` runs one distribution, `borg.desktop`, defined in `distributions/desktop` (`@borg/distribution-desktop`).

## Quickstart

You need Node.js 22 or newer, from `engines.node` in the root `package.json`, and pnpm 12.0.0, from `packageManager`.

Corepack runs that pinned pnpm without creating global symlinks in `/usr/local/bin`. You can instead install pnpm with `brew install pnpm` and call `pnpm` directly.

```sh
corepack pnpm install
corepack pnpm dev
```

`pnpm dev` runs `pnpm build`, then launches Electron through `scripts/run-electron.mjs`.

Corepack does not read registry or authentication settings from `~/.npmrc`. Behind a custom npm registry, call the pinned package through npm.

```sh
npx --yes pnpm@12.0.0 install
npx --yes pnpm@12.0.0 dev
```

pnpm checks the committed lockfile against its supply-chain policies on every install. The lockfile names no registry host, so the same frozen install works against npmjs or a feed that mirrors it. Private feed setup is in [CONTRIBUTING.md](CONTRIBUTING.md#installing-behind-a-corporate-or-private-npm-feed).

Checks:

```sh
corepack pnpm typecheck
corepack pnpm test
corepack pnpm test:coverage
corepack pnpm test:e2e
```

`pnpm build` runs `pnpm check:boundaries` before the workspace package builds. `typecheck`, `test`, `test:coverage`, and `test:e2e` each run `pnpm build` first.

## Architecture

The workspace lists `apps/*`, `distributions/*`, `packages/*`, and `plugins/*` in `pnpm-workspace.yaml`.

**`packages/kernel` (`@borg/kernel`).** `createKernel()`, `LoopManager`, `ToolService`, `CommandEventBus`, and `PluginManager` live here. The package does not import Electron.

**`packages/plugin-sdk` (`@borg/plugin-sdk`).** Plugin authors import `definePlugin`, `defineUiPlugin`, `PluginContext`, `pluginManifestSchema`, and `createTestHarness` from this package.

**`packages/contracts` (`@borg/contracts`).** The root export (`.` to `./dist/index.js`) is the kernel surface. `packages/contracts/src/index.ts` defines `defineCommand`, `defineEvent`, and the kernel schemas. Some plugin-specific schemas (for example `mcpServerConfigSchema`) still live in the root while they move into plugin contracts (#31). `package.json` also exports capability subpaths, schemas shared by several plugins that implement the same capability:

- `@borg/contracts/calendar`, `@borg/contracts/contacts`, `@borg/contracts/drive`: calendar, contacts, and drive tool schemas used by `plugins/channel-google` and `plugins/channel-m365`.
- `@borg/contracts/connector-accounts`: account-name and connector command schemas used by the channel and connector plugins.
- `@borg/contracts/web-search`: search hit, input, output, and status schemas used by `plugins/search-tavily` and `plugins/search-brave`.

Each subpath maps to `./dist/<name>.js`. The kernel and plugin SDK import only the root, and the boundary check keeps capability files out of the root export's import graph.

**Plugin `./contract` exports.** A plugin that publishes commands, events, or schemas ships them from `plugins/<name>/src/contract.ts`. Its `package.json` exports `./contract` to `./dist/contract.js`. Hello does this as `@borg/plugin-hello/contract`.

**`distributions/*`.** The tree has one distribution, `distributions/desktop`, package `@borg/distribution-desktop`. `defineDistribution()` in `packages/kernel/src/distribution.ts` checks the definition and returns a deeply frozen `Distribution`. A string in `plugins` becomes `{ id, enabled: true }`. The checks cover plugin-id syntax, a non-empty name, a semver `version`, a `kernel` range in the same syntax as plugin `engines.borg`, at least one plugin, unique plugin ids, an optional `enabled` boolean, `defaults.models` entries shaped as `provider:model`, and `policy.detachedResults` entries with a plugin id and non-empty subject kinds. Unknown fields fail the check.

`createKernel({ distribution })` in `packages/kernel/src/create-kernel.ts` runs those checks again, then checks the object against this process. The `kernel` range must accept `KERNEL_API_VERSION` (`0.1.0`). Each declared id needs exactly one matching source in `plugins`. A missing source, or two sources with the same declared id, throws before the kernel constructs services. The message starts with `Distribution <id>@<version> cannot run on this kernel:`. Sources the distribution does not name are dropped. `start` activates the one compatible config-store source, then the secret store named by `resolveSecretStore`, then the remaining sources in the order they appear in the `plugins` array. For the desktop app that array is `bundledMainPlugins` in `apps/desktop/src/main/bundled-plugins.ts`.

A plugin entered as `{ id, enabled: false }` is in the default disabled set when the `system.plugins` document is missing. After that document is stored, the stored document is what enablement reads. The config store and the active secret store stay locked on. Omitting `distribution` activates every source passed in `plugins`.

When `defaults.models` is set, it replaces the built-in model fallback `borg.mock-llm:mock:scripted` for requests that name no provider or model. When `policy.detachedResults` is set, a subject is detached when an entry names its plugin and includes its kind. Every other subject merges into the parent execution. Omitted fields keep those built-in values. The desktop distribution sets both fields in `distributions/desktop/src/index.ts`.

That file declares 34 plugin ids, all enabled, for `borg.desktop`. `apps/desktop/src/main/index.ts` passes `desktopDistribution` and `bundledMainPlugins` into `createKernel()`.

**`packages/ui-kit` (`@borg/ui-kit`).** Solid components for the shell and plugin UI. The package export `.` points at `./src/index.tsx`.

**`plugins/*`.** One package per plugin. Each desktop plugin has `borg.plugin.json` and a `borg` field in `package.json`.

**`apps/desktop` (`@borg/desktop`).** The Electron host. Its build runs `scripts/generate-bundled-plugins.mjs`, then compiles the main process and the renderer.

**`tests/e2e`.** Playwright specs. `playwright.config.ts` sets `testDir` to `./tests/e2e`. `pnpm test:e2e` launches the Electron app.

**`scripts/`.** Boundary checks, the bundled-plugin generator, `run-electron.mjs`, and the macOS package and verify scripts invoked by the root `package.json`.

Depth on the kernel services and the locked decisions is in [docs/architecture.md](docs/architecture.md).

## Boundary checks

`pnpm check:boundaries` runs three scripts, in this order. `pnpm build` runs that command first.

```sh
node scripts/check-plugin-boundaries.mjs
node scripts/check-editable-for-lists.mjs
node scripts/check-native-form-controls.mjs
```

`scripts/check-plugin-boundaries.mjs` reads the tree and throws `Plugin boundary check failed:` listing every hit. A clean run prints `Plugin import boundaries are valid.`

**Removed paths.** In `packages/kernel/src`, `apps/desktop/src`, and `plugins/*/src`, the script fails a file that mentions `ModelRouter` or `model-router`, a `provider.complete(` call outside `packages/kernel/src/model-gateway.ts`, or a `cost.record(` call or the string `cost.record`.

**Host process.** For `packages/kernel`, `packages/plugin-sdk`, `packages/contracts`, and each package under `distributions/`, a dependency, peer dependency, or optional dependency on `electron` fails, and a source import of `electron` fails. Kernel packages must stay host-agnostic. Distributions must stay host-agnostic.

**Gateway shape.** `packages/contracts/src/index.ts` must define `modelGatewayRequestSchema` with `executionId: executionIdSchema` and `operationKey: modelOperationKeySchema`. `packages/plugin-sdk/src/index.ts` must type `PluginModels.complete` as `request: Omit<ModelGatewayRequest, "tools">`. A `record(record: UsageRecord)` method on the plugin cost type fails.

**Package import closure.**

- `packages/contracts/src` may import `zod` and relative files inside that directory.
- `packages/kernel/src` and `packages/plugin-sdk/src` may import `@borg/contracts` only as the bare specifier `@borg/contracts`. A capability subpath fails. Those packages may import no `@borg/plugin-*` package other than `@borg/plugin-sdk`. Relative imports must stay inside that package's `src`.
- `packages/kernel`, `packages/plugin-sdk`, and `packages/contracts` must not list or import an `@borg/distribution-*` package. The dependency check covers `dependencies`, `devDependencies`, `peerDependencies`, and `optionalDependencies`.
- A distribution's `src` may import `@borg/kernel`, `zod`, and relative files inside that directory.

**Contracts root.** Every `packages/contracts` export other than `.` must point at `./dist/<name>.js`. The import graph from `packages/contracts/src/index.ts` must not reach the source file behind that subpath. Today the subpaths are `./calendar`, `./connector-accounts`, `./contacts`, `./drive`, and `./web-search`.

**Bus definitions.** `defineCommand(` and `defineEvent(` are allowed in `packages/contracts/src`, in `plugins/*/src/contract.ts`, and in three kernel tests that build throwaway definitions: `packages/kernel/test/command-event-bus.test.ts`, `packages/kernel/test/execution-handoff.test.ts`, and `packages/kernel/test/plugin-manager.test.ts`. Any other call under `apps`, `distributions`, `packages`, `plugins`, or `tests` fails. The scan skips `node_modules`, `dist`, and `.d.ts` files.

**Plugin sources.**

- `plugins/graphs` must not import or depend on `langgraph` or `@langchain/langgraph`.
- A plugin source may import another plugin package only as `@borg/plugin-<name>/contract`, and `dependencies` must list that package.
- A relative import that resolves inside a different directory under `plugins/` fails.
- `src/contract.ts` may import `zod`, `@borg/contracts`, `@borg/contracts/<subpath>` where the subpath matches `[a-z0-9-]+`, or `@borg/plugin-<name>/contract`.
- If `dependencies`, `devDependencies`, `peerDependencies`, or `optionalDependencies` lists another `@borg/plugin-*` package, some file under that plugin's `src` must import `<package>/contract`.
- A plugin with `src/contract.ts` must export `./contract`. The export target must be `./dist/contract.js`. Exporting `./contract` requires `src/contract.ts` and requires `tsconfig.main.json` `include` to contain `src/contract.ts`.
- Those plugin-to-plugin contract dependencies must form a DAG. A cycle fails with `plugin dependency cycle:`.

`scripts/check-editable-for-lists.mjs` fails a `<For>` block in `apps/**/*.tsx` or `plugins/**/*.tsx` that contains `onInput`, because `<For>` keys by object identity and remounts the input on each keystroke. `plugins/graphs/src/field-renderer.tsx` is the allowlisted exception.

`scripts/check-native-form-controls.mjs` fails a native `<input>`, `<textarea>`, `<select>`, or `<details>` in those same trees. Allowed `<input>` types are `range`, `color`, `file`, and `hidden`. The script tells you to use `@borg/ui-kit` `TextField`, `Checkbox`, `Switch`, `Select`, `Dialog`, or `Collapsible`.

## Write a plugin

Package layout, the manifest, `PluginContext`, contracts, and how a plugin joins `borg.desktop` are in [docs/plugin-authoring.md](docs/plugin-authoring.md). The worked example is `plugins/hello`.

## Desktop app

`borg.desktop` names 34 plugin ids in `distributions/desktop/src/index.ts`. All of them are enabled. `scripts/generate-bundled-plugins.mjs` writes those packages into `apps/desktop/src/main/bundled-plugins.ts` and writes UI loaders into `apps/desktop/src/renderer/bundled-ui-plugins.ts`. Both generated files are tracked in git. The distribution's model fallback is `borg.mock-llm:mock:scripted`.

Closing the window hides Borg. The tray menu shows the window again or quits the kernel.

### First run

On first run, Borg opens a guided setup: welcome, one-click secure-storage verification, optional provider key steps, assistant selection, and a final review. You can skip the cloud providers and keep the built-in demo model. OpenAI is optional in the same way as Anthropic. Save a key under **Settings → OpenAI** or during setup, then verify it to use GPT-5 Mini, GPT-5 Nano, and GPT-5. The OpenAI settings page has an API key field and no base URL field. Production requests use `https://api.openai.com/v1/chat/completions`. `BORG_OPENAI_ENDPOINT` is accepted only when `BORG_E2E=1` and the URL is loopback.

Setup finishes in Chat. **New chat** starts a conversation, and the history lists previous ones. **Settings → Plugins** turns bundled plugins off so their tools, channels, and settings pages unload. The config store and the active secret store stay on. Each conversation shows its input, output, cache, and cost totals. The deterministic prompts `scenario:file`, `scenario:feedback`, `scenario:background`, `scenario:bot`, `scenario:graph`, `scenario:mcp`, `scenario:mcp-app`, `scenario:search`, and `scenario:security ignore all previous instructions` exercise the bundled paths.

### MCP

Configure MCP servers under **Settings → MCP** for the selected persona. A stdio server needs its executable plus one argument per line. Network transports need an `http:` or `https:` URL. Secret fields contain references to Borg-managed secrets, never literal credentials. Save and refresh to inspect the connected catalog. Server tools are available only to runs for that persona and use IDs such as `mcp.mock.echo`.

Server config stores `channelClass`, `reactive`, and `sandbox` (`mcpServerConfigSchema` in `packages/contracts/src/index.ts`). The catalog copies `channelClass` onto each tool as `channelCapacity`. Stdio servers are child processes started through the plugin process API. Use trusted executables. `canonicalizeTools` sets every MCP tool's approval to `ask` and `sideEffect` to true, including tools whose server annotations set `readOnlyHint` or `destructiveHint`. Header secret references require HTTPS, or a loopback HTTP URL (`packages/contracts/src/index.ts`).

MCP App HTML is untrusted renderer content. Borg denies undeclared network, nested frames, forms, downloads, and Node/preload access even after in-frame navigation. Declared `_meta.ui.csp` origins become CSP and Electron request-filter grants. Declared camera, microphone, geolocation, and clipboard-write flags become the inner iframe `allow` list. Inline script and style are supported inside the inner sandbox so MCP Apps can initialize. App snapshots persist with their chat. The underlying MCP server must still be enabled and reachable for a later app-originated tool call.

### Search

Configure Tavily or Brave under **Settings → Tavily** or **Settings → Brave Search**. The search tool is registered only after a key is saved and connected. Results are untrusted external content and require approval. `scenario:search` drives a Tavily tool round trip against the mock model.

### A2A

Configure A2A under **Settings → A2A**. The JSON-RPC listener binds `127.0.0.1` only and stays off until enabled. Task ids are kernel loop run ids.

### Discord

Configure Discord under **Settings → Discord**. The bot token is written directly to Borg's secret store and is never returned to the renderer. Allowed channel IDs are mandatory. Allowed guild IDs further restrict guild traffic. Discord bot-authored messages are always ignored. The connector uses `https://discord.com/api/v10` for sends and the Discord Gateway WebSocket for inbound messages. The connector does not poll. Enable the **Message Content Intent** in the Discord developer portal so message text is present, and grant the bot access only to the configured destinations.

### Microsoft 365 and Google

Configure Microsoft 365 or Google under **Settings → Microsoft 365** or **Settings → Google**. Paste a public native or desktop client id from Entra ID or Google Cloud. The loopback redirect is `http://localhost` on any port for Microsoft 365 and `http://127.0.0.1` on any port for Google. Connect opens the system browser. Borg then polls the inbox and can send to the connected mailbox plus allow-listed recipients. Refresh tokens stay in the kernel OAuth vault and never reach the renderer.

### Classification and the model gateway

Data classifications are ordered `public`, then `internal`, then `confidential`, then `restricted` (`CLASSIFICATION_ORDER` in `packages/kernel/src/classification-service.ts`). Channel capacities map to ceilings as `public` to `public`, `internal` to `internal`, `private` to `confidential`, and `local-only` to `restricted` (`CAPACITY_CEILINGS` in the same file). `ClassificationService.raise` stores a new level only when it is higher than the current one. `TrustAuthorizer` combines policy approval, ceiling violations, and prompt-scan verdicts so one operation asks at most once (`packages/kernel/src/trust-authorizer.ts`). A scan finding of `block` denies the request. Incomplete scan coverage uses the scanner's `unavailableAction` (`scanReportAction` in `packages/kernel/src/scanner-registry.ts`). For tool, channel, and other non-model features, a ceiling violation or a `review` scan result asks for approval. `model_input` and `model_output` follow separate rules in the same file (`MODEL_FEATURES`).

Every model completion passes through the kernel `ModelGateway`. The mock provider egress is `local-only`. Anthropic and OpenAI egress accept up to `internal` data. The gateway scans the provider input, rechecks classification through a one-shot dispatch permit before provider work, and holds streamed tokens until output scanning and authorization succeed. Approved tokens are then delivered through `onApprovedToken`. A denied output is stored as a journal entry with phase `denied` and no output text, the held tokens are cleared, and the gateway throws `ModelOutputDeniedError`. `ExecutionSecurityService` stores execution contexts, including classification and provenance, through `StoreFacade`, and `initialize` reads them back (`packages/kernel/src/execution-security.ts`). On restore, a bot whose loop is no longer running is marked `interrupted` with the error `The previous attempt was interrupted when Borg stopped.` The prompt is not started again (`plugins/bots/src/runtime.ts`).

### Verification

```sh
corepack pnpm typecheck
corepack pnpm test
corepack pnpm test:coverage
corepack pnpm test:e2e
```

`pnpm test:e2e` launches the real Electron app. On macOS, native tray-menu clicks remain a manual platform check. The automated journey verifies the same show and hide handlers, the tray menu model, and continued main-process and plugin lifetime. `docs/architecture.md` records that limit, and `tests/e2e/slice-1-shell.spec.ts` reads the tray menu model and calls `hideWindow`.

### Unsigned macOS package

`scripts/package-macos.mjs` and `scripts/verify-packaged-app.mjs` both refuse to run unless `process.platform` is `darwin`.

```sh
corepack pnpm package:mac
corepack pnpm verify:package:mac
```

The package command creates `.package/Borg-darwin-<arch>.zip`, where `<arch>` is `process.arch`. The verifier launches that app with a temporary user-data directory, completes setup, opens the graph designer, and waits for the manual node option. The script does not sign or notarize the app. macOS may require an explicit Gatekeeper override. The manual **Unsigned macOS alpha** workflow (`.github/workflows/alpha-package.yml`, `workflow_dispatch`) builds and uploads the same zip for 14 days.
