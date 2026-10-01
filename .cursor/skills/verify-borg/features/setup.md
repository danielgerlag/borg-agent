# First-run setup

First-run setup is the wizard a new profile shows before chat. The user confirms local credential storage, skips provider sign-in, keeps the mock model on the default persona, and lands in an empty chat.

## Sub-features

- `setup-welcome` shows the welcome step inside the wizard.
- `setup-storage` verifies the development secret file and reports that storage is ready.
- `setup-skip-providers` moves past optional provider steps without a key.
- `setup-persona` keeps the mock model selected.
- `setup-finish` opens an empty chat and records that the wizard is complete.

## How to get to it (user POV)

- Launch Borg with a profile that has never finished setup. The wizard is the whole window.
- After setup, choose Settings, then `Review setup`. That entry is `settings-run-setup` and is not part of this fresh-profile recipe.

## Driving it with verify-borg

Preconditions:

- `doctor` exited 0 for this run.
- The window is the setup wizard. `[data-testid=surface-wizard]` and `[data-testid=setup-welcome]` are visible.
- No provider API key is entered.

- **See welcome.** The heading reads `Your local AI workspace`. Run `./.cursor/skills/verify-borg/scripts/verify-borg.mjs expect --testid setup-welcome`. The welcome block is visible.
- **Leave welcome.** Choose `Get started`. Run `./.cursor/skills/verify-borg/scripts/verify-borg.mjs click --testid setup-continue`. The development storage step appears.
- **See storage.** Run `./.cursor/skills/verify-borg/scripts/verify-borg.mjs expect --testid dev-secrets-step`. The step title is `Protect your credentials`.
- **Verify storage.** Choose `Verify local storage` when it is enabled. Run `./.cursor/skills/verify-borg/scripts/verify-borg.mjs verify-dev-storage`. The status contains `storage is ready`.
- **Leave storage.** Choose `Continue`. Run `./.cursor/skills/verify-borg/scripts/verify-borg.mjs click --testid setup-continue`. The next step is the persona step or an optional provider step.
- **Skip providers.** Choose `Continue` on each optional provider step. Run `./.cursor/skills/verify-borg/scripts/verify-borg.mjs skip-optional-setup --until persona`. The persona step is visible and no key field was filled.
- **Check the model.** Run `./.cursor/skills/verify-borg/scripts/verify-borg.mjs expect --testid wizard-persona-step` and `./.cursor/skills/verify-borg/scripts/verify-borg.mjs expect --testid wizard-model-select --contains-value borg.mock-llm --timeout 15000`. The model value contains `borg.mock-llm`.
- **Leave the persona.** Choose `Continue`. Run `./.cursor/skills/verify-borg/scripts/verify-borg.mjs click --testid setup-continue`.
- **Skip any later provider steps.** Run `./.cursor/skills/verify-borg/scripts/verify-borg.mjs skip-optional-setup --until ready`. The ready step is visible.
- **Finish.** Choose `Start chatting`. Run `./.cursor/skills/verify-borg/scripts/verify-borg.mjs expect --testid setup-ready` and `./.cursor/skills/verify-borg/scripts/verify-borg.mjs click --testid setup-complete`. The chat workspace is visible.
- **Empty chat.** Run `./.cursor/skills/verify-borg/scripts/verify-borg.mjs expect --testid chat-workspace --timeout 20000` and `./.cursor/skills/verify-borg/scripts/verify-borg.mjs expect --testid chat-empty-state`. The empty state heading is `What can we work on?`.
- **Proof.** Run `./.cursor/skills/verify-borg/scripts/verify-borg.mjs screenshot --name setup` and `./.cursor/skills/verify-borg/scripts/verify-borg.mjs snapshot --aria --name setup --testid app-shell --contains Borg --contains "What can we work on?"`. The page title is `Borg`.
- **Stored wizard.** Run `./.cursor/skills/verify-borg/scripts/verify-borg.mjs side-effect --name setup --namespace system.setup --contains '"wizardCompleted":true'` and `./.cursor/skills/verify-borg/scripts/verify-borg.mjs profile-file --name setup-secrets --path plugins/borg.secrets.dev/secrets.json`. The config row contains `"wizardCompleted":true` and the dev secret file exists. The evidence records the file size, not the secret.

`./.cursor/skills/verify-borg/scripts/verify-borg.mjs drive setup` runs this list.

## Gotchas

- The last step's button test id is `setup-complete`, not `setup-continue`. Its label is `Start chatting`.
- `verify-dev-storage` clicks `dev-secret-save` only when the status does not already contain `ready`. After success the button is disabled.
- Optional steps use `openai-setup-step`, `anthropic-setup-step`, `azure-setup-step`, `copilot-setup-step`, `ollama-setup-step`, and `openrouter-setup-step`. Continue skips them. Do not type a key.
- Stop if `wizard-model-select` does not contain `borg.mock-llm`.
- `secrets.json` holds the storage check secret. Do not copy it into the evidence excerpt.
