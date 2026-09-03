import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
let launchEnvironment: Record<string, string>;

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

async function launchBorg(): Promise<void> {
  application = await electron.launch({
    executablePath: electronPath,
    args: [desktopApp, `--user-data-dir=${profileDirectory}`],
    env: launchEnvironment,
  });
  page = await application.firstWindow();
  await page.waitForLoadState("domcontentloaded");
}

async function ensureSetup(): Promise<void> {
  await expect(page.getByTestId("app-shell")).toBeVisible();
  if (await page.getByTestId("surface-wizard").isVisible()) {
    await completeSetup(page);
  }
  await expect(page.getByTestId("chat-workspace")).toBeVisible();
}

async function enterDeveloperTool(
  kind: "workspace" | "settings" | "widget",
  contributionId: string,
): Promise<void> {
  await ensureSetup();
  await page.getByTestId("nav-settings").click();
  await page.getByTestId("settings-developer-tools").click();
  await page.getByTestId(`developer-tool-${kind}-${contributionId}`).click();
}

async function enterLoopDebugger(): Promise<void> {
  await enterDeveloperTool("workspace", "borg.mock-llm.debug");
  await expect(page.getByTestId("loop-debug-workspace")).toBeVisible();
}

test.beforeEach(async () => {
  profileDirectory = mkdtempSync(path.join(tmpdir(), "borg-e2e-"));
  launchEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[0] !== "ELECTRON_RUN_AS_NODE" && entry[1] !== undefined,
    ),
  );
  launchEnvironment.BORG_E2E = "1";
  launchEnvironment.ELECTRON_DISABLE_SECURITY_WARNINGS = "true";
  await launchBorg();
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

test("loads the hello plugin through the main-process command bus", async () => {
  await expect(page.getByTestId("app-shell")).toBeVisible();
  await enterDeveloperTool("widget", "borg.hello.kernel-status");
  await expect(page.getByTestId("hello-widget")).toBeVisible();
  await expect(page.getByTestId("hello-status-alive")).toContainText("Kernel alive");
  await expect(page.getByTestId("hello-status-alive")).toContainText("borg.hello");
  await expect(page.getByTestId("plugin-ui-error")).toHaveCount(0);
});

test("does not expose reusable renderer plugin identities", async () => {
  const results = await page.evaluate(async () => {
    const capture = async (operation: () => Promise<unknown>): Promise<string> => {
      try {
        await operation();
        return "unexpected success";
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    };
    window.location.hash = "bootstrap-replay";
    await new Promise((resolve) => setTimeout(resolve, 0));
    return Promise.all([
      capture(() => window.borg.kernel.bootstrap()),
      capture(() => window.borg.config.get("borg.hello")),
      capture(() =>
        window.borg.window.hide("00000000-0000-0000-0000-000000000000"),
      ),
    ]);
  });

  expect(results[0]).toContain("already been consumed");
  expect(results[1]).toContain("Invalid UUID");
  expect(results[2]).toContain("shell capability is invalid");
});

test("keeps the kernel and plugin active while the window is hidden", async () => {
  await ensureSetup();
  const trayLabels = await application.evaluate(() => {
    const api = (
      globalThis as typeof globalThis & {
        __borgTest?: { trayMenuLabels(): readonly string[] };
      }
    ).__borgTest;
    return api?.trayMenuLabels() ?? [];
  });
  expect(trayLabels).toEqual(
    expect.arrayContaining([
      "Show Borg",
      "Hide Borg",
      "Pending interactions: 0",
      "Running tasks: 0",
      "Quit Borg",
    ]),
  );
  await expect(
    application.evaluate(() => {
      const api = (
        globalThis as typeof globalThis & {
          __borgTest?: { trayIconIsEmpty(): boolean };
        }
      ).__borgTest;
      return api?.trayIconIsEmpty() ?? true;
    }),
  ).resolves.toBe(false);

  await application.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.close();
  });

  await expect
    .poll(() =>
      application.evaluate(() => {
        const api = (
          globalThis as typeof globalThis & {
            __borgTest?: { isWindowVisible(): boolean };
          }
        ).__borgTest;
        return api?.isWindowVisible() ?? true;
      }),
    )
    .toBe(false);

  await expect(
    application.evaluate(() => {
      const api = (
        globalThis as typeof globalThis & {
          __borgTest?: { activePluginIds(): readonly string[] };
        }
      ).__borgTest;
      return api?.activePluginIds() ?? [];
    }),
  ).resolves.toContain("borg.hello");
  const hiddenStatus = await page.evaluate(() =>
    window.borg.command.invoke("borg.hello.getStatus", {}),
  );
  expect(hiddenStatus).toMatchObject({
    pluginId: "borg.hello",
    status: "alive",
  });

  await application.evaluate(() => {
    const api = (
      globalThis as typeof globalThis & {
        __borgTest?: { showWindow(): void };
      }
    ).__borgTest;
    api?.showWindow();
  });

  await expect(page.getByTestId("app-shell")).toBeVisible();
  await expect(page.getByTestId("chat-workspace")).toBeVisible();
});

