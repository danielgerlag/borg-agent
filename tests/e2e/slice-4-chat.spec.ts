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

async function sendMessage(text: string): Promise<void> {
  await page.getByTestId("chat-composer-input").fill(text);
  await page.getByTestId("chat-send").click();
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

test.beforeEach(async () => {
  profileDirectory = mkdtempSync(path.join(tmpdir(), "borg-slice-4-"));
  launchEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[0] !== "ELECTRON_RUN_AS_NODE" && entry[1] !== undefined,
    ),
  );
  launchEnvironment.BORG_E2E = "1";
  launchEnvironment.ELECTRON_DISABLE_SECURITY_WARNINGS = "true";
  await launchBorg();
  await completeSetup(page);
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
  await expect(page.getByTestId("chat-empty-state")).toBeVisible();
  await expect(page.getByTestId("chat-session-list")).toContainText(
    "No saved chats yet",
  );
  await page.getByTestId("chat-prompt-suggestion").first().click();
  await expect(page.getByTestId("chat-composer-input")).toHaveValue(
    "Help me plan a new feature",
  );
  await page.getByTestId("chat-composer-input").fill("Hello from Slice 4");
  await sendMessage("Hello from Slice 4");
  await expect(page.getByTestId("chat-streaming-message")).toBeVisible();
  await expect(
    page.locator('[data-testid="chat-message"][data-role="user"]'),
  ).toContainText("Hello from Slice 4");
  await expect(
    page.locator('[data-testid="chat-message"][data-role="assistant"]'),
  ).toContainText("Mock reply: Hello from Slice 4");
  await expect(page.getByTestId("chat-session-status")).toHaveText("Ready");
  await expect(
    page.locator('[data-testid^="chat-session-item-"]'),
  ).toHaveCount(1);
});

test("approves a filesystem tool and shows its workspace file", async () => {
  await sendMessage("scenario:file");
  await expect(page.getByTestId("interaction-overlay")).toBeVisible();
  await expect(page.getByTestId("interaction-overlay")).toContainText(
    "filesystem.write",
  );
  await page.getByTestId("interaction-allow").click();

  await page.getByTestId("chat-workspace-toggle").click();
  const file = page.locator(
    '[data-testid="chat-workspace-file"][data-path="notes/hello.txt"]',
  );
  await expect(file).toBeVisible();
  await expect(
    page.locator('[data-testid="chat-message"][data-role="assistant"]'),
  ).toContainText("File created: notes/hello.txt");
});

test("denies a filesystem tool without creating a file", async () => {
  await sendMessage("scenario:file");
  await expect(page.getByTestId("interaction-overlay")).toBeVisible();
  await page.getByTestId("interaction-deny").click();
  await expect(page.getByTestId("chat-session-status")).toHaveText("Error");
  await expect(
    page.locator('[data-testid="chat-message"][data-role="event"]'),
  ).toContainText("denied");
  await page.getByTestId("chat-workspace-toggle").click();
  await expect(
    page.locator(
      '[data-testid="chat-workspace-file"][data-path="notes/hello.txt"]',
    ),
  ).toHaveCount(0);
});

test("keeps new chats ephemeral and confirms deletion", async () => {
  await expect(
    page.locator('[data-testid^="chat-session-item-"]'),
  ).toHaveCount(0);
  await page.getByTestId("chat-new-session").click();
  await expect(
    page.locator('[data-testid^="chat-session-item-"]'),
  ).toHaveCount(0);

  await sendMessage("A chat worth keeping");
  await expect(
    page.locator('[data-testid="chat-message"][data-role="assistant"]'),
  ).toContainText("Mock reply: A chat worth keeping");
  await expect(
    page.locator('[data-testid^="chat-session-item-"]'),
  ).toHaveCount(1);

  await page.getByTestId("chat-delete-session").click();
  await expect(page.getByTestId("chat-delete-confirm")).toContainText(
    "A chat worth keeping",
  );
  await expect(page.getByTestId("chat-delete-confirm")).toHaveAttribute(
    "role",
    "alertdialog",
  );
  await expect(page.getByTestId("chat-delete-cancel")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("chat-delete-confirm")).toBeHidden();
  await expect(page.getByTestId("chat-delete-session")).toBeFocused();
  await page.getByTestId("chat-delete-session").click();
  await page.getByTestId("chat-delete-confirm-action").click();
  await expect(page.getByTestId("chat-session-list")).toContainText(
    "No saved chats yet",
  );
  await expect(page.getByTestId("chat-empty-state")).toBeVisible();
});

