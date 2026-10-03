import { execFile } from "node:child_process";
import { createServer } from "node:https";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { _electron as electron, expect, type Page } from "@playwright/test";
import { afterEach, describe, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { addedReply, designerModelPreference, GEAR_QUESTION, startDesignerServer } from "./model-double.js";

const execFileAsync = promisify(execFile);
const azureModelPreference = "borg.azure:shop-designer";

const exampleDirectory = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(path.join(exampleDirectory, "package.json"));
const electronPath = require("electron") as string;

let application: Awaited<ReturnType<typeof electron.launch>> | undefined;
let designer: Awaited<ReturnType<typeof startDesignerServer>> | undefined;
let azure: Awaited<ReturnType<typeof startAzureCatalog>> | undefined;
let home: string | undefined;

afterEach(async () => {
  await application?.close();
  application = undefined;
  await designer?.close();
  designer = undefined;
  await azure?.close();
  azure = undefined;
  if (home) {
    await rm(home, { recursive: true, force: true });
    home = undefined;
  }
});

async function startAzureCatalog(): Promise<{ url: string; close(): Promise<void> }> {
  const directory = await mkdtemp(path.join(tmpdir(), "print-bench-azure-"));
  const keyPath = path.join(directory, "key.pem");
  const certPath = path.join(directory, "cert.pem");
  await execFileAsync("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-keyout",
    keyPath,
    "-out",
    certPath,
    "-days",
    "1",
    "-nodes",
    "-subj",
    "/CN=127.0.0.1",
  ]);
  const server = createServer(
    { key: await readFile(keyPath), cert: await readFile(certPath) },
    (request, response) => {
      if (request.url?.startsWith("/openai/v1/models")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "shop-designer" }] }));
        return;
      }
      response.writeHead(404);
      response.end();
    },
  );
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `https://127.0.0.1:${port}`,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      await rm(directory, { recursive: true, force: true });
    },
  };
}

async function chooseDesignerModel(page: Page, label: string, preference: string): Promise<void> {
  await expect(page.getByTestId("print-bench-model").locator("option", { hasText: label })).toHaveCount(1, {
    timeout: 20_000,
  });
  await page.getByRole("button", { name: "Designer model" }).click();
  const option = page.getByRole("option", { name: label, exact: true });
  await expect(option).toBeVisible();
  await page.waitForTimeout(800);
  await expect(option).toBeVisible();
  await option.click();
  await expect(page.getByTestId("print-bench-model")).toHaveValue(preference);
}

