import {
  createServer,
  type IncomingMessage,
  type Server,
} from "node:http";
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

let application: ElectronApplication | undefined;
let page: Page;
let profileDirectory: string;
let launchEnvironment: Record<string, string>;
let fixture: Server;
let fixturePort: number;
let capturedPosts: Record<string, unknown>[] = [];

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

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function startFixture(): Promise<void> {
  capturedPosts = [];
  fixture = createServer(async (request, response) => {
    if (request.method !== "POST") {
      response.writeHead(404);
      response.end();
      return;
    }
    const body = JSON.parse(await readBody(request)) as Record<string, unknown>;
    capturedPosts.push(body);
    if (body.api_key !== "tvly-e2e") {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        results: [
          {
            title: "Borg Search Hit",
            url: "https://example.com/hit",
            content: "external search snippet",
          },
        ],
      }),
    );
  });
  return new Promise((resolve) => {
    fixture.listen(0, "127.0.0.1", () => {
      const address = fixture.address();
      fixturePort = typeof address === "object" && address ? address.port : 0;
      resolve();
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

async function enableTavily(): Promise<void> {
  await page.getByTestId("nav-settings").click();
  await page.getByTestId("settings-section-borg.search.tavily.settings").click();
  await expect(page.getByTestId("tavily-setup-step")).toBeVisible();
  await page.getByTestId("tavily-api-key").fill("tvly-e2e");
  await page.getByTestId("tavily-save-key").click();
  await expect(page.getByTestId("tavily-api-key")).toHaveValue("");
  await page.getByTestId("tavily-connect").click();
  await expect(page.getByTestId("tavily-status")).toContainText("connected");
}

test.beforeEach(async () => {
  profileDirectory = mkdtempSync(path.join(tmpdir(), "borg-slice-12-"));
  await startFixture();
  launchEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[0] !== "ELECTRON_RUN_AS_NODE" && entry[1] !== undefined,
    ),
  );
  launchEnvironment.BORG_E2E = "1";
  launchEnvironment.BORG_TAVILY_ENDPOINT = `http://127.0.0.1:${fixturePort}/search`;
  launchEnvironment.ELECTRON_DISABLE_SECURITY_WARNINGS = "true";
  await launchBorg();
  await completeSetup(page);
});

test.afterEach(async () => {
  const currentApplication = application;
  if (currentApplication) {
    const process = currentApplication.process();
    if (process.exitCode === null) {
      const exit = waitForExit(process);
      process.kill();
      await exit;
    }
  }
  await new Promise<void>((resolve, reject) => {
    fixture.close((error) => (error ? reject(error) : resolve()));
  });
  rmSync(profileDirectory, { recursive: true, force: true });
});

test("enables Tavily in settings then completes a search tool call", async () => {
  await enableTavily();

  await page.getByTestId("nav-chat").click();
  await page.getByTestId("chat-composer-input").fill("scenario:search");
  await page.getByTestId("chat-send").click();
  const overlay = page.getByTestId("interaction-overlay");
  await expect(overlay).toBeVisible();
  await expect(overlay).toContainText("tavily.search");
  await page.getByTestId("interaction-allow").click();
  await expect(
    page
      .locator('[data-testid="chat-message"][data-role="assistant"]')
      .filter({ hasText: "Search found: Borg Search Hit" }),
  ).toBeVisible();
  expect(capturedPosts.length).toBeGreaterThanOrEqual(1);
  expect(capturedPosts[0]).toEqual(
    expect.objectContaining({
      query: "borg slice 12",
      api_key: "tvly-e2e",
    }),
  );
});
