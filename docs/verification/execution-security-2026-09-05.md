# Execution security verification

This verification covers the execution-security migration, MCP policy hardening, CI gates, and the unsigned macOS alpha package.

## Commands

```sh
npx --yes pnpm@12.0.0 install --trust-lockfile --frozen-lockfile
npx --yes pnpm@12.0.0 typecheck
npx --yes pnpm@12.0.0 test:coverage
npx --yes pnpm@12.0.0 test:e2e
npx --yes pnpm@12.0.0 package:mac
npx --yes pnpm@12.0.0 verify:package:mac
```

## Results

- Type checking passed.
- All 61 Vitest files passed with 502 tests.
- Coverage passed at 71.09% statements, 66.85% branches, 69.07% functions, and 71.32% lines.
- All 36 Electron tests passed.
- The package command created a 133 MB arm64 macOS archive.
- The packaged application completed setup and rendered the graph designer.

## Limits

- The macOS artifact is unsigned and not notarized.
- Automatic updates are not implemented.
- Coverage thresholds apply to `.ts` source. Electron journeys verify Solid `.tsx` behavior.
