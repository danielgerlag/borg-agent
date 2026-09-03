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
import type { ChildProcess } from "node:child_process";

const projectRoot = path.resolve(__dirname, "../..");
const desktopApp = path.join(projectRoot, "apps/desktop");
const electronPath = require(
  require.resolve("electron", { paths: [desktopApp] }),
) as string;

let application: ElectronApplication;
let page: Page;
let profileDirectory: string;

function waitForExit(child: ChildProcess, timeoutMs = 3_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Electron cleanup timed out")),
      timeoutMs,
    );
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function completeSetup(): Promise<void> {
  await expect(page.getByTestId("surface-wizard")).toBeVisible();
  await page.getByTestId("dev-secret-input").fill("slice-four-secret");
  await page.getByTestId("dev-secret-save").click();
  await expect(page.getByTestId("dev-secret-status")).toContainText(
    "Secret backend verified",
  );
  await expect(page.getByTestId("wizard-persona-step")).toBeVisible();
  await expect(page.getByTestId("setup-complete")).toBeEnabled();
  await page.getByTestId("setup-complete").click();
  await expect(page.getByTestId("chat-workspace")).toBeVisible();
  await expect(page.getByTestId("chat-session-status")).toHaveText("idle");
}

async function sendMessage(text: string): Promise<void> {
  await page.getByTestId("chat-composer-input").fill(text);
  await page.getByTestId("chat-send").click();
}

test.beforeEach(async () => {
  profileDirectory = mkdtempSync(path.join(tmpdir(), "borg-slice-4-"));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[0] !== "ELECTRON_RUN_AS_NODE" && entry[1] !== undefined,
    ),
  );
  env.BORG_E2E = "1";
  env.ELECTRON_DISABLE_SECURITY_WARNINGS = "true";
  application = await electron.launch({
    executablePath: electronPath,
    args: [desktopApp, `--user-data-dir=${profileDirectory}`],
    env,
  });
  page = await application.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await completeSetup();
});

test.afterEach(async () => {
  try {
    const process = application.process();
    if (process.exitCode === null) {
      const exit = waitForExit(process);
      process.kill();
      await exit;
    }
  } catch {
    // The application may already have exited after an assertion failure.
  }
  rmSync(profileDirectory, { recursive: true, force: true });
});

test("sends a chat message through the persona-backed mock loop", async () => {
  await sendMessage("Hello from Slice 4");
  await expect(page.getByTestId("chat-streaming-message")).toBeVisible();
  await expect(
    page.locator('[data-testid="chat-message"][data-role="user"]'),
  ).toContainText("Hello from Slice 4");
  await expect(
    page.locator('[data-testid="chat-message"][data-role="assistant"]'),
  ).toContainText("Mock reply: Hello from Slice 4");
  await expect(page.getByTestId("chat-session-status")).toHaveText("idle");
});

test("approves a filesystem tool and shows its workspace file", async () => {
  await sendMessage("scenario:file");
  await expect(page.getByTestId("interaction-overlay")).toBeVisible();
  await expect(page.getByTestId("interaction-overlay")).toContainText(
    "filesystem.write",
  );
  await page.getByTestId("interaction-allow").click();

  const file = page.locator(
    '[data-testid="chat-workspace-file"][data-path="notes/hello.txt"]',
  );
  await expect(file).toBeVisible();
  await expect(
    page.locator('[data-testid="chat-message"][data-role="assistant"]'),
  ).toContainText("File created: notes/hello.txt");
});

test("keeps a chat turn running while the window is hidden", async () => {
  await sendMessage("scenario:background");
  await expect(page.getByTestId("chat-session-status")).toHaveText("running");
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
    .toContain("Running — loops 0 · bots 0 · graphs 0");
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

  await expect(
    page.locator('[data-testid="chat-message"][data-role="assistant"]'),
  ).toContainText("Background turn completed while Borg was hidden.");
  await expect(page.getByTestId("chat-session-status")).toHaveText("idle");
});

test("answers feedback in the shared interaction UI and finishes in thread", async () => {
  await sendMessage("scenario:feedback");
  await expect(page.getByTestId("human-input-interaction")).toBeVisible();
  await expect(page.getByTestId("interaction-overlay")).toContainText(
    "What should the mock model do next?",
  );
  await page.getByTestId("human-input-text").fill("continue in chat");
  await page.getByTestId("human-input-submit").click();

  await expect(page.getByTestId("interaction-overlay")).toBeHidden();
  await expect(
    page
      .locator('[data-testid="chat-message"][data-role="event"]')
      .filter({ hasText: "Input request answered." }),
  ).toBeVisible();
  await expect(
    page.locator('[data-testid="chat-message"][data-role="assistant"]'),
  ).toContainText("User answered: continue in chat");
  await expect(page.getByTestId("chat-session-status")).toHaveText("idle");
});

test("creates a persona and selects it for new sessions", async () => {
  await page.getByTestId("nav-settings").click();
  await expect(page.getByTestId("wizard-persona-step")).toBeVisible();
  await page.getByText("Create a persona").click();
  await page.getByTestId("settings-persona-name").fill("Code reviewer");
  await page
    .getByTestId("settings-persona-instructions")
    .fill("Review code carefully.");
  await page.getByTestId("settings-persona-create").click();
  await expect(page.getByTestId("wizard-persona-select")).toHaveValue(
    "user/code-reviewer",
  );
  await page.getByTestId("nav-workspace").click();
  await page.getByTestId("chat-new-session").click();
  await expect(page.getByTestId("chat-session-persona")).toHaveText(
    "user/code-reviewer",
  );
});

test("spawns a child session through the same chat pipeline", async () => {
  await page.getByTestId("chat-subagent-task").fill("summarize this task");
  await page.getByTestId("chat-spawn-subagent").click();
  await expect(page.getByTestId("chat-session-status")).toHaveText("idle");
  await expect(
    page.locator('[data-testid="chat-message"][data-role="assistant"]'),
  ).toContainText("Mock reply: summarize this task");
  await expect(page.getByTestId("chat-session-list")).toContainText(
    "sub-agent",
  );
});

test("projects running chat sessions into the Flight Deck", async () => {
  await sendMessage("scenario:background");
  await expect(page.getByTestId("chat-session-status")).toHaveText("running");
  await page.getByTestId("nav-flightDeck").click();
  await expect(page.getByTestId("flightdeck-active-session-count")).toHaveText(
    "1",
  );
  await expect(page.getByTestId("flightdeck-active-session-count")).toHaveText(
    "0",
  );
  await expect(page.getByTestId("plugin-ui-error")).toHaveCount(0);
});
