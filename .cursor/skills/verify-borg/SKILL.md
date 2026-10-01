---
name: verify-borg
description: "Drive the Borg desktop Electron app with a disposable profile and the mock LLM. Use to prove setup, chat, graphs, bots, or themes, or when a Borg desktop change needs the real window."
---

# Verify Borg

Prove Borg by launching the desktop app, doing the user action, and reading the resulting screen plus the profile data. The helper is `.cursor/skills/verify-borg/scripts/verify-borg.mjs`. Run it from the repository root.

Requirements.

- Node >= 22.5. The helper imports `node:sqlite`. The repo `engines` field allows Node 22. This skill needs 22.5 or newer.
- pnpm matching `packageManager` in `package.json` (`pnpm@12.0.0`). `corepack pnpm` or `npx pnpm@12.0.0` both select that version. pnpm 9 cannot read this lockfile.
- `pnpm install` and `pnpm build` have already succeeded.
- If doctor reports the Electron binary missing, run `node node_modules/electron/install.js` from the repository root, then launch again.

## Surfaces

The primary surface is the Electron desktop app in `apps/desktop`. It boots `createKernel` with `desktopDistribution` from `@borg/distribution-desktop` (`borg.desktop`).

The headless kernel is the secondary API. `createKernel` and `defineDistribution` live in `@borg/kernel`. `packages/kernel/README.md` and `packages/kernel/test/create-kernel.test.ts` show a Node process that starts the kernel without Electron. Do not point that process at a profile this skill created.

Repo scripts, named so they are not mistaken for this skill.

- `pnpm build`
- `pnpm dev`
- `pnpm start`
- `pnpm typecheck`
- `pnpm test`
- `pnpm test:coverage`
- `pnpm test:e2e`
- `pnpm check:boundaries`
- `pnpm package:mac`
- `pnpm verify:package:mac`
- `pnpm verify:graph-ui`
- `node scripts/run-electron.mjs`
- `node scripts/check-plugin-boundaries.mjs`
- `node scripts/check-editable-for-lists.mjs`
- `node scripts/check-native-form-controls.mjs`
- `node scripts/generate-bundled-plugins.mjs`
- `node scripts/package-macos.mjs`
- `node scripts/verify-graph-designer.mjs`
- `node scripts/verify-packaged-app.mjs`

`pnpm dev`, `pnpm start`, and `node scripts/run-electron.mjs` open Electron on the default user data directory. Never use them for a verification run. `pnpm test:e2e` is the repo's Playwright suite and uses the same `_electron` launch shape this helper uses. It is not a substitute for driving one feature and keeping the artifacts.

## Launch

From the repository root.

```sh
./.cursor/skills/verify-borg/scripts/verify-borg.mjs launch
./.cursor/skills/verify-borg/scripts/verify-borg.mjs launch --display inherit
```

The process returns when the window is up. It prints `ready`, the run id, the electron pid, the supervisor pid, and the profile path. A run id looks like `r…`. The id is stored in `.verify-borg/current`.

What the helper starts.

- A supervisor Node process, recorded as `supervisorPid`.
- Electron with `apps/desktop`, `--user-data-dir` set to a new `mkdtemp` directory under the OS temp dir named `borg-verify-…`, and `BORG_E2E=1`. The Electron environment drops `ELECTRON_RUN_AS_NODE`, every name in the helper's provider-key list (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `AZURE_OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`, `TAVILY_API_KEY`, `BRAVE_API_KEY`), and any `BORG_*_ENDPOINT` override. Those values are not forwarded from the parent shell.
- A private `Xvfb` when `Xvfb` is on `PATH`, even if `DISPLAY` is already set. The window stays off a person's desktop. That pid is `xvfbPid`, and cleanup signals it. Launch prints `display :<n> xvfb pid <pid>`.
- `launch --display inherit` uses the existing `DISPLAY` instead. Use it only when you mean to watch the window on that display. Launch prints `display :<n> inherit`.
- If `Xvfb` is not on `PATH`, launch uses `$DISPLAY` and prints `fallback because Xvfb is not on PATH`.

