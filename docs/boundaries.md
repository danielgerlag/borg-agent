# Boundary checks

These static checks run at the start of every `pnpm build`. They keep the kernel and distributions host-agnostic, keep plugins isolated from each other, and keep plugin UI on `@borg/ui-kit` controls. The rules below are read from the scripts. If this page and a script disagree, the script is what runs.

`pnpm check:boundaries` runs three scripts, in this order. `pnpm build` runs that command first.

```sh
node scripts/check-plugin-boundaries.mjs
node scripts/check-editable-for-lists.mjs
node scripts/check-native-form-controls.mjs
```

`scripts/check-plugin-boundaries.mjs` reads the tree and throws `Plugin boundary check failed:` listing every hit. A clean run prints `Plugin import boundaries are valid.`

**Removed paths.** In `packages/kernel/src`, `apps/desktop/src`, and `plugins/*/src`, the script fails a file that mentions `ModelRouter` or `model-router`, a `provider.complete(` call outside `packages/kernel/src/model-gateway.ts`, or a `cost.record(` call or the string `cost.record`.

**Host process.** For `packages/kernel`, `packages/plugin-sdk`, `packages/contracts`, and each package under `distributions/`, a dependency, peer dependency, or optional dependency on `electron` fails, and a source import of `electron` fails. Kernel packages must stay host-agnostic. Distributions must stay host-agnostic.

**Gateway shape.** `packages/contracts/src/index.ts` must define `modelGatewayRequestSchema` with `executionId: executionIdSchema` and `operationKey: modelOperationKeySchema`. `packages/plugin-sdk/src/index.ts` must type `PluginModels.complete` as `request: Omit<ModelGatewayRequest, "tools">`. A `record(record: UsageRecord)` method on the plugin cost type fails.

**Package import closure.**

- `packages/contracts/src` may import `zod` and relative files inside that directory.
- `packages/kernel/src` and `packages/plugin-sdk/src` may import `@borg-agent/contracts` only as the bare specifier `@borg-agent/contracts`. A capability subpath fails. Those packages may import no `@borg/plugin-*` package other than `@borg-agent/plugin-sdk`. Relative imports must stay inside that package's `src`.
- `packages/kernel`, `packages/plugin-sdk`, and `packages/contracts` must not list or import an `@borg/distribution-*` package. The dependency check covers `dependencies`, `devDependencies`, `peerDependencies`, and `optionalDependencies`.
- A distribution's `src` may import `@borg-agent/kernel`, `zod`, and relative files inside that directory.

**Contracts root.** Every `packages/contracts` export other than `.` must point at `./dist/<name>.js`. The import graph from `packages/contracts/src/index.ts` must not reach `packages/contracts/src/<name>.ts` for any of those subpaths. The subpaths are `./calendar`, `./connector-accounts`, `./contacts`, `./drive`, and `./web-search`.

**Bus definitions.** `defineCommand(` and `defineEvent(` are allowed in `packages/contracts/src`, in `plugins/*/src/contract.ts`, and in three kernel tests that build throwaway definitions: `packages/kernel/test/command-event-bus.test.ts`, `packages/kernel/test/execution-handoff.test.ts`, and `packages/kernel/test/plugin-manager.test.ts`. Any other call under `apps`, `distributions`, `packages`, `plugins`, or `tests` fails. The scan skips `node_modules`, `dist`, and `.d.ts` files.

**Plugin sources.**

- `plugins/graphs` must not import or depend on `langgraph` or `@langchain/langgraph`.
- A plugin source may import another plugin package, other than `@borg-agent/plugin-sdk`, only as `@borg/plugin-<name>/contract`, and `dependencies` must list that package.
- A relative import that resolves inside a different directory under `plugins/` fails.
- `src/contract.ts` may import `zod`, `@borg-agent/contracts`, `@borg-agent/contracts/<subpath>` where the subpath matches `[a-z0-9-]+`, or `@borg/plugin-<name>/contract`.
- If `dependencies`, `devDependencies`, `peerDependencies`, or `optionalDependencies` lists another `@borg/plugin-*` package, some file under that plugin's `src` must import `<package>/contract`.
- A plugin with `src/contract.ts` must export `./contract`. The export target must be `./dist/contract.js`. Exporting `./contract` requires `src/contract.ts`. It also requires the tsconfig named by the package's `build` script (`tsc -p <file>`, or `tsconfig.main.json` if the script names none) to exist and to list `src/contract.ts`, `src/*.ts`, or `src/**/*.ts` in `include`.
- Those plugin-to-plugin contract dependencies must form a DAG. A cycle fails with `plugin dependency cycle:`.

`scripts/check-editable-for-lists.mjs` fails a `<For>` block in `apps/**/*.tsx` or `plugins/**/*.tsx` that contains `onInput`, because `<For>` keys by object identity and remounts the input on each keystroke. `plugins/graphs/src/field-renderer.tsx` is the allowlisted exception.

`scripts/check-native-form-controls.mjs` fails a native `<input>`, `<textarea>`, `<select>`, or `<details>` in those same trees. Allowed `<input>` types are `range`, `color`, `file`, and `hidden`. The script tells you to use `@borg/ui-kit` `TextField`, `Checkbox`, `Switch`, `Select`, `Dialog`, or `Collapsible`.
