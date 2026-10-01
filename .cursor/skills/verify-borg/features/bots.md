# Bots

Bots lets a user open the bot manager and create a named bot with a launch prompt. Creation adds the bot to the list. This recipe does not start it.

## Sub-features

- `bots-open` opens the manager from the main navigation.
- `bots-empty` shows no bots.
- `bots-create` adds one bot and selects it.

## How to get to it (user POV)

- Finish setup, then choose `Bots` in the main navigation. The button name is Bots and the test id is `workspace-view-tab-borg.bots.manager`.

## Driving it with verify-borg

Preconditions:

- `doctor` exited 0 for this run.
- Setup has finished and Chat is visible.
- No bot exists in this profile.

- **Open Bots.** Choose Bots. Run `./.cursor/skills/verify-borg/scripts/verify-borg.mjs click --testid workspace-view-tab-borg.bots.manager` and `./.cursor/skills/verify-borg/scripts/verify-borg.mjs expect --testid bots-workspace`. The manager is visible.
- **See the empty list.** Run `./.cursor/skills/verify-borg/scripts/verify-borg.mjs expect --testid bot-list --contains "No bots yet"`. The list says `No bots yet`.
- **Fill the form.** Name's label is Name. Launch prompt's label is Launch prompt. Run `./.cursor/skills/verify-borg/scripts/verify-borg.mjs fill --testid bot-name --value "Verify bot"` and `./.cursor/skills/verify-borg/scripts/verify-borg.mjs fill --testid bot-launch-prompt --value "Say hello from verification"`.
- **Create.** Choose `Create bot`. Run `./.cursor/skills/verify-borg/scripts/verify-borg.mjs click --testid bot-create`. The detail heading shows the name.
- **See the bot.** Run `./.cursor/skills/verify-borg/scripts/verify-borg.mjs expect --testid bot-detail-name --text "Verify bot" --timeout 15000` and `./.cursor/skills/verify-borg/scripts/verify-borg.mjs expect --testid bot-count --text 1` and `./.cursor/skills/verify-borg/scripts/verify-borg.mjs expect --testid bot-error --count 0`. The count is 1 and there is no error.
- **Proof.** Run `./.cursor/skills/verify-borg/scripts/verify-borg.mjs screenshot --name bots` and `./.cursor/skills/verify-borg/scripts/verify-borg.mjs snapshot --aria --name bots --testid app-shell --contains Borg --contains "Verify bot"`.
- **Stored bot.** Run `./.cursor/skills/verify-borg/scripts/verify-borg.mjs side-effect --name bots --namespace borg.bots --contains "Verify bot" --contains "Say hello from verification"`. A `borg.bots` row contains the name and the prompt.

`./.cursor/skills/verify-borg/scripts/verify-borg.mjs drive bots` finishes setup when the wizard is up, then runs this list.

## Gotchas

- Create does nothing useful when the launch prompt is blank, and `bot-error` says a launch prompt is required.
- The persona menu may still be empty. Create still works without one.
- This recipe does not choose Start. Starting runs the mock model and can open an approval overlay for some prompts.
- The count text is the digit `1`. A later bot would make it `2`.
