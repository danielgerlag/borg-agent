# Contributing to Borg

## Prerequisites

- Node.js 22 or newer. CI runs Node 24.
- pnpm 12.0.0. The version is pinned in the root `package.json` under `packageManager`. Run it through Corepack (`corepack pnpm ...`) or through npm (`npx --yes pnpm@12.0.0 ...`). The commands below say `pnpm` for short.

## Install

```sh
pnpm install --frozen-lockfile
```

`--frozen-lockfile` fails when `pnpm-lock.yaml` no longer matches the manifests. Drop the flag only when you are intentionally changing dependencies, and commit the updated lockfile with that change.

Electron 44 has no postinstall step. It downloads its binary the first time something asks for it. To fetch it up front, or if an Electron command reports that Electron failed to install, run:

```sh
node node_modules/electron/install.js
```

## Verify

```sh
pnpm typecheck       # plugin boundary checks, full build, then tsc for every package and the tests
pnpm test            # build, then the Vitest unit suite
pnpm test:coverage   # the same suite with v8 coverage
pnpm test:e2e        # build, then Playwright against the real Electron app
```

`pnpm test:e2e` needs a display. On Linux without one, run it under `xvfb-run -a pnpm test:e2e`. Electron only renders tray titles on macOS, so the e2e tests assert the tray title there and check the tray tooltip and menu on every platform.

CI (`.github/workflows/ci.yml`) runs on every pull request in two jobs. The macOS job runs install, `typecheck`, `test:coverage`, and `test:e2e`. The Linux job runs install, `typecheck`, `test`, and `test:e2e` under Xvfb.

## Installing behind a corporate or private npm feed

The committed lockfile is registry-agnostic. Its entries carry only a package name, a version, and a `sha512` integrity hash. There are no tarball URLs and no registry host in it. pnpm downloads each tarball from whatever registry your configuration names and rejects any tarball whose bytes do not match the locked hash. A feed that mirrors the public npm registry serves the same bytes, so it installs the same dependency tree.

Point pnpm at your feed in your user-level config, not in this repository:

```ini
# ~/.npmrc
registry=https://your-feed.example.com/npm/registry/
//your-feed.example.com/npm/registry/:_authToken=${YOUR_FEED_TOKEN}
```

For a single run, pass the registry on the command line instead:

```sh
pnpm install --frozen-lockfile --registry https://your-feed.example.com/npm/registry/
```

Rules for contributors:

- Never commit a private registry URL, a project-level `.npmrc` that names one, or an auth token.
- Never commit a lockfile generated against a private feed. When you change dependencies, regenerate the lockfile against the public registry:
  ```sh
  pnpm install --registry https://registry.npmjs.org/
  ```
- Before you push, confirm the lockfile names no private host. This must print nothing:
  ```sh
  rg -i 'tarball:|pkgs\.dev|visualstudio\.com|_packaging' pnpm-lock.yaml
  ```

## Architecture rules

Read `docs/architecture.md` before changing `packages/kernel` or the plugin SDK. A plugin must not import another plugin package except through its `@borg/plugin-<name>/contract` export. `pnpm check:boundaries` enforces this and runs as part of `build`, `typecheck`, and `test`. The full rule list is in [docs/boundaries.md](docs/boundaries.md). Plugin package layout is in [docs/plugin-authoring.md](docs/plugin-authoring.md).

## Commits and pull requests

Use [Conventional Commits](https://www.conventionalcommits.org/) with a scope when one fits, as the history does: `feat(graphs): ...`, `fix(azure): ...`, `docs: ...`, `test(e2e): ...`, `build: ...`, `chore: ...`. Keep each pull request to one focused change, and make sure `pnpm typecheck` and `pnpm test` pass before you open it.
