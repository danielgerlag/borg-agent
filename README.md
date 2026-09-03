# Borg

Borg is a privacy-first local desktop agent platform built as a TypeScript microkernel inside Electron.

The repository currently contains Slice 3: the tray-resident Electron shell and plugin runtime from Slices 1–2, plus the kernel ReAct loop, model router, tool approval pipeline, interaction queue, and cost ledger. Scripted `borg.mock-llm`, `borg.tools.echo`, and `borg.feedback` plugins provide a debug workspace for approval and ask-user journeys before chat arrives in Slice 4.

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

On first run, Borg selects the OS-protected secret backend and opens the setup wizard. Enter a test value to verify protected storage, then complete setup. Open Workspace → Loop debugger to run the tool-approval and ask-user scenarios. Pending questions remain in the main-process queue when the window is hidden and are reflected in the tray.

## Verification

```sh
corepack pnpm typecheck
corepack pnpm test
corepack pnpm test:e2e
```

`pnpm test:e2e` launches the real Electron app. On macOS, native tray-menu clicks remain a manual platform check; the automated journey verifies the same show/hide handlers, tray menu model, and continued main-process/plugin lifetime.

Architecture and research are documented in `docs/architecture.md` and `docs/research/hivemind.md`.