test("shows the existing window when a second instance is launched", async () => {
  await expect
    .poll(() =>
      application.evaluate(() => {
        const api = (
          globalThis as typeof globalThis & {
            __borgTest?: {
              hideWindow(): void;
              isWindowVisible(): boolean;
            };
          }
        ).__borgTest;
        api?.hideWindow();
        return api?.isWindowVisible() ?? true;
      }),
    )
    .toBe(false);

  const secondInstance = spawn(
    electronPath,
    [desktopApp, `--user-data-dir=${profileDirectory}`],
    {
      env: launchEnvironment,
      stdio: "ignore",
    },
  );
  await expect(waitForExit(secondInstance)).resolves.toBe(0);
  await expect
    .poll(() =>
      application.evaluate(() => {
        const api = (
          globalThis as typeof globalThis & {
            __borgTest?: { isWindowVisible(): boolean };
          }
        ).__borgTest;
        return api?.isWindowVisible() ?? false;
      }),
    )
    .toBe(true);
});

test("completes the setup wizard with the development secret backend", async () => {
  await expect(page.getByTestId("surface-wizard")).toBeVisible();
  await expect(page.getByTestId("setup-welcome")).toBeVisible();
  await completeSetup(page);
  await expect(page.getByTestId("chat-empty-state")).toBeVisible();
  await expect(page.getByTestId("kernel-indicator")).toHaveCount(0);
});

test("uses OS-protected secret storage in production mode", async () => {
  test.skip(process.platform !== "darwin", "macOS safeStorage acceptance");
  const oldProfile = profileDirectory;
  const exit = waitForExit(application.process());
  await application.evaluate(({ app }) => app.quit());
  await expect(exit).resolves.toBe(0);
  rmSync(oldProfile, { recursive: true, force: true });

  profileDirectory = mkdtempSync(path.join(tmpdir(), "borg-e2e-os-"));
  launchEnvironment.BORG_SECRET_BACKEND = "borg.secrets.os";
  await launchBorg();

  await expect(page.getByTestId("setup-welcome")).toBeVisible();
  await page.getByTestId("setup-continue").click();
  await expect(page.getByTestId("os-secrets-step")).toBeVisible();
  await page.getByTestId("os-secret-save").click();
  await expect(page.getByTestId("toast")).toContainText(
    "Secure storage verified",
  );

  const userDataPath = await application.evaluate(() => {
    const api = (
      globalThis as typeof globalThis & {
        __borgTest?: { userDataPath(): string };
      }
    ).__borgTest;
    return api?.userDataPath() ?? "";
  });
  const exitAfterSave = waitForExit(application.process());
  await application.evaluate(({ app }) => app.quit());
  await expect(exitAfterSave).resolves.toBe(0);
  const encryptedVault = readFileSync(
    path.join(
      userDataPath,
      "plugins",
      "borg.secrets.os",
      "secrets.json",
    ),
    "utf8",
  );
  expect(encryptedVault).not.toMatch(
    /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i,
  );

  await launchBorg();
  await page.getByTestId("setup-continue").click();
  await expect(page.getByTestId("os-secret-status")).toContainText(
    "credential storage is ready",
  );
});

