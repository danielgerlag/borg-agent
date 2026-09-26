// Baseline lint config: @eslint/js recommended + typescript-eslint recommended
// (syntax-only, not type-checked). The packages come from @borg/eslint-config,
// which pins typescript 6.0.3 for typescript-eslint because the repo's
// typescript 7 has no JS compiler API. Rules turned off below are listed with
// their baseline violation counts so they can be tightened later.
import { globals, js, tseslint } from "@borg/eslint-config";

export default tseslint.config(
  {
    // Generated or build output; hand-written source is never ignored here.
    ignores: [
      "**/dist/**",
      "**/.package/**",
      "**/node_modules/**",
      "**/bundled-plugins.ts",
      "**/bundled-ui-plugins.ts",
      "**/coverage/**",
      "**/.vite/**",
      "playwright-report/**",
      "test-results/**",
      ".research/**",
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ["**/*.{js,mjs,cjs}", "**/*.config.{mts,cts}"],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    // page.evaluate() callbacks run in the renderer.
    files: ["scripts/verify-graph-designer.mjs"],
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
  },
  {
    rules: {
      // All 20 baseline no-empty hits are deliberate empty `catch {}` blocks.
      "no-empty": ["error", { allowEmptyCatch: true }],
      // All 12 baseline hits are intentionally `_`-prefixed discards.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
        },
      ],
      // Off: 10 violations at baseline. Provider runtimes rethrow without
      // Error.cause; adding cause changes thrown error objects. Tighten later.
      "preserve-caught-error": "off",
      // Off: 7 violations at baseline. Several are `let`s declared before a
      // closure that assigns them; converting needs per-site review. Tighten later.
      "prefer-const": "off",
    },
  },
  {
    files: ["tests/e2e/**/*.ts"],
    rules: {
      // Off for e2e specs: 12 violations at baseline. Playwright specs load the
      // Electron binary path with require(require.resolve("electron")).
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  {
    files: ["packages/contracts/src/index.ts", "packages/kernel/src/tls-service.ts"],
    rules: {
      // Off for these files: 2 violations at baseline. Host and MCP id
      // validators reject control characters on purpose.
      "no-control-regex": "off",
    },
  },
  {
    files: ["packages/kernel/src/tls-service.ts"],
    rules: {
      // Off for this file: 1 violation at baseline. The TLS stream adapter
      // aliases `this` inside ReadableStream/WritableStream callbacks.
      "@typescript-eslint/no-this-alias": "off",
    },
  },
  {
    files: ["plugins/mcp-apps/src/ui.tsx"],
    rules: {
      // Off for this file: 1 violation at baseline. Solid's `ref={frame}`
      // assigns the variable, which the rule cannot see.
      "no-unassigned-vars": "off",
    },
  },
  {
    files: ["plugins/channel-imap/src/imap-codec.ts"],
    rules: {
      // Off for this file: 1 violation at baseline. ImapCodec.#loop is a
      // write-only once-guard for the read loop.
      "no-unused-private-class-members": "off",
    },
  },
);
