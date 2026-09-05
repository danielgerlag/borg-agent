import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "apps/**/test/**/*.test.ts",
      "packages/**/test/**/*.test.ts",
      "plugins/**/test/**/*.test.ts",
    ],
    coverage: {
      include: [
        "apps/**/src/**/*.ts",
        "packages/**/src/**/*.ts",
        "plugins/**/src/**/*.ts",
      ],
      exclude: [
        "**/*.d.ts",
        "**/bundled-plugins.ts",
        "**/bundled-ui-plugins.ts",
      ],
      reporter: ["text", "html"],
      thresholds: {
        statements: 70,
        branches: 65,
        functions: 68,
        lines: 70,
      },
    },
  },
});
