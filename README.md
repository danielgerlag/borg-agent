# Borg

Borg is a privacy-first local desktop agent platform built as a TypeScript microkernel inside Electron.

The repository currently contains Slice 2: the tray-resident Electron shell, in-process plugin loader, typed command/event bus, SQLite config/store persistence, OS-protected and explicit development secret backends, setup wizard, settings pages, and notifications.

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

Closing the window hides Borg. Use the tray menu to show it again or quit the kernel.

On first run, Borg selects the OS-protected secret backend and opens the setup wizard. Enter a test value to verify protected storage, then complete setup. The Hello settings page demonstrates schema-validated config that persists across application restarts. Automated tests use the explicit plaintext development backend inside an isolated temporary profile.

## Verification

```sh
corepack pnpm typecheck
corepack pnpm test
corepack pnpm test:e2e
```

`pnpm test:e2e` launches the real Electron app. On macOS, native tray-menu clicks remain a manual platform check; the automated journey verifies the same show/hide handlers, tray menu model, and continued main-process/plugin lifetime.

Architecture and research are documented in `docs/architecture.md` and `docs/research/hivemind.md`.