test("persists plugin config and wizard completion across a tray quit", async () => {
  await enterDeveloperTool("settings", "borg.hello.settings");
  await expect(page.getByTestId("hello-settings-page")).toBeVisible();
  await page.getByTestId("hello-message-input").fill("Persisted across restart");
  await page.getByTestId("hello-message-save").click();
  await expect(page.getByTestId("hello-message-status")).toContainText("Saved");

  const exit = waitForExit(application.process());
  await application.evaluate(({ app }) => app.quit());
  await expect(exit).resolves.toBe(0);

  await launchBorg();
  await enterDeveloperTool("widget", "borg.hello.kernel-status");
  await expect(page.getByTestId("hello-status-alive")).toContainText(
    "Persisted across restart",
  );
});

test("opens a recovery shell when durable config cannot start", async () => {
  const exit = waitForExit(application.process());
  const userDataPath = await application.evaluate(({ app }) => {
    const api = (
      globalThis as typeof globalThis & {
        __borgTest?: { userDataPath(): string };
      }
    ).__borgTest;
    const path = api?.userDataPath() ?? "";
    app.quit();
    return path;
  });
  expect(userDataPath).not.toBe("");

  await expect(exit).resolves.toBe(0);
  writeFileSync(
    path.join(
      userDataPath,
      "plugins",
      "borg.config.sqlite",
      "borg.sqlite3",
    ),
    "not a sqlite database",
  );

  await launchBorg();
  await expect(page.getByTestId("kernel-startup-error")).toBeVisible();
  await expect(page.getByTestId("kernel-startup-error")).toContainText(
    "Borg could not initialize",
  );
});

test("explicit quit terminates the tray-resident kernel", async () => {
  const exit = waitForExit(application.process());
  await application.evaluate(({ app }) => app.quit());
  await expect(exit).resolves.toBe(0);
});

test("renders workspace, settings, and wizard extension points", async () => {
  await enterLoopDebugger();

  await page.getByTestId("nav-settings").click();
  await page
    .getByTestId("settings-section-borg.secrets.dev.settings")
    .click();
  await expect(page.getByTestId("dev-secrets-step")).toBeVisible();

  await page.getByTestId("settings-run-setup").click();
  await expect(page.getByTestId("setup-welcome")).toBeVisible();
  await page.getByTestId("setup-continue").click();
  await expect(page.getByTestId("dev-secrets-step")).toBeVisible();
});

test("runs the scripted loop through tool approval accept and deny", async () => {
  await enterLoopDebugger();

  await page.getByTestId("run-approval-scenario").click();
  await expect(page.getByTestId("interaction-overlay")).toContainText(
    "Approve tools.echo",
  );
  await page.getByTestId("interaction-allow").click();
  await expect(page.getByTestId("interaction-overlay")).toBeHidden();
  await expect(page.getByTestId("loop-run-status")).toHaveText("completed");
  await expect(page.getByTestId("loop-output")).toContainText(
    "Echo completed: hello from the approved tool",
  );
  await expect(page.getByTestId("loop-run-result")).toContainText(
    "tokens · USD 0.002",
  );

  await page.getByTestId("run-approval-scenario").click();
  await expect(page.getByTestId("interaction-overlay")).toBeVisible();
  await page.getByTestId("interaction-deny").click();
  await expect(page.getByTestId("interaction-overlay")).toBeHidden();
  await expect(page.getByTestId("loop-run-status")).toHaveText("failed");
  await expect(page.getByTestId("loop-error")).toContainText("denied");
});

