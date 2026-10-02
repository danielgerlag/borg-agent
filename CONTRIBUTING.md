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
pnpm lint            # ESLint (typescript-eslint recommended) over the whole repo
pnpm typecheck       # plugin boundary checks, full build, then tsc for every package and the tests
pnpm test            # build, then the Vitest unit suite
pnpm test:coverage   # the same suite with v8 coverage
pnpm test:e2e        # build, then Playwright against the real Electron app
```

`pnpm test:e2e` needs a display. On Linux without one, run it under `xvfb-run -a pnpm test:e2e`. Electron only renders tray titles on macOS, so the e2e tests assert the tray title there and check the tray tooltip and menu on every platform.

CI (`.github/workflows/ci.yml`) runs on every pull request in two jobs. The macOS job runs install, `lint`, `typecheck`, `test:coverage`, and `test:e2e`. The Linux job runs install, `lint`, `typecheck`, `test`, and `test:e2e` under Xvfb.

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

## Publishing to npm

`.github/workflows/publish.yml` publishes three packages, in this order:

1. `@borg-agent/contracts`
2. `@borg-agent/plugin-sdk` (`@borg-agent/contracts` is a dependency)
3. `@borg-agent/kernel` (both of the others are dependencies)

The npm org `borg` is already registered to someone else, so these packages are named under the org `borg-agent`. That is the name in source, in imports, and on npm. `scripts/publish-npm.mjs` publishes them to `https://registry.npmjs.org`. pnpm replaces each `workspace:*` dependency with the version committed in that package's `package.json`. The root package, the desktop app, and every plugin stay private. A consumer can install `@borg-agent/kernel` after all three versions are on npm.

Run **Publish npm packages** from the Actions tab, on `main`, after CI is green. The workflow publishes the versions already committed in those three files. It skips a package whose version is already on npm. Bump the version in git before you publish again. The workflow does not change versions.

The workflow cannot answer an interactive 2FA prompt. Log in with a granular access token, or with a trusted publisher after the packages exist.

### Granular access token

Use a token for the first publish. npm will not attach a trusted publisher to a package that does not exist yet.

1. Sign in at [npmjs.com](https://www.npmjs.com) and turn on 2FA for the account.
2. Create the npm org `borg-agent` if you do not already own it, and make your account an owner. The scope in `@borg-agent/kernel` is that org. Org membership alone does not let a token publish. Package access is a separate setting on the token.
3. Open your profile menu, then **Access Tokens**, then **Generate New Token**.
4. Check **Bypass two-factor authentication**. A workflow cannot enter a one-time code. Leave **Allowed IP ranges** empty. GitHub-hosted runner addresses change.
5. Under **Packages and scopes**, set the permission to **Read and write (publish and stage)**. Choose **Only select packages and scopes**, and select the `borg-agent` scope. That covers the first publish of these three names. **Read and write (stage only)** cannot run `npm publish`.
6. Set an expiration. Copy the token from the next screen. npm shows the full token only once.
7. In the GitHub repo, open **Settings**, then **Secrets and variables**, then **Actions**, then **New repository secret**. Name it `NPM_TOKEN` and paste the token.

Run the workflow with **auth** set to `token`. The secret is read as `secrets.NPM_TOKEN`. Do not commit the token, do not put it in `.npmrc`, and do not write it into the workflow file.

### Trusted publisher

After the first publish, prefer this login. npm gives that workflow run a short-lived credential. You do not store a token in GitHub.

For each of `@borg-agent/contracts`, `@borg-agent/plugin-sdk`, and `@borg-agent/kernel`:

1. Open the package on npmjs.com and go to **Settings**, then **Trusted Publisher**.
2. Choose **GitHub Actions**.
3. Organization or user: `danielgerlag`
4. Repository: `borg-agent`
5. Workflow filename: `publish.yml` (the file name only, including `.yml`)
6. Leave the environment name empty. This workflow does not use a GitHub environment.
7. Allow `npm publish`. A trusted publisher created after 3 September 2026 can stage a package, and it does not publish directly until you allow `npm publish`.

Run the workflow with **auth** set to `trusted-publisher`. The job needs `id-token: write` and a GitHub-hosted runner. Both are set. npm CLI 11.5.1 or newer exchanges the OIDC token. Node 24 on the runner provides that CLI.

Provenance is attached for a public package published this way from this public repo. When a trusted-publisher run succeeds, revoke the granular token and delete the `NPM_TOKEN` secret.

## Architecture rules

Read `docs/architecture.md` before changing `packages/kernel` or the plugin SDK. A plugin must not import another plugin package except through its `@borg/plugin-<name>/contract` export. `pnpm check:boundaries` enforces this and runs as part of `build`, `typecheck`, and `test`. The full rule list is in [docs/boundaries.md](docs/boundaries.md). Plugin package layout is in [docs/plugin-authoring.md](docs/plugin-authoring.md).

## Commits and pull requests

Use [Conventional Commits](https://www.conventionalcommits.org/) with a scope when one fits, as the history does: `feat(graphs): ...`, `fix(azure): ...`, `docs: ...`, `test(e2e): ...`, `build: ...`, `chore: ...`. Keep each pull request to one focused change, and make sure `pnpm lint`, `pnpm typecheck`, and `pnpm test` pass before you open it.
