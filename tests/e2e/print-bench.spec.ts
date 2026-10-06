import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { completeSetup } from "./setup";

const projectRoot = path.resolve(__dirname, "../..");
const desktopApp = path.join(projectRoot, "apps/desktop");
const electronPath = require(
  require.resolve("electron", { paths: [desktopApp] }),
) as string;

let application: ElectronApplication;
let page: Page;
let profileDirectory: string;

function waitForExit(child: ChildProcess, timeoutMs = 8_000): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Electron process did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function installLaunch(workspace?: string): void {
  test.beforeEach(async () => {
    profileDirectory = mkdtempSync(path.join(tmpdir(), "borg-e2e-print-"));
    const launchEnvironment = Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          entry[0] !== "ELECTRON_RUN_AS_NODE" && entry[1] !== undefined,
      ),
    );
    launchEnvironment.BORG_E2E = "1";
    launchEnvironment.BORG_DISTRIBUTION = "borg.print-bench";
    launchEnvironment.ELECTRON_DISABLE_SECURITY_WARNINGS = "true";
    if (workspace !== undefined) {
      launchEnvironment.BORG_WORKSPACE = workspace;
    }
    application = await electron.launch({
      executablePath: electronPath,
      args: [desktopApp, `--user-data-dir=${profileDirectory}`],
      env: launchEnvironment,
    });
    page = await application.firstWindow();
    await page.waitForLoadState("domcontentloaded");
  });

  test.afterEach(async () => {
    try {
      if (application.process().exitCode === null) {
        const process = application.process();
        const exit = waitForExit(process, 3_000);
        process.kill();
        await exit;
      }
    } catch {
      // Playwright may already have detached after an explicit application quit.
    }
    rmSync(profileDirectory, { recursive: true, force: true });
  });
}

test.describe("design workspace", () => {
  installLaunch();

  test("designs a solid on the desktop design workspace", async () => {
    test.setTimeout(60_000);
    await expect(page.getByTestId("app-shell")).toBeVisible();
    if (await page.getByTestId("surface-wizard").isVisible()) {
      await completeSetup(page, "example.print-bench.design");
    }
    await expect(page.getByTestId("nav-chat")).toHaveCount(0);
    await expect(page.getByTestId("workspace-view-tab-borg.bots.manager")).toHaveCount(0);
    await expect(page.getByTestId("workspace-view-tab-borg.graphs.operations")).toHaveCount(0);
    await page.getByTestId("workspace-view-tab-example.print-bench.design").click();
    await expect(page.getByTestId("print-bench-design-title")).toBeVisible();
    await expect(page.getByTestId("plugin-ui-error")).toHaveCount(0);
    await page.getByTestId("print-bench-tool-box").click();
    await expect(page.getByTestId("print-bench-findings")).not.toContainText("Nothing");
    await page.getByTestId("nav-settings").click();
    await page.getByTestId("settings-section-borg.openai.settings").click();
    await expect(page.getByTestId("openai-setup-step")).toBeVisible();
  });
});

test.describe("print bench launch", () => {
  installLaunch("example.print-bench.design");

  test("opens Design without choosing it from the rail", async () => {
    test.setTimeout(60_000);
    await expect(page.getByTestId("app-shell")).toBeVisible();
    if (await page.getByTestId("surface-wizard").isVisible()) {
      await completeSetup(page, "example.print-bench.design");
    }
    await expect(page.getByTestId("print-bench-design-title")).toBeVisible();
    await expect(page.getByTestId("nav-chat")).toHaveCount(0);
    await expect(page.getByTestId("workspace-view-tab-borg.bots.manager")).toHaveCount(0);
    await expect(page.getByTestId("workspace-view-tab-borg.graphs.operations")).toHaveCount(0);
    await expect(page.getByTestId("plugin-ui-error")).toHaveCount(0);
  });
});
