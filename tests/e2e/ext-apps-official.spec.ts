import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
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
const publishedRoot = process.env.EXT_APPS_PUBLISHED;
const electronPath = require(
  require.resolve("electron", { paths: [desktopApp] }),
) as string;

const SERVERS = [
  {
    id: "vanilla",
    dir: "server-basic-vanillajs",
    port: 4101,
    tool: "mcp.vanilla.get-time",
  },
  {
    id: "map",
    dir: "server-map",
    port: 4102,
    tool: "mcp.map.show-map",
  },
] as const;

let application: ElectronApplication | undefined;
let page: Page;
let profileDirectory: string | undefined;
const children: ChildProcess[] = [];

function waitForExit(child: ChildProcess, timeoutMs = 10_000): Promise<void> {
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

async function waitForListen(child: ChildProcess): Promise<void> {
  let output = "";
  const onData = (chunk: Buffer): void => {
    output += chunk.toString();
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  const started = Date.now();
  while (Date.now() - started < 10_000) {
    if (/listening on http:\/\//.test(output)) {
      return;
    }
    if (child.exitCode !== null) {
      throw new Error(`example server exited: ${output}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`example server did not listen: ${output}`);
}

async function sendMessage(text: string): Promise<void> {
  await page.getByTestId("chat-composer-input").fill(text);
  await page.getByTestId("chat-send").click();
}

async function addHttpServer(id: string, url: string): Promise<void> {
  await page.getByTestId("mcp-add-server").click();
  const draft = page.getByTestId(`mcp-server-row-server-${id === "vanilla" ? "1" : id === "map" ? "2" : "3"}`);
  await draft.getByTestId("mcp-server-id").fill(id);
  const row = page.getByTestId(`mcp-server-row-${id}`);
  await row.getByTestId("mcp-server-transport").selectOption("streamable-http");
  await row.getByTestId("mcp-server-url").fill(url);
  await row.getByTestId("mcp-save-server").click();
  await page.getByTestId("mcp-refresh").click();
  await expect(row.getByTestId("mcp-server-status")).toHaveText("ready", {
    timeout: 15_000,
  });
}

test.skip(
  !publishedRoot ||
    !existsSync(path.join(publishedRoot, "server-map", "package", "dist", "index.js")),
  "Set EXT_APPS_PUBLISHED to a directory of official ext-apps example builds",
);

test.beforeAll(async () => {
  for (const server of SERVERS) {
    const entry = path.join(
      publishedRoot,
      server.dir,
      "package",
      "dist",
      "index.js",
    );
    const child = spawn(process.execPath, [entry], {
      cwd: path.dirname(entry),
      env: { ...process.env, PORT: String(server.port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    await waitForListen(child);
  }
});

test.afterAll(() => {
  for (const child of children) {
    child.kill("SIGTERM");
  }
});

test.beforeEach(async () => {
  profileDirectory = mkdtempSync(path.join(tmpdir(), "borg-ext-apps-"));
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

test("renders official vanilla and map MCP Apps", async () => {
  test.setTimeout(90_000);
  await page.getByTestId("nav-settings").click();
  await page.getByTestId("settings-section-borg.mcp.servers").click();
  await expect(page.getByTestId("mcp-settings-page")).toBeVisible();
  await addHttpServer("vanilla", "http://127.0.0.1:4101/mcp");
  await addHttpServer("map", "http://127.0.0.1:4102/mcp");

  await page.getByTestId("nav-chat").click();

  await sendMessage("scenario:mcp-ext-vanilla");
  await expect(page.getByTestId("interaction-overlay")).toContainText(
    "mcp.vanilla.get-time",
  );
  await page.getByTestId("interaction-allow").click();
  await expect(page.getByTestId("mcp-app")).toBeVisible();
  const vanilla = page
    .frameLocator('[data-testid="mcp-app-frame"]')
    .frameLocator("#app");
  await expect(vanilla.locator("body")).toBeVisible();

  await sendMessage("scenario:mcp-ext-map");
  await expect(page.getByTestId("interaction-overlay")).toContainText(
    "mcp.map.show-map",
  );
  await page.getByTestId("interaction-allow").click();
  const failed: string[] = [];
  page.on("requestfailed", (request) => {
    failed.push(`${request.failure()?.errorText ?? "failed"} ${request.url()}`);
  });
  const mapApp = page
    .locator('[data-testid="mcp-app"]')
    .last()
    .frameLocator('[data-testid="mcp-app-frame"]')
    .frameLocator("#app");
  await expect(mapApp.locator("#cesiumContainer")).toBeVisible({
    timeout: 20_000,
  });
  await expect(mapApp.locator("#loading")).not.toHaveText(
    /Failed to load CesiumJS from CDN/,
    { timeout: 20_000 },
  );
  expect(
    failed.filter((entry) => entry.startsWith("csp https://cesium.com")),
  ).toEqual([]);
});
