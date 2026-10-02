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
  it("repairs the bracket from the bench and gates quote and print", async () => {
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
    await expect(page.getByTestId("print-bench-tools")).toContainText("example.print-bench.ask");
    await expect(page.getByTestId("print-bench-tools")).toContainText("Propose a revision");
    const findings = page.getByTestId("print-bench-findings");
    await expect(findings).toContainText("Wall", { timeout: 20_000 });
    await expect(findings).toContainText("Overhang");
    await expect(page.getByTestId("print-bench-quote")).not.toContainText("USD");
    const box = await page.getByTestId("print-bench-viewport").boundingBox();
    expect(box?.width ?? 0).toBeGreaterThan(100);

    await page.getByTestId("print-bench-wall").fill("1.6");
    await expect(findings).not.toContainText("Wall");
    await expect(findings).toContainText("Overhang");
    await expect(page.getByTestId("print-bench-quote")).not.toContainText("USD");

    await page.getByTestId("print-bench-ask").click();
    await expect(page.getByTestId("print-bench-proposal")).toContainText("chamfer 30");
    await page.getByTestId("print-bench-accept").click();
    await expect(page.getByTestId("print-bench-quote")).toContainText("USD");

    await page.getByRole("button", { name: "Seat" }).click();
    await page.getByRole("option", { name: "Front desk" }).click();
    await expect(page.getByTestId("print-bench-send")).toBeEnabled();
    await page.getByTestId("print-bench-send").click();
    await expect(page.getByTestId("print-bench-approval")).toContainText("classification");
    await page.getByTestId("print-bench-approval-allow").click();
    await expect(page.getByTestId("print-bench-sent")).toHaveText("Quote sent");

    await page.getByRole("button", { name: "Seat" }).click();
    await page.getByRole("option", { name: "Operator" }).click();
    await page.getByTestId("print-bench-start").click();
    await expect(page.getByTestId("print-bench-approval")).toContainText("tool_approval");
    await page.getByTestId("print-bench-approval-allow").click();
    await expect(page.getByTestId("print-bench-running")).toHaveText("Printer is running");

    await page.getByRole("button", { name: "Seat" }).click();
    await page.getByRole("option", { name: "Designer" }).click();
    await expect(page.getByTestId("print-bench-send")).toBeDisabled();
    await expect(page.getByTestId("print-bench-start")).toBeDisabled();
  }, 60_000);
});
