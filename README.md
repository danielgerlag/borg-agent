# Borg

Borg is a privacy-first local desktop agent platform built as a TypeScript microkernel inside Electron.

The repository currently contains Slice 4: the tray-resident Electron microkernel, persona-backed ReAct runtime, and the first chat-first product experience. The `borg.chat` plugin provides durable conversations, streaming replies, delegated sub-agents, feedback in thread, and scoped files; `borg.tools.core` adds workspace-scoped file reads and approval-gated writes. The scripted `borg.mock-llm` provider keeps the complete product path deterministic and offline.

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

On first run, Borg opens a guided setup: welcome, one-click secure-storage verification, assistant selection, and a final review. Setup finishes directly in Chat, where **New chat** and the conversation history use familiar user-facing language. The deterministic prompts `scenario:file`, `scenario:feedback`, and `scenario:background` exercise file approval, ask-user, and hidden-window execution. Settings includes an Advanced area for the loop debugger and implementation diagnostics, while Activity shows running work and requests that need attention. Pending questions and active work remain in main when the window is hidden and are reflected in the tray.

## Verification

```sh
corepack pnpm typecheck
corepack pnpm test
corepack pnpm test:e2e
```

`pnpm test:e2e` launches the real Electron app. On macOS, native tray-menu clicks remain a manual platform check; the automated journey verifies the same show/hide handlers, tray menu model, and continued main-process/plugin lifetime.

Architecture and research are documented in `docs/architecture.md` and `docs/research/hivemind.md`.
