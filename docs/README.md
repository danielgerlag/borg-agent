# Docs

The product is plugins. Start here if you are adding a feature.

| File | Mode | Use it for |
| --- | --- | --- |
| `architecture.md` | Explanation | Why Borg is a host plus plugins, the inventory, and the kernel boundary |
| `plugin-api.md` | Reference | What a plugin may call on `@borg/plugin-sdk` |
| `../init-spec.md` | Brief | Locked decisions. Do not re-litigate them here |
| `research/hivemind.md` | Research | HiveMind as UX source, not as architecture |

If you want something a user can see, configure, or turn off, write a plugin. Do not add it to `packages/kernel`.
