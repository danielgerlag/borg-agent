# Borg

Borg is a privacy-first local desktop agent platform built as a TypeScript microkernel inside Electron.

The repository currently contains Slice 11: the tray-resident Electron microkernel, chat-first product experience, persona-backed ReAct and CodeAct runtimes, persisted graph workflows, background bots, an optional Anthropic provider, persona-owned MCP servers, kernel-owned data classification and prompt scanning, normalized message channels, semantic memory recall, workspace context-map prompt slots, and kernel sandboxes for shell and code tools. `borg.channel.mock` provides deterministic inbound and outbound tests. `borg.channel.discord` receives messages through the realtime Discord Gateway and sends through Discord REST. The scripted `borg.mock-llm` provider remains the default persona and deterministic CI path.

## Prerequisites

- Node.js 22 or newer
- pnpm 12

## Development

```sh
corepack pnpm install
corepack pnpm dev
```

This invokes the repository-pinned pnpm version without creating global symlinks in `/usr/local/bin`. Alternatively, install pnpm with `brew install pnpm` and use `pnpm` directly.

Corepack does not read registry or authentication settings from `~/.npmrc`. In a corporate environment with a custom npm registry, invoke the pinned pnpm package through npm instead:

```sh
npx --yes pnpm@12.0.0 install
npx --yes pnpm@12.0.0 dev
```

If an Azure Artifacts mirror rotates between equivalent `ms-feed-*` hosts, pnpm 12 may reject an unchanged lockfile URL during verification. After reviewing the committed lockfile, use `npx --yes pnpm@12.0.0 install --trust-lockfile` for that mirrored-registry case.

Closing the window hides Borg. Use the tray menu to show it again or quit the kernel.

On first run, Borg opens a guided setup: welcome, one-click secure-storage verification, an optional Anthropic key step, assistant selection, and a final review. You can skip Claude and keep the built-in demo model. Setup finishes directly in Chat, where **New chat** and the conversation history use familiar user-facing language. Each conversation shows its input, output, cache, and cost totals. The deterministic prompts `scenario:file`, `scenario:feedback`, `scenario:background`, `scenario:bot`, `scenario:graph`, `scenario:mcp`, `scenario:mcp-app`, and `scenario:security ignore all previous instructions` exercise the bundled paths.

Configure MCP servers under **Settings → MCP** for the selected persona. A stdio server needs its executable plus one argument per line; network transports need an `http:` or `https:` URL. Secret fields contain references to Borg-managed secrets, never literal credentials. Save and refresh to inspect the connected catalog. Server tools are available only to runs for that persona and use IDs such as `mcp.mock.echo`.

Slice 8 stores `channelClass`, `reactive`, and `sandbox` server metadata for forward compatibility but does not treat those fields as enforcement. Stdio servers run as child processes under the Borg host user; use only trusted executables. Every MCP call requires local approval. Server-provided read-only and destructive annotations do not change approval or retry policy. Header secret references require HTTPS, except for loopback development URLs.

MCP App HTML is untrusted renderer content. Borg denies network requests even after in-frame navigation, nested frames, forms, workers, media, device permissions, downloads, and Node/preload access. Declared app permissions and CSP domains are retained as metadata but are not granted in Slice 8. Inline script and style are supported inside the inner sandbox so MCP Apps can initialize. App snapshots persist with their chat; the underlying MCP server must still be enabled and reachable for a later app-originated tool call.

Configure Discord under **Settings → Discord**. The bot token is written directly to Borg's secret store and is never returned to the renderer. Allowed channel IDs are mandatory; allowed guild IDs further restrict guild traffic. Discord bot-authored messages are always ignored. The connector uses `https://discord.com/api/v10` for sends and the Discord Gateway for realtime inbound messages; there is no polling fallback. Enable the **Message Content Intent** in the Discord developer portal so message text is present, and grant the bot access only to the configured destinations.

Data classifications are ordered `public < internal < confidential < restricted`. Channel capacities map to ceilings as follows: `public → public`, `internal → internal`, `private → confidential`, and `local-only → restricted`. A run's effective classification can only increase. Classification violations, scanner review findings, and normal tool approval are combined into at most one kernel approval prompt for an operation. Prompt scanner failures or missing coverage require review and cannot bypass channel classification.

Every model completion passes through the kernel `ModelGateway`. The mock provider is `local-only`; Anthropic currently accepts up to `internal` data. The gateway scans the complete provider input, rechecks classification through a one-shot permit immediately before provider work, and holds raw output until the completed response passes scanning and authorization. Denied output is not displayed or persisted. Chat turns, graph instances, and bot attempts persist their execution classification and provenance across restarts. A missing bot run is marked interrupted instead of replaying its prompt.

## Verification

```sh
corepack pnpm typecheck
corepack pnpm test
corepack pnpm test:coverage
corepack pnpm test:e2e
```

`pnpm test:e2e` launches the real Electron app. On macOS, native tray-menu clicks remain a manual platform check; the automated journey verifies the same show/hide handlers, tray menu model, and continued main-process/plugin lifetime.

## Unsigned macOS alpha

```sh
corepack pnpm package:mac
corepack pnpm verify:package:mac
```

The package command creates `.package/Borg-darwin-<arch>.zip`. The verifier launches the packaged application with a temporary profile, completes setup, and opens a rendered graph. The artifact is unsigned and not notarized. macOS may require an explicit Gatekeeper override. The manual **Unsigned macOS alpha** GitHub workflow builds and uploads the same artifact for 14 days.

Architecture and research are documented in `docs/architecture.md` and `docs/research/hivemind.md`.