describe("print bench window", () => {
  it("builds any solid from the palette or a prompt", async () => {
    designer = await startDesignerServer();
    const azureCatalog = await startAzureCatalog();
    azure = azureCatalog;
    home = await mkdtemp(path.join(tmpdir(), "print-bench-ui-"));
    application = await electron.launch({
      executablePath: electronPath,
      cwd: exampleDirectory,
      args: [path.join(exampleDirectory, "dist/electron-main.js")],
      timeout: 60_000,
      env: {
        ...process.env,
        BORG_E2E: "1",
        BORG_OPENAI_ENDPOINT: designer.url,
        BORG_PRINT_BENCH_HOME: home,
        NODE_TLS_REJECT_UNAUTHORIZED: "0",
      },
    });
    const page = await application.firstWindow();
    page.on("pageerror", (error) => {
      console.error(error);
    });
    await expect(page.getByTestId("workspace-view-tab-print-bench.design")).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByTestId("workspace-view-tab-print-bench.quote")).toHaveCount(0);
    await expect(page.getByTestId("workspace-view-tab-print-bench.printer")).toHaveCount(0);
    await page.getByTestId("nav-flight-deck").click();
    await expect(page.getByTestId("surface-flightDeck")).toContainText("Flight deck");
    await expect(page.getByTestId("flightdeck-inspection")).toContainText("failed");
    await page.getByTestId("nav-settings").click();
    await expect(page.getByTestId("surface-settings")).toContainText("Machine");
    await expect(page.getByTestId("settings-page")).toContainText("Prusa MK4");
    await page.getByTestId("settings-section-model").click();
    await expect(page.getByTestId("openai-setup-step")).toBeVisible();
    await expect(page.getByTestId("anthropic-setup-step")).toBeVisible();
    await expect(page.getByTestId("azure-setup-step")).toBeVisible();
    await expect(page.getByTestId("copilot-setup-step")).toBeVisible();
    await expect(page.getByTestId("ollama-setup-step")).toBeVisible();
    await expect(page.getByTestId("openrouter-setup-step")).toBeVisible();
    await expect(page.getByTestId("settings-page")).not.toContainText("grok-4.7");
    await expect(page.getByTestId("settings-page")).not.toContainText("XAI_API_KEY");
    await page.getByTestId("openai-api-key").fill("sk-test");
    await page.getByTestId("openai-save-key").click();
    await page.getByTestId("openai-connect").click();
    await expect(page.getByTestId("openai-status")).toContainText("connected", { timeout: 20_000 });
    await expect
      .poll(async () => page.getByTestId("print-bench-model").locator("option").count(), { timeout: 20_000 })
      .toBeGreaterThan(1);
    await chooseDesignerModel(page, "OpenAI · GPT-5 Mini", designerModelPreference);
    await page.getByTestId("workspace-view-tab-print-bench.design").click();
    await expect(page.getByTestId("print-bench-designs")).toBeVisible();
    await expect(page.getByTestId("print-bench-design-title")).toHaveText("New design");

    const findings = page.getByTestId("print-bench-findings");
    await expect(findings).toContainText("Nothing");
    await expect(page.getByTestId("print-bench-palette")).toBeVisible();
    await expect(page.getByTestId("print-bench-prompt")).toBeVisible();
    const box = await page.getByTestId("print-bench-viewport").boundingBox();
    expect(box?.width ?? 0).toBeGreaterThan(100);

    await page.getByTestId("print-bench-tool-box").click();
    await expect(findings).not.toContainText("Nothing");
    await expect(page.getByTestId("print-bench-design-title")).toHaveText("New design");
    await page.getByTestId("print-bench-new-design").click();
    await expect(findings).toContainText("Nothing");
    await expect(page.getByTestId("print-bench-design-item")).toHaveCount(2);
    await page.getByRole("button", { name: "New design, 1 solid", exact: true }).click();
    await expect(findings).not.toContainText("Nothing");
    await page.getByRole("button", { name: "New design, Empty", exact: true }).click();
    await expect(findings).toContainText("Nothing");
    await page.getByTestId("print-bench-delete-design").click();
    await expect(page.getByTestId("print-bench-delete-confirm")).toBeVisible();
    await page.getByTestId("print-bench-delete-cancel").click();
    await expect(page.getByTestId("print-bench-delete-confirm")).toHaveCount(0);
    await page.getByTestId("print-bench-delete-design").click();
    await page.getByTestId("print-bench-delete-confirm-action").click();
    await expect(page.getByTestId("print-bench-design-item")).toHaveCount(1);
    await expect(findings).not.toContainText("Nothing");

    await page.getByTestId("print-bench-prompt").fill("a sphere");
    await page.getByTestId("print-bench-build").click();
    await expect(page.getByTestId("print-bench-question")).toContainText("radius", { timeout: 20_000 });
    await page.getByTestId("print-bench-prompt").fill("15");
    await page.getByTestId("print-bench-build").click();
    await expect(findings).toContainText("Overhang", { timeout: 20_000 });
    await page.getByTestId("print-bench-tool-delete").click();
    await expect(findings).not.toContainText("Overhang");
    await expect(page.getByTestId("settings-section-seats")).toHaveCount(0);
    await expect(page.getByTestId("print-bench-prompt")).toBeEnabled();
    await page.getByTestId("print-bench-prompt").fill("draw a gear");
    await page.getByTestId("print-bench-build").click();
    await expect(page.getByTestId("print-bench-question")).toContainText(GEAR_QUESTION, {
      timeout: 20_000,
    });
    await expect(page.getByTestId("print-bench-prompt")).toBeEnabled();
    await page.getByTestId("print-bench-prompt").fill("8 teeth, 40 mm");
    await page.getByTestId("print-bench-build").click();
    await expect(page.getByTestId("print-bench-transcript")).toContainText(addedReply("cylinder"), {
      timeout: 20_000,
    });
    await expect(page.getByTestId("print-bench-question")).toHaveCount(0);
    await expect(page.getByTestId("print-bench-choice-box")).toHaveCount(0);
    await expect(page.getByText("The bed is empty")).toHaveCount(0);

    await page.getByTestId("nav-settings").click();
    await page.getByTestId("settings-section-model").click();
    await page.getByTestId("azure-endpoint").fill(azureCatalog.url);
    await page.getByTestId("azure-save-settings").click();
    await expect(page.getByTestId("azure-status")).toContainText("Connect to load models");
    await page.getByTestId("azure-api-key").fill("test-key");
    await page.getByTestId("azure-save-key").click();
    await expect(page.getByTestId("azure-status")).toContainText("Verify it to enable Azure models");
    await page.getByTestId("azure-connect").click();
    await expect(page.getByTestId("azure-status")).toContainText("connected", { timeout: 20_000 });
    await expect
      .poll(async () => page.getByTestId("print-bench-model").locator("option").count(), { timeout: 20_000 })
      .toBeGreaterThan(4);
    await chooseDesignerModel(page, "Azure · shop-designer", azureModelPreference);
  }, 120_000);
});