Do not wrap this helper's launch in `xvfb-run`. `xvfb-run -a ./.cursor/skills/verify-borg/scripts/verify-borg.mjs launch` returns as soon as the window is ready, and `xvfb-run` then tears the display down under Electron. `xvfb-run -a pnpm test:e2e` is fine for the suite, because the suite holds the display until the tests finish.

Ready means the first window fired `domcontentloaded`, `[data-testid=app-shell]` is visible, and `__borgTest.userDataPath()` equals the disposable profile. A fresh profile shows the setup wizard inside that shell.

Two instances can run side by side only with different profile directories. Electron's `requestSingleInstanceLock` is per user data directory. A second process with the same directory quits and focuses the first. This helper always creates a new profile, so a second run is a second profile. Start it with `launch --run-id <id>` while the first is still up, and pass that `--run-id` on every later command. `launch` without `--run-id` refuses to start when `.verify-borg/current` still has a live pid.

## Doctor

Run this before driving, and again whenever the window looks wrong.

```sh
./.cursor/skills/verify-borg/scripts/verify-borg.mjs doctor
```

Exit 0 means this instance is worth driving. The report is printed and copied to `.verify-borg/<run-id>/doctor.txt`. Any `fail` line is exit 1. Do not drive a failing instance.

The check is read-only. It confirms all of the following.

- Desktop, kernel, contracts, plugin-sdk, distribution, and plugin `dist` outputs exist and are newer than the sources that feed them. Renderer output is newer than `apps/desktop/src/renderer`, `packages/ui-kit/src`, and plugin `.tsx` files.
- The Electron binary resolved from `apps/desktop` exists. A missing binary tells you to run `node node_modules/electron/install.js`.
- This machine can show a window. `Xvfb` is on `PATH`, or `DISPLAY` is set.
- The display this run actually used still has a socket. When the run started `Xvfb`, that pid is alive. The report names the display source (`xvfb`, `inherit`, or `fallback`).
- `git rev-parse HEAD` matches the commit recorded at launch.
- The recorded electron pid is alive. `/proc/<pid>/cmdline` contains this repo's `apps/desktop` and this run's profile. `/proc/<pid>/environ` contains `BORG_E2E=1` and `DISPLAY` equal to the display this run started.
- The profile path is the disposable `borg-verify-` directory, not a directory under the home folder.
- `__borgTest.userDataPath()` in the main process equals that profile.
- `borg.mock-llm` is in `__borgTest.activePluginIds()`.

Doctor fails if `/proc/<pid>/environ` still contains a provider key name or a `BORG_*_ENDPOINT` override. A fresh profile has no saved provider credential. Chat proof still requires the `Mock reply:` prefix from `plugins/mock-llm`.

## Drive

Drive the real window. Selectors are `data-testid` values and ARIA names that exist in `apps/desktop/src/renderer` and the plugin `ui.tsx` files. The feature map in `features/` is the recipe. `drive <feature>` runs that recipe.

```sh
./.cursor/skills/verify-borg/scripts/verify-borg.mjs drive setup
./.cursor/skills/verify-borg/scripts/verify-borg.mjs drive chat
./.cursor/skills/verify-borg/scripts/verify-borg.mjs drive graphs
./.cursor/skills/verify-borg/scripts/verify-borg.mjs drive bots
./.cursor/skills/verify-borg/scripts/verify-borg.mjs drive themes
```

`drive setup` fails when the wizard is not on screen. `drive chat`, `drive graphs`, `drive bots`, and `drive themes` finish the wizard first when it is still visible, then run the feature file. They refuse to leave the persona step unless the model value contains `borg.mock-llm`.

Step commands, for a recipe you run yourself after doctor, are listed in Helpers. Pass `--run-id` only when the current file is not the instance you mean.

A proof exercises the visible control, then checks the result on screen and in the profile. Do not call test-only setters. `__borgTest` is for doctor and for the main-process user-data path, not for clicking. Do not call a real model provider. Do not invent an API key. `scenario:` chat prompts in the e2e specs call tools. The mapped chat proof sends `Hello from verification` and expects `Mock reply: Hello from verification`.

`pnpm test:e2e` remains the regression suite. This skill does not replace it.

## Evidence

Artifacts go to `.verify-borg/<run-id>/`, which is gitignored.

