import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { completeSetup } from "./setup";

const projectRoot = path.resolve(__dirname, "../..");
const desktopApp = path.join(projectRoot, "apps/desktop");
const electronPath = require(
  require.resolve("electron", { paths: [desktopApp] }),
) as string;

let application: ElectronApplication | undefined;
let page: Page;
let profileDirectory: string | undefined;

function waitForExit(
  child: ChildProcess,
  timeoutMs = 10_000,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const onExit = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      child.kill();
      reject(new Error("Electron cleanup timed out"));
    }, timeoutMs);
    child.once("exit", onExit);
  });
}

test.beforeEach(async () => {
  profileDirectory = mkdtempSync(path.join(tmpdir(), "borg-plugin-enablement-"));
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[0] !== "ELECTRON_RUN_AS_NODE" && entry[1] !== undefined,
    ),
  );
  environment.BORG_E2E = "1";
  environment.ELECTRON_DISABLE_SECURITY_WARNINGS = "true";
  application = await electron.launch({
    executablePath: electronPath,
    args: [desktopApp, `--user-data-dir=${profileDirectory}`],
    env: environment,
  });
  page = await application.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await completeSetup(page);
});

test.afterEach(async () => {
  try {
    const process = application?.process();
    if (
      process &&
      process.exitCode === null &&
      process.signalCode === null
    ) {
      const exit = waitForExit(process);
      process.kill();
      await exit;
    }
  } finally {
    application = undefined;
    if (profileDirectory) {
      rmSync(profileDirectory, { recursive: true, force: true });
      profileDirectory = undefined;
    }
  }
});

test("disables and re-enables a bundled plugin from Settings", async () => {
  test.setTimeout(60_000);
  await page.getByTestId("nav-settings").click();
  await page.getByTestId("settings-section-system.plugins").click();
  await expect(page.getByTestId("plugins-settings-page")).toBeVisible();
  await expect(page.getByTestId("plugin-enabled-borg.hello")).toBeChecked();

  const disabledLoad = page.waitForEvent("load");
  await page.getByTestId("plugin-enabled-borg.hello").click();
  await disabledLoad;
  await expect(page.getByTestId("plugins-settings-page")).toBeVisible();
  await expect(page.getByTestId("plugin-enabled-borg.hello")).not.toBeChecked();
  await expect(
    page.getByTestId("settings-section-borg.hello.settings"),
  ).toHaveCount(0);

  const enabledLoad = page.waitForEvent("load");
  await page.getByTestId("plugin-enabled-borg.hello").click();
  await enabledLoad;
  await expect(page.getByTestId("plugins-settings-page")).toBeVisible();
  await expect(page.getByTestId("plugin-enabled-borg.hello")).toBeChecked();
});