test("keeps safety approvals working when feedback is disabled", async () => {
  await enterLoopDebugger();
  const rendererReloaded = page.waitForEvent("load");
  await application.evaluate(async () => {
    const api = (
      globalThis as typeof globalThis & {
        __borgTest?: { disablePlugin(pluginId: string): Promise<void> };
      }
    ).__borgTest;
    await api?.disablePlugin("borg.feedback");
  });
  await rendererReloaded;
  await enterLoopDebugger();

  await page.getByTestId("run-feedback-scenario").click();
  await expect(page.getByTestId("loop-run-status")).toHaveText("failed");
  await expect(page.getByTestId("loop-error")).toContainText("unavailable");
  await expect(page.getByTestId("interaction-overlay")).toBeHidden();

  await page.getByTestId("run-approval-scenario").click();
  await expect(page.getByTestId("interaction-overlay")).toContainText(
    "Approve tools.echo",
  );
  await page.getByTestId("interaction-deny").click();
  await expect(page.getByTestId("loop-run-status")).toHaveText("failed");
});

test("keeps an ask-user interaction pending while the window is hidden", async () => {
  await ensureSetup();
  await page.getByTestId("chat-composer-input").fill("scenario:feedback");
  await page.getByTestId("chat-send").click();
  await expect(page.getByTestId("interaction-overlay")).toContainText(
    "Mock model question",
  );
  await expect(page.getByTestId("interaction-overlay")).toContainText(
    "What should the mock model do next?",
  );
  await expect(page.getByTestId("human-input-interaction")).toBeVisible();

  await application.evaluate(() => {
    const api = (
      globalThis as typeof globalThis & {
        __borgTest?: { hideWindow(): void };
      }
    ).__borgTest;
    api?.hideWindow();
  });
  await expect
    .poll(() =>
      application.evaluate(() => {
        const api = (
          globalThis as typeof globalThis & {
            __borgTest?: { isWindowVisible(): boolean };
          }
        ).__borgTest;
        return api?.isWindowVisible() ?? true;
      }),
    )
    .toBe(false);
  await expect
    .poll(() =>
      application.evaluate(() => {
        const api = (
          globalThis as typeof globalThis & {
            __borgTest?: { trayMenuLabels(): readonly string[] };
          }
        ).__borgTest;
        return api?.trayMenuLabels() ?? [];
      }),
    )
    .toContain("Pending interactions: 1");
  await expect
    .poll(() =>
      application.evaluate(() => {
        const api = (
          globalThis as typeof globalThis & {
            __borgTest?: { trayTitle(): string };
          }
        ).__borgTest;
        return api?.trayTitle() ?? "";
      }),
    )
    .toBe("1");

  await application.evaluate(() => {
    const api = (
      globalThis as typeof globalThis & {
        __borgTest?: { showWindow(): void };
      }
    ).__borgTest;
    api?.showWindow();
  });
  await expect
    .poll(() =>
      application.evaluate(() => {
        const api = (
          globalThis as typeof globalThis & {
            __borgTest?: { isWindowVisible(): boolean };
          }
        ).__borgTest;
        return api?.isWindowVisible() ?? false;
      }),
    )
    .toBe(true);
  await expect(page.getByTestId("human-input-interaction")).toBeVisible();
  await page.getByTestId("human-input-text").fill("continue safely");
  await page.getByTestId("human-input-submit").click();
  await expect(page.getByTestId("interaction-overlay")).toBeHidden();
  await expect(
    page.locator('[data-testid="chat-message"][data-role="assistant"]'),
  ).toContainText(
    "User answered: continue safely",
  );
  await expect
    .poll(() =>
      application.evaluate(() => {
        const api = (
          globalThis as typeof globalThis & {
            __borgTest?: { trayMenuLabels(): readonly string[] };
          }
        ).__borgTest;
        return api?.trayMenuLabels() ?? [];
      }),
    )
    .toContain("Pending interactions: 0");
  await expect
    .poll(() =>
      application.evaluate(() => {
        const api = (
          globalThis as typeof globalThis & {
            __borgTest?: { trayTitle(): string };
          }
        ).__borgTest;
        return api?.trayTitle() ?? "pending";
      }),
    )
    .toBe("");
});
