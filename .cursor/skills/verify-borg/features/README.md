# Borg verification map

This directory is the maintained source for verifying the user-facing behavior of Borg Desktop. Read the index before driving the app, then use the matching feature file as the recipe.

## Baseline preconditions

- Working directory is the repository root.
- Node is >= 22.5. `pnpm` matches `packageManager` in `package.json`. `pnpm install` and `pnpm build` have been run.
- `./.cursor/skills/verify-borg/scripts/verify-borg.mjs launch` has printed `ready`.
- `./.cursor/skills/verify-borg/scripts/verify-borg.mjs doctor` exited 0 for that same run.
- The profile is the disposable `borg-verify-` directory printed by launch. Never point a run at the default Electron user data directory.
- The model on the persona step contains `borg.mock-llm`. Do not type a provider API key.
- Never drive an Electron process this verification run did not start.

## Driving conventions

- Start every recipe from the baseline state unless its preconditions say otherwise.
- Prefer `data-testid` and accessible names over coordinates.
- Treat every command as literal. Keep quoted text and flags unchanged.
- Run window actions through `.cursor/skills/verify-borg/scripts/verify-borg.mjs`.
- Commands apply to the run id in `.verify-borg/current`. Pass `--run-id` when a second instance is up.
- `drive chat`, `drive graphs`, `drive bots`, and `drive themes` finish the setup wizard when it is still on screen, then run the feature file.
- Cleanup removes the process and the disposable profile. It does not remove `.verify-borg/<run-id>/`.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final screen.
- UI proof includes an ARIA snapshot and a screenshot. The page title is `Borg`, and the shell exposes the name Borg.
- Mutation proof includes a read of `borg.sqlite3` or a profile file size, recorded under `evidence/`.
- Record the feature name on the evidence files. `drive <feature>` writes `evidence/<feature>.*`.
- Report an unreachable path with the attempted command and the unmet precondition.
- Do not report a skipped entry point as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with verify-borg` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

Keep implementation details out of the map. Name only user paths, stable handles, required state, commands, and observable proof.

## Features

- [First-run setup](./setup.md) covers the welcome step, local storage check, skipped provider steps, mock persona, and landing in an empty chat.
- [Chat with the mock model](./chat.md) covers sending one message, the mock reply, the saved chat row, and the stored transcript.
- [Graphs](./graphs.md) covers opening the designer, naming a new graph, and saving it.
- [Bots](./bots.md) covers opening the bot manager and creating a bot that has not been started.
- [Appearance](./themes.md) covers switching the shell theme from dark to light and seeing it saved.
