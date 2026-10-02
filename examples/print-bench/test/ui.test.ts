import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect } from "@playwright/test";
import { afterEach, describe, it } from "vitest";

const exampleDirectory = fileURLToPath(new URL("..", import.meta.url));
const require = createRequire(path.join(exampleDirectory, "package.json"));
const electronPath = require("electron") as string;

let application: Awaited<ReturnType<typeof electron.launch>> | undefined;

afterEach(async () => {
  await application?.close();
  application = undefined;
});

describe("print bench window", () => {
  it("builds any solid from the palette or a prompt, then gates quote and print", async () => {
    application = await electron.launch({
      executablePath: electronPath,
      cwd: exampleDirectory,
      args: [path.join(exampleDirectory, "dist/electron-main.js")],
      timeout: 60_000,
    });
    const page = await application.firstWindow();
    page.on("pageerror", (error) => {
      console.error(error);
    });
    await expect(page.getByTestId("workspace-view-tab-print-bench.design")).toBeVisible({
      timeout: 20_000,
    });
    await page.getByTestId("nav-flight-deck").click();
    await expect(page.getByTestId("surface-flightDeck")).toContainText("Flight deck");
    await expect(page.getByTestId("flightdeck-inspection")).toContainText("failed");
    await page.getByTestId("nav-settings").click();
    await expect(page.getByTestId("surface-settings")).toContainText("Machine");
    await expect(page.getByTestId("settings-page")).toContainText("Prusa MK4");
    await page.getByTestId("settings-section-model").click();
    await expect(page.getByTestId("settings-page")).toContainText("scripted");
    await page.getByTestId("workspace-view-tab-print-bench.design").click();

    const findings = page.getByTestId("print-bench-findings");
    await expect(findings).toContainText("Nothing");
    await expect(page.getByTestId("print-bench-palette")).toBeVisible();
    await expect(page.getByTestId("print-bench-prompt")).toBeVisible();
    await page.getByTestId("workspace-view-tab-print-bench.quote").click();
    await expect(page.getByTestId("print-bench-quote")).not.toContainText("USD");
    await page.getByTestId("workspace-view-tab-print-bench.design").click();
    const box = await page.getByTestId("print-bench-viewport").boundingBox();
    expect(box?.width ?? 0).toBeGreaterThan(100);

    await page.getByTestId("print-bench-tool-box").click();
    await page.getByTestId("workspace-view-tab-print-bench.quote").click();
    await expect(page.getByTestId("print-bench-quote")).toContainText("USD");
    await page.getByTestId("workspace-view-tab-print-bench.design").click();

    await page.getByTestId("print-bench-prompt").fill("a sphere");
    await page.getByTestId("print-bench-build").click();
    await expect(page.getByTestId("print-bench-question")).toContainText("radius", { timeout: 20_000 });
    await page.getByTestId("print-bench-prompt").fill("15");
    await page.getByTestId("print-bench-build").click();
    await expect(findings).toContainText("Overhang", { timeout: 20_000 });
    await page.getByTestId("workspace-view-tab-print-bench.quote").click();
    await expect(page.getByTestId("print-bench-quote")).not.toContainText("USD");
    await page.getByTestId("workspace-view-tab-print-bench.design").click();
    await page.getByTestId("print-bench-tool-delete").click();
    await page.getByTestId("workspace-view-tab-print-bench.quote").click();
    await expect(page.getByTestId("print-bench-quote")).toContainText("USD");

    await page.getByTestId("nav-settings").click();
    await page.getByTestId("settings-section-seats").click();
    await page.getByTestId("settings-page").getByRole("button", { name: "Designer" }).click();
    await page.getByRole("option", { name: "Front desk" }).click();
    await page.getByTestId("workspace-view-tab-print-bench.quote").click();
    await expect(page.getByTestId("print-bench-send")).toBeEnabled();
    await page.getByTestId("print-bench-send").click();
    await expect(page.getByTestId("print-bench-approval")).toContainText("classification");
    await page.getByTestId("print-bench-approval-allow").click();
    await expect(page.getByTestId("print-bench-sent")).toHaveText("Quote sent");

    await page.getByTestId("nav-settings").click();
    await page.getByTestId("settings-section-seats").click();
    await page.getByTestId("settings-page").getByRole("button", { name: "Front desk" }).click();
    await page.getByRole("option", { name: "Operator" }).click();
    await page.getByTestId("workspace-view-tab-print-bench.printer").click();
    await page.getByTestId("print-bench-start").click();
    await expect(page.getByTestId("print-bench-approval")).toContainText("tool_approval");
    await page.getByTestId("print-bench-approval-allow").click();
    await expect(page.getByTestId("print-bench-running")).toHaveText("Printer is running");

    await page.getByTestId("nav-settings").click();
    await page.getByTestId("settings-section-seats").click();
    await page.getByTestId("settings-page").getByRole("button", { name: "Operator" }).click();
    await page.getByRole("option", { name: "Designer" }).click();
    await page.getByTestId("workspace-view-tab-print-bench.quote").click();
    await expect(page.getByTestId("print-bench-send")).toBeDisabled();
    await page.getByTestId("workspace-view-tab-print-bench.printer").click();
    await expect(page.getByTestId("print-bench-start")).toBeDisabled();
  }, 60_000);
});
