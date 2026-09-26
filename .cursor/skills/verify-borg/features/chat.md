# Chat with the mock model

Chat lets a user type a message, send it, and read the mock model's reply in the same thread. The thread then shows up in the chat list and in the profile database.

## Sub-features

- `chat-empty` shows an empty thread and no saved chats.
- `chat-send` sends the composer text with the Send message button.
- `chat-reply` shows the user line and a `Mock reply:` line, then the status `Ready`.
- `chat-saved` lists that chat and stores both lines in the chat rows.

## How to get to it (user POV)

- Finish first-run setup. Borg opens Chat.
- Choose `Chat` in the main navigation. The button name is Chat and the test id is `nav-chat`.

## Driving it with verify-borg

Preconditions:

- `doctor` exited 0 for this run.
- Setup has finished. `[data-testid=chat-workspace]` is visible.
- The thread is empty. `[data-testid=chat-empty-state]` is visible and the list says `No saved chats yet`.
- No message has been sent in this profile.

- **See the empty thread.** Run `./.cursor/skills/verify-borg/scripts/verify-borg.mjs expect --testid chat-empty-state` and `./.cursor/skills/verify-borg/scripts/verify-borg.mjs expect --testid chat-session-list --contains "No saved chats yet"`. The heading is `What can we work on?` and the list has no saved chat.
- **Write the message.** The composer accessible name is Message. Run `./.cursor/skills/verify-borg/scripts/verify-borg.mjs fill --testid chat-composer-input --value "Hello from verification"` and `./.cursor/skills/verify-borg/scripts/verify-borg.mjs expect --testid chat-composer-input --value "Hello from verification"`. The Send message button enables.
- **Send.** Choose Send message. Run `./.cursor/skills/verify-borg/scripts/verify-borg.mjs click --testid chat-send`. The user line appears.
- **Read the reply.** Run `./.cursor/skills/verify-borg/scripts/verify-borg.mjs expect --testid chat-message --attr data-role=user --contains "Hello from verification" --timeout 20000` and `./.cursor/skills/verify-borg/scripts/verify-borg.mjs expect --testid chat-message --attr data-role=assistant --contains "Mock reply: Hello from verification" --timeout 20000`. The assistant line is exactly the mock prefix plus the user text.
- **Wait until ready.** Run `./.cursor/skills/verify-borg/scripts/verify-borg.mjs expect --testid chat-session-status --text Ready --timeout 20000`. The status is `Ready`.
- **See the saved chat.** Run `./.cursor/skills/verify-borg/scripts/verify-borg.mjs expect --testid chat-session-list --contains "Hello from verification"` and `./.cursor/skills/verify-borg/scripts/verify-borg.mjs expect --selector '[data-testid^="chat-session-item-"]' --count 1`. One chat row shows the message title.
- **No plugin error.** Run `./.cursor/skills/verify-borg/scripts/verify-borg.mjs expect --testid plugin-ui-error --count 0`.
- **Proof.** Run `./.cursor/skills/verify-borg/scripts/verify-borg.mjs screenshot --name chat` and `./.cursor/skills/verify-borg/scripts/verify-borg.mjs snapshot --aria --name chat --testid app-shell --contains Borg --contains "Hello from verification" --contains "Mock reply: Hello from verification"`. The artifacts show Borg, the user line, and the mock reply.
- **Stored transcript.** Run `./.cursor/skills/verify-borg/scripts/verify-borg.mjs side-effect --name chat --namespace borg.chat --contains "Hello from verification" --contains "Mock reply: Hello from verification"`. A `borg.chat` row contains both strings.

`./.cursor/skills/verify-borg/scripts/verify-borg.mjs drive chat` finishes setup when the wizard is up, then runs this list.

## Gotchas

- Send message stays disabled until the composer has non-whitespace text. The accessible name is `Send message` while idle and `Sending message` while a send is in flight.
- Enter in the composer sends. The recipe clicks `chat-send` so the key is not required.
- A new chat row appears only after the first message. `chat-new-session` does not add one by itself.
- The list title is the first message, cut at 48 characters. `Hello from verification` fits.
- Any assistant text that does not start with `Mock reply:` means this was not the mock model. Stop.
- Do not send `scenario:` prompts here. Those ask for tool approval and are a different path.
- The streaming row is temporary. Assert the final assistant message.
