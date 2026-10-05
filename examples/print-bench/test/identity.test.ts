import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { preparePrintBenchHost, printBenchAppName } from "../src/identity.js";

function host(root: string) {
  const calls: string[] = [];
  const paths = {
    userData: join(root, printBenchAppName),
    appData: root,
  };
  return {
    calls,
    paths,
    application: {
      setName(name: string) {
        calls.push(`name:${name}`);
      },
      setPath(name: string, folder: string) {
        calls.push(`path:${name}`);
        if (name === "userData") {
          paths.userData = folder;
        }
      },
      getPath(name: "userData" | "appData") {
        calls.push(`get:${name}`);
        return paths[name];
      },
    },
  };
}

describe("print bench process identity", () => {
  it("names the process and leaves an isolated home on the given folder", () => {
    const { application, calls, paths } = host(mkdtempSync(join(tmpdir(), "print-bench-id-")));
    preparePrintBenchHost(application, { BORG_PRINT_BENCH_HOME: "  /tmp/bench-home  " });
    expect(calls).toEqual([`name:${printBenchAppName}`, "path:userData"]);
    expect(paths.userData).toBe("/tmp/bench-home");
  });

  it("treats a blank home as a normal launch", () => {
    const root = mkdtempSync(join(tmpdir(), "print-bench-id-"));
    const { application, calls } = host(root);
    preparePrintBenchHost(application, { BORG_PRINT_BENCH_HOME: "   " });
    expect(calls[0]).toBe(`name:${printBenchAppName}`);
    expect(calls).not.toContain("path:userData");
  });

  it("copies plugins out of the Electron folder once", () => {
    const root = mkdtempSync(join(tmpdir(), "print-bench-id-"));
    const legacy = join(root, "Electron", "plugins", "borg.config.sqlite");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "borg.sqlite3"), "saved");
    const { application, paths } = host(root);
    preparePrintBenchHost(application, {});
    expect(readFileSync(join(paths.userData, "plugins", "borg.config.sqlite", "borg.sqlite3"), "utf8")).toBe(
      "saved",
    );
    writeFileSync(join(legacy, "borg.sqlite3"), "changed");
    preparePrintBenchHost(application, {});
    expect(readFileSync(join(paths.userData, "plugins", "borg.config.sqlite", "borg.sqlite3"), "utf8")).toBe(
      "saved",
    );
  });
});
