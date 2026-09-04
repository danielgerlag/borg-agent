# Borg

Borg is a privacy-first local desktop agent platform built as a TypeScript microkernel inside Electron.

The repository currently contains Slice 8: the tray-resident Electron microkernel, chat-first product experience, persona-backed ReAct runtime, persisted graph workflows, background bots, an optional Anthropic provider, and persona-owned MCP servers. `borg.mcp` connects over stdio, SSE, or Streamable HTTP and exposes each session's server tools through the normal run-scoped tool pipeline. `borg.mcp-apps` renders MCP App results in durable chats through nested sandboxed frames and routes app-originated tool calls back through the same policy, approval, cancellation, and workspace path. The scripted `borg.mock-llm` provider remains the default persona and deterministic CI path.

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

On first run, Borg opens a guided setup: welcome, one-click secure-storage verification, an optional Anthropic key step, assistant selection, and a final review. You can skip Claude and keep the built-in demo model. Setup finishes directly in Chat, where **New chat** and the conversation history use familiar user-facing language. Each conversation shows its input, output, cache, and cost totals. The deterministic prompts `scenario:file`, `scenario:feedback`, `scenario:background`, `scenario:bot`, `scenario:graph`, `scenario:mcp`, and `scenario:mcp-app` exercise the bundled paths.

Configure MCP servers under **Settings → MCP** for the selected persona. A stdio server needs its executable plus one argument per line; network transports need an `http:` or `https:` URL. Secret fields contain references to Borg-managed secrets, never literal credentials. Save and refresh to inspect the connected catalog. Server tools are available only to runs for that persona and use IDs such as `mcp.mock.echo`.

Slice 8 stores `channelClass`, `reactive`, and `sandbox` server metadata for forward compatibility but does not treat those fields as enforcement. Stdio servers run as child processes under the Borg host user; use only trusted executables and rely on the tool approval policy for side effects.

MCP App HTML is untrusted renderer content. Borg denies network requests even after in-frame navigation, nested frames, forms, workers, media, device permissions, downloads, and Node/preload access. Declared app permissions and CSP domains are retained as metadata but are not granted in Slice 8. Inline script and style are supported inside the inner sandbox so MCP Apps can initialize. App snapshots persist with their chat; the underlying MCP server must still be enabled and reachable for a later app-originated tool call.

## Verification

```sh
corepack pnpm typecheck
corepack pnpm test
corepack pnpm test:e2e
```

`pnpm test:e2e` launches the real Electron app. On macOS, native tray-menu clicks remain a manual platform check; the automated journey verifies the same show/hide handlers, tray menu model, and continued main-process/plugin lifetime.

Architecture and research are documented in `docs/architecture.md` and `docs/research/hivemind.md`.
