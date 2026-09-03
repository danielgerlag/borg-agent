# Borg

Borg is a privacy-first local desktop agent platform built as a TypeScript microkernel inside Electron.

The repository currently contains Slice 4: the tray-resident Electron microkernel, persona-backed ReAct runtime, and the first product workspace. The `borg.chat` plugin provides durable sessions, streaming transcripts, sub-agents, feedback in thread, and session workspaces; `borg.tools.core` adds workspace-scoped file reads and approval-gated writes. The scripted `borg.mock-llm` provider keeps the complete product path deterministic and offline.

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

On first run, Borg selects the OS-protected secret backend and opens the setup wizard. Verify protected storage, choose the available default model for the bundled General persona, and complete setup. The Chat workspace then supports normal messages and the deterministic prompts `scenario:file`, `scenario:feedback`, and `scenario:background` for exercising workspace approval, ask-user, and hidden-window execution. Workspace → Loop debugger remains available for lower-level loop inspection. Pending questions and active runs remain in main when the window is hidden and are reflected in the tray and Flight Deck.

## Verification

```sh
corepack pnpm typecheck
corepack pnpm test
corepack pnpm test:e2e
```

`pnpm test:e2e` launches the real Electron app. On macOS, native tray-menu clicks remain a manual platform check; the automated journey verifies the same show/hide handlers, tray menu model, and continued main-process/plugin lifetime.

Architecture and research are documented in `docs/architecture.md` and `docs/research/hivemind.md`.
