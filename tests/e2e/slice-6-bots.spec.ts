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

function waitForExit(child: ChildProcess, timeoutMs = 3_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const onExit = (): void => {
      clearTimeout(timer);
      child.removeListener("exit", onExit);
      resolve();
    };
    const timer = setTimeout(() => {
      child.removeListener("exit", onExit);
      child.kill("SIGKILL");
      reject(new Error("Electron cleanup timed out"));
    }, timeoutMs);
    child.once("exit", onExit);
    if (child.exitCode !== null || child.signalCode !== null) {
      onExit();
    }
  });
}

async function terminateApplication(
  instance: ElectronApplication | undefined,
): Promise<void> {
  const child = instance?.process();
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exit = waitForExit(child);
  child.kill();
  await exit;
}

async function openBotsWorkspace(): Promise<void> {
  const tab = page.getByTestId("workspace-view-tab-borg.bots.manager");
  await expect(tab).toBeVisible();
  await expect(tab).toHaveText("Bots");
  await tab.click();
  await expect(page.getByTestId("bots-workspace")).toBeVisible();
}

async function createAndStartBot(prompt: string, name: string): Promise<void> {
  await page.getByTestId("bot-name").fill(name);
  await page.getByTestId("bot-launch-prompt").fill(prompt);
  await page.getByTestId("bot-create").click();
  await expect(page.getByTestId("bot-detail-name")).toHaveText(name);
  await page.getByTestId("bot-start").click();
}

async function setWindowVisibility(visible: boolean): Promise<void> {
  const currentApplication = application;
  if (!currentApplication) {
    throw new Error("Electron is not running");
  }
  await currentApplication.evaluate((_, shouldShow) => {
    const api = (
      globalThis as typeof globalThis & {
        __borgTest?: {
          hideWindow(): void;
          showWindow(): void;
        };
      }
    ).__borgTest;
    if (!api) {
      throw new Error("Borg test API is unavailable");
    }
    if (shouldShow) {
      api.showWindow();
    } else {
      api.hideWindow();
    }
  }, visible);
  await expect
    .poll(() =>
      currentApplication.evaluate(() => {
        const api = (
          globalThis as typeof globalThis & {
            __borgTest?: { isWindowVisible(): boolean };
          }
        ).__borgTest;
        return api?.isWindowVisible() ?? false;
      }),
    )
    .toBe(visible);
}

async function trayLabels(): Promise<readonly string[]> {
  return application!.evaluate(() => {
    const api = (
      globalThis as typeof globalThis & {
        __borgTest?: { trayMenuLabels(): readonly string[] };
      }
    ).__borgTest;
    return api?.trayMenuLabels() ?? [];
  });
}

async function trayTitle(): Promise<string> {
  return application!.evaluate(() => {
    const api = (
      globalThis as typeof globalThis & {
        __borgTest?: { trayTitle(): string };
      }
    ).__borgTest;
    return api?.trayTitle() ?? "";
  });
}

test.beforeEach(async () => {
  profileDirectory = mkdtempSync(path.join(tmpdir(), "borg-slice-6-"));
  const launchEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[0] !== "ELECTRON_RUN_AS_NODE" && entry[1] !== undefined,
    ),
  );
  launchEnvironment.BORG_E2E = "1";
  launchEnvironment.ELECTRON_DISABLE_SECURITY_WARNINGS = "true";

  application = await electron.launch({
    executablePath: electronPath,
    args: [desktopApp, `--user-data-dir=${profileDirectory}`],
    env: launchEnvironment,
  });
  page = await application.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await completeSetup(page);
});

test.afterEach(async () => {
  try {
    await terminateApplication(application);
  } finally {
    application = undefined;
    if (profileDirectory) {
      rmSync(profileDirectory, { recursive: true, force: true });
      profileDirectory = undefined;
    }
  }
});

test("starts a bot, hides Borg, and shows the completed bot after reopen", async () => {
  await openBotsWorkspace();
  await createAndStartBot("scenario:bot", "Hidden runner");
  await expect(page.getByTestId("bot-status")).toContainText("Running");
  await page.getByTestId("nav-activity").click();
  await expect
    .poll(async () => page.getByTestId("flightdeck-bot-count").innerText())
    .toBe("1");
  await page.getByTestId("nav-chat").click();
  await openBotsWorkspace();

  await setWindowVisibility(false);
  await expect.poll(trayLabels).toContain("Running bots: 0");
  await expect.poll(trayLabels).toContain("Running tasks: 0");

  await setWindowVisibility(true);
  await expect(page.getByTestId("bot-status")).toHaveText("Completed");
  await expect(page.getByTestId("bot-logs")).toContainText(
    "Bot turn completed while Borg was hidden.",
  );
  await page.getByTestId("nav-activity").click();
  await expect(page.getByTestId("flightdeck-bot-count")).toHaveText("0");
});

test("keeps a hidden bot question in the tray until it is answered", async () => {
  await openBotsWorkspace();
  await createAndStartBot("scenario:feedback", "Asking bot");
  await expect(page.getByTestId("interaction-overlay")).toContainText(
    "What should the mock model do next?",
  );
  await expect(page.getByTestId("bot-status")).toContainText("Waiting for input");

  await setWindowVisibility(false);
  await expect.poll(trayLabels).toContain("Pending interactions: 1");
  await expect.poll(trayTitle).toBe("1");
  await expect.poll(trayLabels).toContain("Running bots: 1");

  await setWindowVisibility(true);
  await expect(page.getByTestId("human-input-interaction")).toBeVisible();
  await page.getByTestId("human-input-text").fill("continue the bot");
  await page.getByTestId("human-input-submit").click();
  await expect(page.getByTestId("interaction-overlay")).toBeHidden();
  await expect(page.getByTestId("bot-status")).toHaveText("Completed");
  await expect(page.getByTestId("bot-logs")).toContainText(
    "User answered: continue the bot",
  );
  await expect.poll(trayLabels).toContain("Pending interactions: 0");
  await expect.poll(trayLabels).toContain("Running bots: 0");
});
