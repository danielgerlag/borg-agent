# Appearance

Appearance lets a user switch the shell between dark and light. Light is saved on the profile and applied to the page immediately.

## Sub-features

- `themes-open` opens Appearance from Settings.
- `themes-default` shows that dark is the current theme.
- `themes-light` saves light and applies it.

## How to get to it (user POV)

- Finish setup, choose `Settings` in the main navigation, then choose `Appearance`.
- Settings is `nav-settings`. Appearance is `settings-section-borg.themes.settings`.

## Driving it with verify-borg

Preconditions:

- `doctor` exited 0 for this run.
- Setup has finished and Chat is visible.
- The theme has not been changed in this profile.

- **Open Settings.** Choose Settings. Run `./.cursor/skills/verify-borg/scripts/verify-borg.mjs click --testid nav-settings` and `./.cursor/skills/verify-borg/scripts/verify-borg.mjs expect --testid surface-settings`. The settings heading is `Make Borg yours`.
- **Open Appearance.** Choose Appearance. Run `./.cursor/skills/verify-borg/scripts/verify-borg.mjs click --testid settings-section-borg.themes.settings` and `./.cursor/skills/verify-borg/scripts/verify-borg.mjs expect --testid themes-settings-page`. The page title is Appearance.
- **See the default.** Run `./.cursor/skills/verify-borg/scripts/verify-borg.mjs expect --testid themes-status --contains "Dark is the default."`. The status says `Dark is the default.`
- **Choose light.** The control's label is Theme. Run `./.cursor/skills/verify-borg/scripts/verify-borg.mjs select --testid themes-select --value light`.
- **Save.** Choose Save. Run `./.cursor/skills/verify-borg/scripts/verify-borg.mjs click --testid themes-save` and `./.cursor/skills/verify-borg/scripts/verify-borg.mjs expect --testid themes-status --text "Light theme saved." --timeout 15000`. The status is `Light theme saved.`
- **See the applied theme.** Run `./.cursor/skills/verify-borg/scripts/verify-borg.mjs expect --selector 'html[data-theme="light"]' --count 1`. The document theme is light.
- **Proof.** Run `./.cursor/skills/verify-borg/scripts/verify-borg.mjs screenshot --name themes` and `./.cursor/skills/verify-borg/scripts/verify-borg.mjs snapshot --aria --name themes --testid app-shell --contains Borg --contains "Light theme saved."`.
- **Stored theme.** Run `./.cursor/skills/verify-borg/scripts/verify-borg.mjs side-effect --name themes --namespace borg.themes --contains '"light"'`. The `borg.themes` config contains `"light"`.

`./.cursor/skills/verify-borg/scripts/verify-borg.mjs drive themes` finishes setup when the wizard is up, then runs this list.

## Gotchas

- `themes-select` is the hidden native select. Use `select`, not `click`. The visible widget does not own the test id.
- The Save label changes to `Saving…` while the write is in flight. Assert `Light theme saved.` after it finishes.
- Dark is the default. A profile that already saved light will not show `Dark is the default.`