test("keeps a chat turn running while the window is hidden", async () => {
  await sendMessage("scenario:background");
  await expect(page.getByTestId("chat-session-status")).toHaveText("Thinking");
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
    .toContain("Running tasks: 0");
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
  await expect(page.getByTestId("chat-session-status")).toHaveText("Ready");
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
  await expect(page.getByTestId("chat-session-status")).toHaveText("Ready");
});

test("creates an assistant and uses it for new chats", async () => {
  await page.getByTestId("nav-settings").click();
  await page.getByTestId("settings-section-borg.chat.personas").click();
  await expect(page.getByTestId("wizard-persona-step")).toBeVisible();
  await page.getByText("Create a custom assistant").click();
  await page.getByTestId("settings-persona-name").fill("Code reviewer");
  await page
    .getByTestId("settings-persona-instructions")
    .fill("Review code carefully.");
  await page.getByTestId("settings-persona-create").click();
  await expect(page.getByTestId("wizard-persona-select")).toHaveValue(
    "user/code-reviewer",
  );
  await page.getByTestId("nav-chat").click();
  await page.getByTestId("chat-new-session").click();
  await expect(page.getByTestId("chat-session-persona")).toHaveText(
    "Talking with Code reviewer",
  );
});

test("delegates work to a child chat through the same pipeline", async () => {
  await sendMessage("Create a parent chat");
  await expect(
    page.locator('[data-testid="chat-message"][data-role="assistant"]'),
  ).toContainText("Mock reply: Create a parent chat");
  await page.getByTestId("chat-advanced-conversation").click();
  await page.getByTestId("chat-subagent-task").fill("summarize this task");
  await page.getByTestId("chat-spawn-subagent").click();
  await expect(page.getByTestId("chat-session-status")).toHaveText("Ready");
  await expect(
    page.locator('[data-testid="chat-message"][data-role="assistant"]'),
  ).toContainText("Mock reply: summarize this task");
  await expect(page.getByTestId("chat-session-list")).toContainText(
    "Child chat",
  );
});

test("shows running chats in Activity", async () => {
  await sendMessage("scenario:background");
  await expect(page.getByTestId("chat-session-status")).toHaveText("Thinking");
  await page.getByTestId("nav-activity").click();
  await expect(page.getByTestId("flightdeck-active-session-count")).toHaveText(
    "1",
  );
  await expect(page.getByTestId("flightdeck-active-session-count")).toHaveText(
    "0",
  );
  await expect(page.getByTestId("plugin-ui-error")).toHaveCount(0);
});

test("restores conversation history after restarting Borg", async () => {
  await sendMessage("Remember this conversation");
  await expect(
    page.locator('[data-testid="chat-message"][data-role="assistant"]'),
  ).toContainText("Mock reply: Remember this conversation");

  const exit = waitForExit(application.process(), 8_000);
  await application.evaluate(({ app }) => app.quit());
  await exit;

  await launchBorg();
  await expect(page.getByTestId("chat-workspace")).toBeVisible();
  await expect(
    page.locator('[data-testid="chat-message"][data-role="user"]'),
  ).toContainText("Remember this conversation");
  await expect(
    page.locator('[data-testid="chat-message"][data-role="assistant"]'),
  ).toContainText("Mock reply: Remember this conversation");
});
