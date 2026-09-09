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
import { completeSetup, expectTypingKeepsFocus } from "./setup";

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

async function openSettings(section: string): Promise<void> {
  await page.getByTestId("nav-settings").click();
  const item = page.getByTestId(`settings-section-${section}`);
  await item.scrollIntoViewIfNeeded();
  await item.click();
}

test.beforeEach(async () => {
  profileDirectory = mkdtempSync(path.join(tmpdir(), "borg-input-focus-"));
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

test("keeps focus while typing across chat, settings, and graphs", async () => {
  test.setTimeout(120_000);

  await test.step("chat composer", async () => {
    await expectTypingKeepsFocus(
      page.getByTestId("chat-composer-input"),
      "abc",
    );
  });

  await test.step("persona name", async () => {
    await openSettings("borg.chat.personas");
    await expect(page.getByTestId("persona-editor")).toBeVisible();
    await expectTypingKeepsFocus(page.getByTestId("persona-name"), "x");
  });

  await test.step("azure endpoint", async () => {
    await openSettings("borg.azure.settings");
    await expectTypingKeepsFocus(page.getByTestId("azure-endpoint"), "x");
  });

  await test.step("openai api key", async () => {
    await openSettings("borg.openai.settings");
    await expectTypingKeepsFocus(page.getByTestId("openai-api-key"), "sk");
  });

  await test.step("slack new account name", async () => {
    await openSettings("borg.channel.slack.settings");
    await page.getByTestId("slack-account-new").click();
    await expectTypingKeepsFocus(
      page.getByTestId("slack-new-account-name"),
      "ws",
    );
  });

  await test.step("mcp server command", async () => {
    await openSettings("borg.mcp.servers");
    await page.getByTestId("mcp-add-server").click();
    const command = page
      .getByTestId("mcp-server-row-server-1")
      .getByTestId("mcp-server-command");
    await expect(command).toHaveValue("node");
    await expectTypingKeepsFocus(command, "xyz");
  });

  await test.step("graph fields", async () => {
    await page.getByTestId("nav-chat").click();
    await page.getByTestId("workspace-view-tab-borg.graphs.designer").click();
    await expect(page.getByTestId("graph-designer")).toBeVisible();
    await page.getByTestId("graph-create").click();
    await expectTypingKeepsFocus(page.getByTestId("graph-name"), "Q");
    await page.getByTestId("graph-node-option-set-variable").click();
    await expectTypingKeepsFocus(
      page.getByTestId("graph-assignment-value-0"),
      "xyz",
    );
    await page.getByTestId("graph-node-option-end").click();
    await expectTypingKeepsFocus(
      page.locator('[data-testid="graph-node-fields"] input').first(),
      "x",
    );
    await page.locator("summary", { hasText: "Graph inputs" }).click();
    await page
      .getByTestId("graph-input-schema")
      .getByRole("button", { name: "Add field" })
      .click();
    await expectTypingKeepsFocus(
      page.getByTestId("graph-schema-field-name-0"),
      "q",
    );
  });
});
