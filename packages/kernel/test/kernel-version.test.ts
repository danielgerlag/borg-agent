import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  KERNEL_API_VERSION,
  KERNEL_VERSION,
  satisfiesBorgEngine,
} from "../src";

const packageJson = JSON.parse(
  readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../package.json"),
    "utf8",
  ),
) as { readonly version: unknown };

describe("kernel versions", () => {
  it("matches the package version and the 0.1 engine range", () => {
    expect(KERNEL_VERSION).toBe(packageJson.version);
    expect(KERNEL_API_VERSION).toBe("0.1.0");
    expect(satisfiesBorgEngine("^0.1.0", KERNEL_API_VERSION)).toBe(true);
  });
});
