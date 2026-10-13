import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  argvRequestsUserDataDir,
  userDataDirectoryForDistribution,
} from "../src/main/user-data";

const appData = path.join("/tmp", "borg-app-data");

describe("distribution user data", () => {
  it("keeps the reference app on Electron's default profile", () => {
    expect(
      userDataDirectoryForDistribution({
        appData,
        distributionId: "borg.desktop",
        explicitUserDataDir: false,
      }),
    ).toBeUndefined();
  });

  it("gives each other distribution its own directory", () => {
    expect(
      userDataDirectoryForDistribution({
        appData,
        distributionId: "borg.hello-world",
        explicitUserDataDir: false,
      }),
    ).toBe(path.join(appData, "borg.hello-world"));
    expect(
      userDataDirectoryForDistribution({
        appData,
        distributionId: "borg.print-bench",
        explicitUserDataDir: false,
      }),
    ).toBe(path.join(appData, "borg.print-bench"));
  });

  it("leaves an explicit user-data directory alone", () => {
    expect(argvRequestsUserDataDir(["electron", "--user-data-dir=/tmp/e2e"])).toBe(true);
    expect(argvRequestsUserDataDir(["electron", "--user-data-dir", "/tmp/e2e"])).toBe(true);
    expect(argvRequestsUserDataDir(["electron", "-user-data-dir=/tmp/e2e"])).toBe(true);
    expect(argvRequestsUserDataDir(["electron", "."])).toBe(false);
    expect(
      userDataDirectoryForDistribution({
        appData,
        distributionId: "borg.hello-world",
        explicitUserDataDir: true,
      }),
    ).toBeUndefined();
  });

  it("rejects a distribution id that is not a single path segment", () => {
    expect(
      userDataDirectoryForDistribution({
        appData,
        distributionId: "../borg.hello-world",
        explicitUserDataDir: false,
      }),
    ).toBeUndefined();
    expect(
      userDataDirectoryForDistribution({
        appData,
        distributionId: "borg.hello-world/extra",
        explicitUserDataDir: false,
      }),
    ).toBeUndefined();
  });
});
