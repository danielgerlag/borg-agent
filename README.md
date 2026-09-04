# Borg

Borg is a privacy-first local desktop agent platform built as a TypeScript microkernel inside Electron.

The repository currently contains Slice 7: the tray-resident Electron microkernel, chat-first product experience, persona-backed ReAct runtime, persisted graph workflows, background bots, and an optional Anthropic provider. The `borg.chat` plugin provides durable conversations, streaming replies, delegated sub-agents, feedback in thread, scoped files, and per-chat token/cost totals. `borg.graphs` adds a Cytoscape designer, a HiveMind-inspired executor, scheduled and inbound triggers, feedback gates, agent/tool/prompt steps, and Activity state. `borg.bots` creates background agents from a persona and launch prompt, starts and stops them through the same kernel loop runtime, keeps logs, and stays visible in Activity and the tray after the window is hidden. `borg.anthropic` can be connected from setup or Settings with a saved API key and no secret readback; Claude models then appear in the existing assistant picker. `borg.usage` shows this Borg session's aggregate tokens and cost on Activity. The scripted `borg.mock-llm` provider remains the default persona and the deterministic CI path.

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

On first run, Borg opens a guided setup: welcome, one-click secure-storage verification, an optional Anthropic key step, assistant selection, and a final review. You can skip Claude and keep the built-in demo model. Setup finishes directly in Chat, where **New chat** and the conversation history use familiar user-facing language. Each conversation shows its input, output, cache, and cost totals. The deterministic prompts `scenario:file`, `scenario:feedback`, `scenario:background`, `scenario:bot`, and `scenario:graph` exercise file approval, ask-user, hidden-window execution, background bots, and chat-launched workflows. Open the **Graphs** workspace tab to design and run workflows, or **Bots** to create a background agent. Activity shows running graphs and bots alongside this Borg session's token and cost totals and requests that need attention. The tray reports pending interactions, running tasks, and running bots. Settings includes Anthropic key management and an Advanced area for the loop debugger and implementation diagnostics. Pending questions and active work remain in main when the window is hidden.

## Verification

```sh
corepack pnpm typecheck
corepack pnpm test
corepack pnpm test:e2e
```

`pnpm test:e2e` launches the real Electron app. On macOS, native tray-menu clicks remain a manual platform check; the automated journey verifies the same show/hide handlers, tray menu model, and continued main-process/plugin lifetime.

Architecture and research are documented in `docs/architecture.md` and `docs/research/hivemind.md`.
