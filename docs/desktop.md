# Desktop app

The desktop app in `apps/desktop` is the Electron host for the `borg.desktop` distribution. This page has the setup and feature detail. The overview is in the [README](../README.md#desktop-app).

`borg.desktop` names 36 plugin ids in `distributions/desktop/src/index.ts`, including `example.print-bench`. All of them are enabled. `scripts/generate-bundled-plugins.mjs` writes those packages into `apps/desktop/src/main/bundled-plugins.ts` and writes UI loaders into `apps/desktop/src/renderer/bundled-ui-plugins.ts`. Both generated files are tracked in git. The distribution's model fallback is `borg.mock-llm:mock:scripted`.

Closing the window hides Borg. The tray menu shows the window again or quits the kernel.

## First run

On first run, Borg opens a guided setup: welcome, one-click secure-storage verification, optional provider key steps, assistant selection, and a final review. You can skip the cloud providers and keep the built-in demo model. OpenAI is optional in the same way as Anthropic. Save a key under **Settings → OpenAI** or during setup, then verify it to use GPT-5 Mini, GPT-5 Nano, and GPT-5. The OpenAI settings page has an API key field and no base URL field. Production requests use `https://api.openai.com/v1/chat/completions`. `BORG_OPENAI_ENDPOINT` is accepted only when `BORG_E2E=1` and the URL is loopback.

Setup finishes in Chat. **New chat** starts a conversation, and the history lists previous ones. **Settings → Plugins** turns bundled plugins off so their tools, channels, and settings pages unload. The config store and the active secret store stay on. Each conversation shows its input, output, cache, and cost totals. The deterministic prompts `scenario:file`, `scenario:feedback`, `scenario:background`, `scenario:bot`, `scenario:graph`, `scenario:mcp`, `scenario:mcp-app`, `scenario:search`, and `scenario:security ignore all previous instructions` exercise the bundled paths.

## MCP

Configure MCP servers under **Settings → MCP** for the selected persona. A stdio server needs its executable plus one argument per line. Network transports need an `http:` or `https:` URL. Secret fields contain references to Borg-managed secrets, never literal credentials. Save and refresh to inspect the connected catalog. Server tools are available only to runs for that persona and use IDs such as `mcp.mock.echo`.

Server config stores `channelClass`, `reactive`, and `sandbox` (`mcpServerConfigSchema` in `packages/contracts/src/index.ts`). The catalog copies `channelClass` onto each tool as `channelCapacity`. Stdio servers are child processes started through the plugin process API. Use trusted executables. `canonicalizeTools` sets every MCP tool's approval to `ask` and `sideEffect` to true, including tools whose server annotations set `readOnlyHint` or `destructiveHint`. Header secret references require HTTPS, or a loopback HTTP URL (`packages/contracts/src/index.ts`).

MCP App HTML is untrusted renderer content. Borg denies undeclared network, nested frames, forms, downloads, and Node/preload access even after in-frame navigation. Declared `_meta.ui.csp` origins become CSP and Electron request-filter grants. Declared camera, microphone, geolocation, and clipboard-write flags become the inner iframe `allow` list. Inline script and style are supported inside the inner sandbox so MCP Apps can initialize. App snapshots persist with their chat. The underlying MCP server must still be enabled and reachable for a later app-originated tool call.

## Search

Configure Tavily or Brave under **Settings → Tavily** or **Settings → Brave Search**. The search tool is registered only after a key is saved and connected. Results are untrusted external content and require approval. `scenario:search` drives a Tavily tool round trip against the mock model.

## A2A

Configure A2A under **Settings → A2A**. The JSON-RPC listener binds `127.0.0.1` only and stays off until enabled. Task ids are kernel loop run ids.

## Discord

Configure Discord under **Settings → Discord**. The bot token is written directly to Borg's secret store and is never returned to the renderer. Allowed channel IDs are mandatory. Allowed guild IDs further restrict guild traffic. Discord bot-authored messages are always ignored. The connector uses `https://discord.com/api/v10` for sends and the Discord Gateway WebSocket for inbound messages. The connector does not poll. Enable the **Message Content Intent** in the Discord developer portal so message text is present, and grant the bot access only to the configured destinations.

## Microsoft 365 and Google

Configure Microsoft 365 or Google under **Settings → Microsoft 365** or **Settings → Google**. Paste a public native or desktop client id from Entra ID or Google Cloud. The loopback redirect is `http://localhost` on any port for Microsoft 365 and `http://127.0.0.1` on any port for Google. Connect opens the system browser. Borg then polls the inbox and can send to the connected mailbox plus allow-listed recipients. Refresh tokens stay in the kernel OAuth vault and never reach the renderer.

## Classification and the model gateway

Data classifications are ordered `public`, then `internal`, then `confidential`, then `restricted` (`CLASSIFICATION_ORDER` in `packages/kernel/src/classification-service.ts`). Channel capacities map to ceilings as `public` to `public`, `internal` to `internal`, `private` to `confidential`, and `local-only` to `restricted` (`CAPACITY_CEILINGS` in the same file). `ClassificationService.raise` stores a new level only when it is higher than the current one. `TrustAuthorizer` combines policy approval, ceiling violations, and prompt-scan verdicts so one operation asks at most once (`packages/kernel/src/trust-authorizer.ts`). A scan finding of `block` denies the request. Incomplete scan coverage uses the scanner's `unavailableAction` (`scanReportAction` in `packages/kernel/src/scanner-registry.ts`). For tool, channel, and other non-model features, a ceiling violation or a `review` scan result asks for approval. `model_input` and `model_output` follow separate rules in the same file (`MODEL_FEATURES`).

Every model completion passes through the kernel `ModelGateway`. The mock provider egress is `local-only`. Anthropic and OpenAI egress accept up to `internal` data. The gateway scans the provider input, rechecks classification through a one-shot dispatch permit before provider work, and holds streamed tokens until output scanning and authorization succeed. Approved tokens are then delivered through `onApprovedToken`. A denied output is stored as a journal entry with phase `denied` and no output text, the held tokens are cleared, and the gateway throws `ModelOutputDeniedError`. `ExecutionSecurityService` stores execution contexts, including classification and provenance, through `StoreFacade`, and `initialize` reads them back (`packages/kernel/src/execution-security.ts`). On restore, a bot whose loop is no longer running is marked `interrupted` with the error `The previous attempt was interrupted when Borg stopped.` The prompt is not started again (`plugins/bots/src/runtime.ts`).

## Verification

```sh
corepack pnpm typecheck
corepack pnpm test
corepack pnpm test:coverage
corepack pnpm test:e2e
```

`pnpm test:e2e` launches the real Electron app. On macOS, native tray-menu clicks remain a manual platform check. The automated journey verifies the same show and hide handlers, the tray menu model, and continued main-process and plugin lifetime. `docs/architecture.md` records that limit, and `tests/e2e/slice-1-shell.spec.ts` reads the tray menu model and calls `hideWindow`.

## Unsigned macOS package

`scripts/package-macos.mjs` and `scripts/verify-packaged-app.mjs` both refuse to run unless `process.platform` is `darwin`.

```sh
corepack pnpm package:mac
corepack pnpm verify:package:mac
```

The package command creates `.package/Borg-darwin-<arch>.zip`, where `<arch>` is `process.arch`. The verifier launches that app with a temporary user-data directory, completes setup, opens the graph designer, and waits for the manual node option. The script does not sign or notarize the app. macOS may require an explicit Gatekeeper override. The manual **Unsigned macOS alpha** workflow (`.github/workflows/alpha-package.yml`, `workflow_dispatch`) builds and uploads the same zip for 14 days.