- `state.json` records pids, the profile path, the display, and the git commit.
- `actions.jsonl` is one JSON line per command, with the result or the error.
- `doctor.txt` is the last doctor report.
- `evidence/<name>.png` is a screenshot. The page title must be `Borg`.
- `evidence/<name>.aria.txt` is the ARIA snapshot.
- `evidence/<name>.side-effect.json` lists sqlite rows in `plugins/borg.config.sqlite/borg.sqlite3` that contain the expected text, with a short excerpt.
- `evidence/<name>.profile-file.json` records that a profile file exists and its size. It does not copy secret bytes.
- `supervisor.log` is the supervisor's stdout.
- `cleanup.json` records which pids were signalled.

The screenshot and the ARIA snapshot have to show the action's result, not only a shell that loaded. A mutation is proved when the sqlite row or the profile file matches, not only when a status string appears.

## Cleanup

```sh
./.cursor/skills/verify-borg/scripts/verify-borg.mjs cleanup
```

Cleanup asks the supervisor to quit Electron with `app.quit()`, then signals only the pids stored in that run's `state.json` (`electron`, `supervisor`, `xvfb`). It never uses `pkill` or `killall`. It deletes the disposable profile directory. It leaves `.verify-borg/<run-id>/` in place.

Run cleanup after a failed launch or a failed drive so the next attempt does not inherit a live window. Launch already cleans up after its own boot failure.

One sequence that does launch, doctor, drive, and cleanup.

```sh
./.cursor/skills/verify-borg/scripts/verify-borg.mjs run --feature chat
```

Prefer the separate commands when you need the doctor output before the drive.

## Helpers

The helper is executable.

```sh
./.cursor/skills/verify-borg/scripts/verify-borg.mjs launch
./.cursor/skills/verify-borg/scripts/verify-borg.mjs launch --display inherit
./.cursor/skills/verify-borg/scripts/verify-borg.mjs doctor
./.cursor/skills/verify-borg/scripts/verify-borg.mjs drive chat
./.cursor/skills/verify-borg/scripts/verify-borg.mjs cleanup
```

Other commands the feature map uses, all against the current run.

```sh
./.cursor/skills/verify-borg/scripts/verify-borg.mjs click --testid <id>
./.cursor/skills/verify-borg/scripts/verify-borg.mjs click --role <role> --name <name>
./.cursor/skills/verify-borg/scripts/verify-borg.mjs fill --testid <id> --value <text>
./.cursor/skills/verify-borg/scripts/verify-borg.mjs select --testid <id> --value <value>
./.cursor/skills/verify-borg/scripts/verify-borg.mjs expect --testid <id> --contains <text>
./.cursor/skills/verify-borg/scripts/verify-borg.mjs expect --testid <id> --text <exact>
./.cursor/skills/verify-borg/scripts/verify-borg.mjs expect --testid <id> --value <exact>
./.cursor/skills/verify-borg/scripts/verify-borg.mjs expect --testid <id> --contains-value <text>
./.cursor/skills/verify-borg/scripts/verify-borg.mjs expect --testid <id> --count <n>
./.cursor/skills/verify-borg/scripts/verify-borg.mjs expect --selector <css> --count <n>
./.cursor/skills/verify-borg/scripts/verify-borg.mjs expect --attr <key=value> --contains <text>
./.cursor/skills/verify-borg/scripts/verify-borg.mjs verify-dev-storage
./.cursor/skills/verify-borg/scripts/verify-borg.mjs skip-optional-setup --until persona
./.cursor/skills/verify-borg/scripts/verify-borg.mjs skip-optional-setup --until ready
./.cursor/skills/verify-borg/scripts/verify-borg.mjs screenshot --name <name>
./.cursor/skills/verify-borg/scripts/verify-borg.mjs snapshot --aria --name <name> --testid <id> --contains <text>
./.cursor/skills/verify-borg/scripts/verify-borg.mjs side-effect --name <name> --namespace <id> --contains <text>
./.cursor/skills/verify-borg/scripts/verify-borg.mjs profile-file --name <name> --path <relative>
```

Repeat `--contains` when more than one string must match. `--timeout` is milliseconds. The default expect wait is 8 seconds. `select` uses Playwright `selectOption` with `force` because `data-testid` for a themed select sits on the hidden native control.
