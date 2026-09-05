import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
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
const fixtureServer = path.join(
  projectRoot,
  "tests/fixtures/mock-mcp-server.mjs",
);
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

async function sendMessage(text: string): Promise<void> {
  await page.getByTestId("chat-composer-input").fill(text);
  await page.getByTestId("chat-send").click();
}

test.beforeEach(async () => {
  profileDirectory = mkdtempSync(path.join(tmpdir(), "borg-slice-8-"));
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

test("discovers MCP tools and completes an MCP App tool round trip", async () => {
  await page.getByTestId("nav-settings").click();
  await page.getByTestId("settings-section-borg.mcp.servers").click();
  await expect(page.getByTestId("mcp-settings-page")).toBeVisible();
  await page.getByTestId("mcp-add-server").click();
  const server = page.getByTestId("mcp-server-row-server-1");
  await server.getByTestId("mcp-server-id").fill("mock");
  const draft = page.getByTestId("mcp-server-row-mock");
  await draft.getByTestId("mcp-server-command").fill(process.execPath);
  await draft.getByTestId("mcp-server-arguments").fill(fixtureServer);
  await draft.getByTestId("mcp-save-server").click();
  await expect(draft).toBeVisible();
  await page.getByTestId("mcp-refresh").click();
  const savedServer = page.getByTestId("mcp-server-row-mock");
  await expect(savedServer.getByTestId("mcp-server-status")).toHaveText(
    "ready",
  );
  await expect(savedServer.getByTestId("mcp-tool-count")).toHaveText("2 tools");
  await expect(savedServer.getByTestId("mcp-catalog")).toContainText(
    "mcp.mock.echo",
  );
  await expect(savedServer.getByTestId("mcp-catalog")).toContainText(
    "mcp.mock.show-form",
  );

  await page.getByTestId("nav-chat").click();
  await sendMessage("scenario:mcp");
  await expect(page.getByTestId("interaction-overlay")).toContainText(
    "mcp.mock.echo",
  );
  await page.getByTestId("interaction-allow").click();
  const echoActivity = page
    .locator('[data-testid="chat-message"][data-role="tool"]')
    .filter({ hasText: "Used mcp.mock.echo" });
  await expect(echoActivity).toBeVisible();
  await echoActivity.locator("summary").click();
  await expect(echoActivity.locator("p")).toContainText(
    '"echoed":"hello from mcp"',
  );
  await expect(
    page.locator('[data-testid="chat-message"][data-role="assistant"]').last(),
  ).toContainText("MCP echo: hello from mcp");

  await sendMessage("scenario:mcp-app");
  await expect(page.getByTestId("interaction-overlay")).toContainText(
    "mcp.mock.show-form",
  );
  await page.getByTestId("interaction-allow").click();
  await expect(
    page.locator('[data-testid="chat-message"][data-role="assistant"]').last(),
  ).toContainText("MCP App: mock");
  await expect(page.getByTestId("chat-embedded-content")).toBeVisible();
  const app = page
    .frameLocator('[data-testid="mcp-app-frame"]')
    .frameLocator("#app");
  await expect(app.getByTestId("mcp-app-state")).toHaveText("tool-result");
  await app.getByTestId("mcp-app-submit").click();
  await expect(page.getByTestId("interaction-overlay")).toContainText(
    "mcp.mock.app-only",
  );
  await page.getByTestId("interaction-allow").click();
  await expect(app.getByTestId("mcp-app-state")).toHaveText("app-only:true");

  let observedRequest: (() => void) | undefined;
  const requested = new Promise<boolean>((resolve) => {
    observedRequest = () => resolve(true);
  });
  const probe = createServer((_request, response) => {
    observedRequest?.();
    response.end("unexpected");
  });
  await new Promise<void>((resolve) => {
    probe.listen(0, "127.0.0.1", resolve);
  });
  try {
    const address = probe.address();
    if (!address || typeof address === "string") {
      throw new Error("Navigation probe has no address");
    }
    const escaped = `data:text/html,${encodeURIComponent(
      `<img src="http://127.0.0.1:${address.port}/escape">`,
    )}`;
    await app.locator("body").evaluate((_body, url) => {
      globalThis.location.href = url;
    }, escaped);
    const reachedServer = await Promise.race([
      requested,
      new Promise<boolean>((resolve) => {
        setTimeout(() => resolve(false), 500);
      }),
    ]);
    expect(reachedServer).toBe(false);
  } finally {
    await new Promise<void>((resolve, reject) => {
      probe.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }
});
