# Graphs

Graphs lets a user open the designer, start a new graph, name it, and save it. The saved name shows in the graph list and in the profile database.

## Sub-features

- `graphs-open` opens the designer from the main navigation.
- `graphs-create` starts an untitled graph.
- `graphs-save` stores the name and description the user typed.

## How to get to it (user POV)

- Finish setup, then choose `Graphs` in the main navigation. The button name is Graphs and the test id is `workspace-view-tab-borg.graphs.designer`.

## Driving it with verify-borg

Preconditions:

- `doctor` exited 0 for this run.
- Setup has finished and Chat is visible.
- No graph has been created in this profile.

- **Open Graphs.** Choose Graphs. Run `./.cursor/skills/verify-borg/scripts/verify-borg.mjs click --testid workspace-view-tab-borg.graphs.designer` and `./.cursor/skills/verify-borg/scripts/verify-borg.mjs expect --testid graph-designer`. The designer is visible.
- **Create.** Choose `Create graph`. Run `./.cursor/skills/verify-borg/scripts/verify-borg.mjs click --testid graph-create` and `./.cursor/skills/verify-borg/scripts/verify-borg.mjs expect --testid graph-name --value "Untitled graph"`. The name field reads `Untitled graph`.
- **Name it.** The name field's accessible name is Graph name. Run `./.cursor/skills/verify-borg/scripts/verify-borg.mjs fill --testid graph-name --value "Verify graph"` and `./.cursor/skills/verify-borg/scripts/verify-borg.mjs fill --testid graph-description --value "Saved by verification"`.
- **Save.** Choose Save. Run `./.cursor/skills/verify-borg/scripts/verify-borg.mjs click --testid graph-save` and `./.cursor/skills/verify-borg/scripts/verify-borg.mjs expect --testid graph-designer --contains "Graph saved." --timeout 15000`. The designer says `Graph saved.`
- **See the list.** Run `./.cursor/skills/verify-borg/scripts/verify-borg.mjs expect --testid graph-list --contains "Verify graph"`. The list shows `Verify graph`.
- **Proof.** Run `./.cursor/skills/verify-borg/scripts/verify-borg.mjs screenshot --name graphs` and `./.cursor/skills/verify-borg/scripts/verify-borg.mjs snapshot --aria --name graphs --testid app-shell --contains Borg --contains "Verify graph"`.
- **Stored definition.** Run `./.cursor/skills/verify-borg/scripts/verify-borg.mjs side-effect --name graphs --namespace borg.graphs --contains "Verify graph" --contains "Saved by verification"`. A `borg.graphs` row contains the name and the description.

`./.cursor/skills/verify-borg/scripts/verify-borg.mjs drive graphs` finishes setup when the wizard is up, then runs this list.

## Gotchas

- Choosing Create graph while the open draft is dirty asks the window to confirm. This recipe starts from a profile with no draft. The helper dismisses an unexpected confirm, and the name expect then fails.
- `Graph saved.` is text inside `graph-designer`. It has no test id of its own.
- The list test id includes a generated graph id. Assert the visible name `Verify graph`.
